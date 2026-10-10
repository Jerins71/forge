import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { retryDelayMs } from '@forge/client-runtime'
import type {
  ManagedHostAddInput,
  ManagedHostError,
  ManagedHostRecord,
  ManagedHostResult,
  ManagedHostStatus,
} from '@forge/protocol'
import type { EnvironmentDescriptor } from '@forge/protocol/environment-v2'
import type { createEnvironmentCredentialService } from './environment-credentials-ipc.js'
import { createOpenSshDriver, shellQuote as q } from './managed-hosts-ssh.js'
import { assertManagedHostIdle } from './managed-hosts-idle.js'
export interface ManagedServerArtifact {
  version: string
  sha256: string
  source: string
}
export interface ManagedTunnel {
  baseUrl: string
  exited: Promise<void>
  close(): void | Promise<void>
}
export interface ManagedHostDriver {
  dispose?(): Promise<void>
  run(
    hostAlias: string,
    script: string,
    options?: {
      timeoutMs?: number
      maxBytes?: number
    },
  ): Promise<string>
  upload(
    hostAlias: string,
    localFile: string,
    remoteFile: string,
  ): Promise<void>
  tunnel(hostAlias: string, remotePort: number): Promise<ManagedTunnel>
}
class HostFailure extends Error {
  constructor(
    readonly code: ManagedHostError['code'],
    message: string,
    readonly retryable = false,
  ) {
    super(message)
  }
}
function fail(code: ManagedHostError['code'], message: string): never {
  throw new HostFailure(code, message)
}
function failure(error: unknown): ManagedHostError {
  if (error instanceof HostFailure)
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    }
  const text = error instanceof Error ? error.message : ''
  if (/host key/i.test(text))
    return {
      code: 'HOST_KEY',
      message:
        'OpenSSH rejected the host key. Verify the host alias in known_hosts before connecting.',
      retryable: false,
    }
  if (/FORGE_(LINGER|PLATFORM|GLIBC|TOOLS|USER_MANAGER)/.test(text))
    return {
      code: 'PREREQUISITE',
      message: /LINGER/.test(text)
        ? 'User lingering is disabled. Ask the host administrator to enable loginctl enable-linger for this account before unattended launch.'
        : 'Host needs Linux x86_64, glibc 2.36+, Git, tar, sha256sum, flock, and a working systemd user manager.',
      retryable: false,
    }
  if (/FORGE_UNMANAGED/.test(text))
    return {
      code: 'UNMANAGED',
      message:
        'This directory or service belongs to an unmanaged installation or another Desktop. Choose a separate install and service.',
      retryable: false,
    }
  if (/FORGE_BUSY|busy or unknown/.test(text))
    return {
      code: 'BUSY_OR_UNKNOWN',
      message:
        'The host is busy or its state is unknown. Stop active sessions, settle commands and close terminals before trying again.',
      retryable: false,
    }
  if (/FORGE_ARTIFACT/.test(text))
    return {
      code: 'ARTIFACT',
      message: 'Server archive or installed version failed verification.',
      retryable: false,
    }
  if (/FORGE_PORT/.test(text))
    return {
      code: 'UNAVAILABLE',
      message:
        'The remote loopback port is already in use. Choose a separate port.',
      retryable: false,
    }
  return {
    code: 'SSH',
    message:
      'SSH setup could not complete. Check the alias, existing keys/agent and host prerequisites, then Repair.',
    retryable: true,
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function validateAlias(alias: unknown): asserts alias is string {
  if (
    typeof alias !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(alias)
  )
    fail(
      'INVALID_INPUT',
      'Use an OpenSSH host alias without options, spaces or shell syntax.',
    )
}
function validateRecord(record: ManagedHostRecord) {
  validateAlias(record.hostAlias)
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(record.serviceName) ||
    !/^\/[A-Za-z0-9_./-]+$/.test(record.installDir) ||
    record.installDir.split('/').includes('..') ||
    record.installDir === '/' ||
    !Number.isSafeInteger(record.remotePort) ||
    record.remotePort < 1024 ||
    record.remotePort > 65535 ||
    (record.environmentId !== null && !uuid.test(record.environmentId)) ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(record.installedVersion) ||
    !/^[a-f0-9]{64}$/.test(record.artifactSha256)
  )
    fail('INVALID_INPUT', 'Invalid managed installation metadata.')
}
function unitQuote(text: string): string {
  return JSON.stringify(text.replaceAll('%', '%%'))
}
const shellHeader = `set -eu\numask 077\nfail() { printf 'FORGE_%s\\n' "$1" >&2; exit 1; }\n`
function installationOwner(record: ManagedHostRecord, owner: string): string {
  return `${owner}\n${record.serviceName}\n${record.remotePort}`
}
function remoteOwned(record: ManagedHostRecord, owner: string): string {
  return `${shellHeader}root=${q(record.installDir)}\nunit="$HOME/.config/systemd/user/${record.serviceName}.service"\ntest ! -L "$root" && test -f "$root/.forge-managed-owner" && test "$(cat "$root/.forge-managed-owner")" = ${q(installationOwner(record, owner))} || fail UNMANAGED\nexec 9>"$root/.setup.lock"\nflock -n 9 || fail BUSY\nif test -e "$unit"; then test ! -L "$unit" && test "$(head -n 1 "$unit")" = ${q('# Forge managed: ' + owner)} || fail UNMANAGED; fi\n`
}
function serviceUnit(
  record: ManagedHostRecord,
  owner: string,
  clientOrigin: string,
): string {
  const version = posix.join(
    record.installDir,
    'versions',
    `forge-server-${record.installedVersion}-linux-x64`,
  )
  return `# Forge managed: ${owner}\n[Unit]\nDescription=Forge managed server\nStartLimitIntervalSec=60\nStartLimitBurst=5\n[Service]\nType=simple\nExecStart=${unitQuote(posix.join(version, 'bin/forge'))} serve --host 127.0.0.1 --port ${record.remotePort} --data-dir ${unitQuote(posix.join(record.installDir, 'data'))}\nEnvironment=${unitQuote('FORGE_ALLOWED_CLIENT_ORIGINS=' + clientOrigin)}\nEnvironment=${unitQuote('XDG_STATE_HOME=' + posix.join(record.installDir, 'host-state'))}\nWorkingDirectory=${record.installDir.replaceAll('%', '%%')}\nUMask=0077\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=45\nKillMode=control-group\n[Install]\nWantedBy=default.target\n`
}
async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export async function verifyManagedArtifact(
  artifact: ManagedServerArtifact,
  cacheDir: string,
): Promise<string> {
  if (
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(artifact.version) ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256)
  )
    fail('ARTIFACT', 'A pinned server version and SHA-256 are required.')
  let path = artifact.source
  if (/^https:\/\//.test(path)) {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 })
    path = join(cacheDir, artifact.sha256 + '.tar.gz')
    if ((await digestFile(path).catch(() => null)) !== artifact.sha256) {
      const temp = path + '.' + randomUUID() + '.tmp'
      try {
        const response = await fetch(artifact.source, {
          redirect: 'error',
          signal: AbortSignal.timeout(300000),
        })
        if (!response.ok || !response.body)
          fail('ARTIFACT', 'Server archive download failed.')
        const file = await open(temp, 'wx', 0o600)
        let bytes = 0
        try {
          const reader = response.body.getReader()
          try {
            for (;;) {
              const part = await reader.read()
              if (part.done) break
              bytes += part.value.length
              if (bytes > 1073741824) {
                await reader.cancel()
                fail('ARTIFACT', 'Server archive exceeded its limit.')
              }
              await file.write(part.value)
            }
          } finally {
            reader.releaseLock()
          }
          await file.sync()
        } finally {
          await file.close()
        }
        if ((await digestFile(temp)) !== artifact.sha256)
          fail('ARTIFACT', 'Server archive SHA-256 does not match.')
        await rename(temp, path)
      } finally {
        await rm(temp, { force: true })
      }
    }
  }
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path))
    fail(
      'ARTIFACT',
      'The artifact source must be an absolute local path or HTTPS URL.',
    )
  if ((await digestFile(path).catch(() => null)) !== artifact.sha256)
    fail('ARTIFACT', 'Server archive SHA-256 does not match.')
  return path
}
export function createManagedHostService(options: {
  storePath: string
  credentials: ReturnType<typeof createEnvironmentCredentialService>
  clientOrigin: string
  artifact(): Promise<ManagedServerArtifact | null>
  driver?: ManagedHostDriver
  verifyArtifact?: (artifact: ManagedServerArtifact) => Promise<string>
  health?: (
    baseUrl: string,
  ) => Promise<Pick<EnvironmentDescriptor, 'environmentId' | 'forgeVersion'>>
  assertIdle?: (record: ManagedHostRecord, baseUrl: string) => Promise<void>
  onChanged?: (statuses: ManagedHostStatus[]) => void
  grantTimeoutMs?: number
  retry?: boolean
}) {
  const driver = options.driver ?? createOpenSshDriver()
  const owner = createHash('sha256')
    .update(hostname() + '\n' + options.storePath)
    .digest('hex')
  let records: ManagedHostRecord[] | null = null,
    loading: Promise<void> | null = null,
    writes = Promise.resolve(),
    disposed = false
  const statuses = new Map<string, ManagedHostStatus>(),
    tunnels = new Map<string, ManagedTunnel>(),
    timers = new Map<string, ReturnType<typeof setTimeout>>(),
    attempts = new Map<string, number>(),
    busy = new Set<string>(),
    reconnects = new Map<string, Promise<void>>()
  async function load() {
    if (records) return
    if (loading) return loading
    loading = (async () => {
      try {
        const value: unknown = JSON.parse(
          await readFile(options.storePath, 'utf8'),
        )
        if (!Array.isArray(value) || value.length > 64)
          fail('UNAVAILABLE', 'Managed host metadata is invalid.')
        for (const r of value) validateRecord(r as ManagedHostRecord)
        records = value as ManagedHostRecord[]
        if (new Set(records.map((r) => r.hostAlias)).size !== records.length)
          fail(
            'UNAVAILABLE',
            'Managed host metadata contains duplicate aliases.',
          )
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') records = []
        else throw e
      }
    })()
    try {
      await loading
    } finally {
      loading = null
    }
  }
  async function save() {
    const snapshot = JSON.stringify(records) + '\n'
    const task = writes.then(async () => {
      await mkdir(dirname(options.storePath), { recursive: true, mode: 0o700 })
      const temp = options.storePath + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(temp, snapshot, { mode: 0o600, flag: 'wx' })
        await rename(temp, options.storePath)
      } finally {
        await rm(temp, { force: true })
      }
    })
    writes = task.catch(() => {})
    await task
  }
  function set(
    record: ManagedHostRecord,
    phase: ManagedHostStatus['phase'],
    message: string | null = null,
    baseUrl: string | null = tunnels.get(record.hostAlias)?.baseUrl ?? null,
  ) {
    statuses.set(record.hostAlias, {
      ...record,
      phase,
      message,
      baseUrl,
      desiredVersion: statuses.get(record.hostAlias)?.desiredVersion ?? null,
    })
    options.onChanged?.([...statuses.values()])
  }
  async function desired() {
    let artifact: ManagedServerArtifact | null
    try {
      artifact = await options.artifact()
    } catch {
      fail(
        'ARTIFACT',
        'The pinned Linux server artifact descriptor is invalid or does not match this Desktop.',
      )
    }
    if (!artifact)
      fail(
        'ARTIFACT',
        'This Desktop has no pinned Linux server artifact configured.',
      )
    return artifact
  }
  async function envelope<T>(
    work: () => Promise<T>,
  ): Promise<ManagedHostResult<T>> {
    try {
      return { ok: true, value: await work() }
    } catch (e) {
      return { ok: false, error: failure(e) }
    }
  }
  async function action<T>(
    alias: string,
    work: () => Promise<T>,
  ): Promise<ManagedHostResult<T>> {
    return envelope(async () => {
      validateAlias(alias)
      await load()
      if (disposed) fail('UNAVAILABLE', 'Desktop host management is closed.')
      if (busy.has(alias))
        fail('BUSY_OR_UNKNOWN', 'A host setup action is already running.')
      busy.add(alias)
      cancelRetry(alias)
      try {
        await reconnects.get(alias)
        if (disposed) fail('UNAVAILABLE', 'Desktop host management is closed.')
        return await work()
      } catch (e) {
        const r = records!.find((r) => r.hostAlias === alias)
        if (r)
          set(
            r,
            failure(e).code === 'NEEDS_PAIRING' ? 'needs-pairing' : 'error',
            failure(e).message,
          )
        throw e
      } finally {
        busy.delete(alias)
      }
    })
  }
  function record(alias: string) {
    const r = records!.find((r) => r.hostAlias === alias)
    if (!r)
      fail('INVALID_INPUT', 'This host alias is not managed by this Desktop.')
    return r
  }
  function cancelRetry(alias: string) {
    const timer = timers.get(alias)
    if (timer) clearTimeout(timer)
    timers.delete(alias)
  }
  async function closeTunnel(alias: string) {
    cancelRetry(alias)
    const tunnel = tunnels.get(alias)
    tunnels.delete(alias)
    await tunnel?.close()
  }
  function retry(record: ManagedHostRecord) {
    if (
      disposed ||
      options.retry === false ||
      busy.has(record.hostAlias) ||
      timers.has(record.hostAlias) ||
      !records?.includes(record)
    )
      return
    const attempt = attempts.get(record.hostAlias) ?? 0
    attempts.set(record.hostAlias, attempt + 1)
    const delay = retryDelayMs(attempt, Math.random())
    timers.set(
      record.hostAlias,
      setTimeout(
        () => {
          timers.delete(record.hostAlias)
          void reconnect(record)
        },
        Math.max(250, delay),
      ),
    )
  }
  async function openTunnel(record: ManagedHostRecord) {
    if (disposed) fail('UNAVAILABLE', 'Desktop host management is closed.')
    const existing = tunnels.get(record.hostAlias)
    if (existing) return existing
    let tunnel: ManagedTunnel | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        tunnel = await driver.tunnel(record.hostAlias, record.remotePort)
        break
      } catch (e) {
        if (
          !/Address already in use|port conflict/i.test(
            e instanceof Error ? e.message : '',
          )
        )
          throw e
      }
    }
    if (!tunnel)
      fail(
        'UNAVAILABLE',
        'Local forwarding ports were unavailable. Retry connection.',
      )
    if (disposed) {
      await tunnel.close()
      fail('UNAVAILABLE', 'Desktop host management is closed.')
    }
    tunnels.set(record.hostAlias, tunnel)
    void tunnel.exited.then(() => {
      if (tunnels.get(record.hostAlias) !== tunnel) return
      tunnels.delete(record.hostAlias)
      set(record, 'offline', 'The SSH tunnel disconnected.', null)
      retry(record)
    })
    return tunnel
  }
  async function health(baseUrl: string) {
    if (options.health) return options.health(baseUrl)
    const until = Date.now() + 45000
    while (Date.now() < until) {
      if (disposed) fail('UNAVAILABLE', 'Desktop host management is closed.')
      try {
        const response = await fetch(baseUrl + '/api/v2/environment', {
          redirect: 'error',
          signal: AbortSignal.timeout(2000),
        })
        const value = (await response.json()) as EnvironmentDescriptor
        if (
          response.ok &&
          uuid.test(value.environmentId) &&
          (value.protocolVersion === 1 || value.protocolVersion === 2)
        )
          return value
      } catch {
        /* Service may still be starting. */
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    fail(
      'UNAVAILABLE',
      'The SSH forward opened, but the Forge service did not become healthy.',
    )
  }
  async function verifyConnection(r: ManagedHostRecord, t: ManagedTunnel) {
    const info = await health(t.baseUrl)
    if (!r.environmentId || info.environmentId !== r.environmentId)
      fail(
        'IDENTITY_MISMATCH',
        'The host environment UUID changed. Pair the replacement explicitly.',
      )
    const refreshed = await options.credentials.refreshManagedEndpoint(
      r.environmentId,
      t.baseUrl,
    )
    if (!refreshed.ok)
      fail(
        refreshed.error.code === 'IDENTITY_MISMATCH'
          ? 'IDENTITY_MISMATCH'
          : refreshed.error.code === 'UNAUTHENTICATED'
            ? 'NEEDS_PAIRING'
            : 'UNAVAILABLE',
        refreshed.error.message,
      )
    const session = await options.credentials.managedTransport.session(r.environmentId)
    if (!session.ok)
      fail(
        session.error.code === 'UNAUTHENTICATED'
          ? 'NEEDS_PAIRING'
          : session.error.code === 'IDENTITY_MISMATCH'
            ? 'IDENTITY_MISMATCH'
            : 'UNAVAILABLE',
        session.error.message,
      )
    if (disposed) fail('UNAVAILABLE', 'Desktop host management is closed.')
    attempts.delete(r.hostAlias)
    set(r, 'ready', null, t.baseUrl)
  }
  function reconnect(r: ManagedHostRecord): Promise<void> {
    if (disposed || busy.has(r.hostAlias)) return Promise.resolve()
    const pending = reconnects.get(r.hostAlias)
    if (pending) return pending
    const task = reconnectWork(r)
    reconnects.set(r.hostAlias, task)
    void task.then(
      () => reconnects.delete(r.hostAlias),
      () => reconnects.delete(r.hostAlias),
    )
    return task
  }
  async function reconnectWork(r: ManagedHostRecord) {
    try {
      set(r, 'connecting')
      if (!r.environmentId) {
        set(
          r,
          'needs-pairing',
          'Installation was interrupted. Use Repair to complete pairing.',
        )
        return
      }
      const t = await openTunnel(r)
      await verifyConnection(r, t)
    } catch (e) {
      if (disposed) return
      const f = failure(e)
      set(
        r,
        f.code === 'NEEDS_PAIRING'
          ? 'needs-pairing'
          : f.code === 'IDENTITY_MISMATCH' || f.code === 'HOST_KEY'
            ? 'error'
            : 'offline',
        f.message,
      )
      if (
        f.code !== 'NEEDS_PAIRING' &&
        f.code !== 'IDENTITY_MISMATCH' &&
        f.code !== 'HOST_KEY'
      ) {
        await closeTunnel(r.hostAlias)
        retry(r)
      }
    }
  }
  async function preflight(alias: string) {
    const result = await driver.run(
      alias,
      `${shellHeader}# forge:preflight\n[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || fail PLATFORM\nfor tool in git tar sha256sum flock systemctl loginctl getconf ss; do command -v "$tool" >/dev/null || fail TOOLS; done\nlibc=$(getconf GNU_LIBC_VERSION); [ "$(printf '%s' "$libc" | cut -d' ' -f1)" = glibc ] || fail GLIBC\nversion=$(printf '%s' "$libc" | cut -d' ' -f2); major=$(printf '%s' "$version" | cut -d. -f1); minor=$(printf '%s' "$version" | cut -d. -f2); [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 36 ]; } || fail GLIBC\nsystemctl --user show-environment >/dev/null || fail USER_MANAGER\n[ "$(loginctl show-user "$(id -un)" -p Linger --value)" = yes ] || fail LINGER\nprintf '%s\\n' "$HOME"\n`,
    )
    const home = result.trim()
    if (!/^\/[A-Za-z0-9_./-]+$/.test(home))
      fail(
        'PREREQUISITE',
        'The Linux home directory contains unsupported path characters.',
      )
    return home
  }
  async function prepare(r: ManagedHostRecord) {
    await driver.run(
      r.hostAlias,
      `${shellHeader}# forge:prepare\nroot=${q(r.installDir)}\nunit="$HOME/.config/systemd/user/${r.serviceName}.service"\nif test -e "$root" || test -L "$root"; then test ! -L "$root" && test -f "$root/.forge-managed-owner" && test "$(cat "$root/.forge-managed-owner")" = ${q(installationOwner(r, owner))} || fail UNMANAGED; else test ! -e "$unit" && test ! -L "$unit" || fail UNMANAGED; mkdir -p "$root"; printf '%s\\n' ${q(installationOwner(r, owner))} > "$root/.forge-managed-owner"; fi\nmkdir -p "$root/versions" "$root/bootstrap" "$root/data" "$root/host-state"\nchmod 700 "$root" "$root/bootstrap"\nif test -e "$unit"; then test ! -L "$unit" && test "$(head -n 1 "$unit")" = ${q('# Forge managed: ' + owner)} || fail UNMANAGED; fi\nif test -d "$unit.d"; then for file in "$unit.d"/*; do test ! -e "$file" || { test "$file" = "$unit.d/forge-pairing.conf" && test "$(head -n 1 "$file")" = ${q('# Forge managed: ' + owner)}; } || fail UNMANAGED; done; fi\n`,
    )
  }
  async function install(
    r: ManagedHostRecord,
    artifact: ManagedServerArtifact,
  ) {
    const local = await (options.verifyArtifact?.(artifact) ??
      verifyManagedArtifact(artifact, options.storePath + '.artifacts'))
    const upload = posix.join(
      r.installDir,
      'upload-' + randomUUID() + '.tar.gz',
    )
    await driver.upload(r.hostAlias, local, upload)
    try {
      await driver.run(
        r.hostAlias,
        `${remoteOwned(r, owner)}# forge:install\narchive=${q(upload)}\n[ "$(sha256sum "$archive" | cut -d' ' -f1)" = ${q(artifact.sha256)} ] || fail ARTIFACT\nversion="$root/versions/forge-server-${artifact.version}-linux-x64"\nif test -e "$version"; then test ! -L "$version" && test "$(cat "$version/.artifact-sha256")" = ${q(artifact.sha256)} || fail UNMANAGED; else\n stage="$root/versions/.stage-${artifact.version}"\n rm -rf "$stage"; mkdir "$stage"\n tar -xzf "$archive" -C "$stage"\n candidate="$stage/forge-server-${artifact.version}-linux-x64"\n test -x "$candidate/bin/forge" && test -x "$candidate/node/bin/node" || fail ARTIFACT\n "$candidate/node/bin/node" -e ${q(`const m=require(process.argv[1]);if(m.version!==${JSON.stringify(artifact.version)}||m.platform!=='linux'||m.arch!=='x64'||m.libc!=='glibc'||m.minimumGlibc!=='2.36')process.exit(1)`)} "$candidate/manifest.json" || fail ARTIFACT\n "$candidate/bin/forge" --version >/dev/null || fail ARTIFACT\n printf '%s\\n' ${q(artifact.sha256)} > "$candidate/.artifact-sha256"\n mv "$candidate" "$version"; rmdir "$stage"\nfi\n`,
        { timeoutMs: 120000 },
      )
    } finally {
      await driver
        .run(r.hostAlias, `${remoteOwned(r, owner)}rm -f ${q(upload)}\n`)
        .catch(() => {})
    }
  }
  async function idle(r: ManagedHostRecord, baseUrl: string) {
    try {
      if (options.assertIdle) return await options.assertIdle(r, baseUrl)
      if (!r.environmentId)
        fail('BUSY_OR_UNKNOWN', 'The host state is unknown.')
      await assertManagedHostIdle(
        options.credentials.managedTransport,
        r,
        baseUrl,
        options.clientOrigin,
        driver,
      )
    } catch {
      fail(
        'BUSY_OR_UNKNOWN',
        'The host is busy or its state is unknown. Stop sessions, settle commands and close terminals before updating or pairing.',
      )
    }
  }
  async function steady(r: ManagedHostRecord, restart = true) {
    await driver.run(
      r.hostAlias,
      `${remoteOwned(r, owner)}# forge:steady\nmkdir -p "$(dirname "$unit")"\ncat > "$unit.tmp" <<'FORGE_UNIT'\n${serviceUnit(r, owner, options.clientOrigin)}FORGE_UNIT\nmv "$unit.tmp" "$unit"\nrm -f "$unit.d/forge-pairing.conf"\nfind "$root/bootstrap" -maxdepth 1 -type f -name 'pairing-*.url' -delete\nsystemctl --user daemon-reload\nsystemctl --user enable ${q(r.serviceName + '.service')} >/dev/null\n${restart ? 'systemctl --user restart ' + q(r.serviceName + '.service') : ''}\n`,
      { timeoutMs: 60000 },
    )
  }
  async function pair(r: ManagedHostRecord, t: ManagedTunnel) {
    const file = posix.join(
      r.installDir,
      'bootstrap',
      'pairing-' + randomUUID() + '.url',
    )
    const binary = posix.join(
      r.installDir,
      'versions',
      `forge-server-${r.installedVersion}-linux-x64`,
      'bin/forge',
    )
    let started = false
    try {
      // A failed previous bootstrap cannot leave a restart-enabled grant producer behind.
      await steady(r, false)
      const { getEnvironmentDbPath } = await import(
        '../../backend/src/swarm/storage/data-paths.js'
      )
      const db = getEnvironmentDbPath(posix.join(r.installDir, 'data'))
        .split('\\')
        .join('/')
      const node = posix.join(dirname(dirname(binary)), 'node/bin/node')
      const sqlite = posix.join(
        dirname(dirname(binary)),
        'backend/node_modules/better-sqlite3',
      )
      await driver.run(
        r.hostAlias,
        `${remoteOwned(r, owner)}# forge:bootstrap\n${q(node)} -e ${q(`const fs=require('fs');const p=${JSON.stringify(db)};if(fs.existsSync(p)){const DB=require(${JSON.stringify(sqlite)});const d=new DB(p,{readonly:true,fileMustExist:true});try{if(d.prepare('SELECT count(*) AS n FROM control_sessions').get().n>0||d.prepare(\"SELECT count(*) AS n FROM command_receipts WHERE state IN ('accepted','running')\").get().n>0)process.exit(1)}finally{d.close()}}`)} || fail BUSY\nif systemctl --user is-active --quiet ${q(r.serviceName + '.service')}; then systemctl --user stop ${q(r.serviceName + '.service')}; fi\nif ss -H -ltn 'sport = :${r.remotePort}' | read -r line; then fail PORT; fi\nmkdir -p "$unit.d"\ncat > "$unit.d/forge-pairing.conf" <<'FORGE_PAIR'\n# Forge managed: ${owner}\n[Service]\nRestart=no\nExecStart=\nExecStart=${unitQuote(binary)} serve --host 127.0.0.1 --port ${r.remotePort} --data-dir ${unitQuote(posix.join(r.installDir, 'data'))} --pair --pair-output ${unitQuote(file)}\nFORGE_PAIR\nsystemctl --user daemon-reload\nsystemctl --user start ${q(r.serviceName + '.service')}\n`,
      )
      started = true
      const until = Date.now() + (options.grantTimeoutMs ?? 45000)
      let grant = ''
      while (Date.now() < until) {
        grant = await driver.run(
          r.hostAlias,
          `${shellHeader}# forge:grant\ntest ! -L ${q(file)} || exit 1\nif test -s ${q(file)}; then cat ${q(file)}; fi\n`,
          { maxBytes: 4096, timeoutMs: 10000 },
        )
        if (grant.trim()) break
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(250, options.grantTimeoutMs ?? 250)),
        )
      }
      if (!grant.trim())
        fail(
          'GRANT_TIMEOUT',
          'The private pairing grant timed out. Use Repair to retry setup.',
        )
      let url: URL
      try {
        url = new URL(grant.trim())
      } catch {
        fail('GRANT_TIMEOUT', 'The private pairing grant was invalid.')
      }
      const fields = new URLSearchParams(url.hash.slice(1))
      const environmentId =
        fields.get('environmentId') ??
        url.searchParams.get('environmentId') ??
        ''
      const grantId =
        fields.get('grantId') ?? url.searchParams.get('grantId') ?? ''
      const secret = fields.get('secret') ?? ''
      if (
        !uuid.test(environmentId) ||
        !uuid.test(grantId) ||
        !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
        url.origin !== `http://127.0.0.1:${r.remotePort}`
      )
        fail('GRANT_TIMEOUT', 'The private pairing grant was invalid.')
      if (r.environmentId && r.environmentId !== environmentId)
        fail(
          'IDENTITY_MISMATCH',
          'The SSH-delivered environment identity changed.',
        )
      r.environmentId = environmentId
      await save()
      const result = await options.credentials.pair({
        baseUrl: t.baseUrl,
        environmentId,
        credential: { kind: 'link', grantId, secret },
        deviceName: 'Forge Desktop',
        requestedScopes: [
          'session:read',
          'session:operate',
          'workspace:read',
          'workspace:write',
          'terminal:operate',
          'settings:admin',
          'access:admin',
        ],
      })
      grant = ''
      if (!result.ok)
        fail(
          result.error.code === 'IDENTITY_MISMATCH'
            ? 'IDENTITY_MISMATCH'
            : 'NEEDS_PAIRING',
          result.error.message,
        )
    } finally {
      let cleaned = false
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await driver.run(
            r.hostAlias,
            `${remoteOwned(r, owner)}# forge:pair-cleanup\nrm -f ${q(file)} "$unit.d/forge-pairing.conf"\nsystemctl --user daemon-reload\n`,
          )
          if (started) await steady(r)
          cleaned = true
          break
        } catch {
          /* Retry the bounded, idempotent cleanup once. */
        }
      }
      if (!cleaned)
        fail(
          'UNAVAILABLE',
          'Pairing cleanup could not complete. Use Repair to remove the private grant and pairing override and restore the steady service.',
        )
    }
    await verifyConnection(r, t)
  }
  async function verifyInstalled(r: ManagedHostRecord) {
    const version = posix.join(
      r.installDir,
      'versions',
      `forge-server-${r.installedVersion}-linux-x64`,
    )
    await driver.run(
      r.hostAlias,
      `${remoteOwned(r, owner)}# forge:installed\nversion=${q(version)}\ntest ! -L "$version" && test "$(cat "$version/.artifact-sha256")" = ${q(r.artifactSha256)} && test -x "$version/bin/forge" && test -x "$version/node/bin/node" || fail ARTIFACT\n"$version/bin/forge" --version >/dev/null || fail ARTIFACT\n`,
    )
  }
  async function setup(
    r: ManagedHostRecord,
    artifact: ManagedServerArtifact | null,
  ) {
    set(r, 'installing')
    await preflight(r.hostAlias)
    await prepare(r)
    if (artifact) await install(r, artifact)
    else await verifyInstalled(r)
    if (r.environmentId) {
      await steady(r, false)
      await driver.run(
        r.hostAlias,
        `${remoteOwned(r, owner)}# forge:ensure-service\nsystemctl --user start ${q(r.serviceName + '.service')}\n`,
      )
    }
    const t = await openTunnel(r)
    if (r.environmentId) {
      try {
        await verifyConnection(r, t)
        return
      } catch (e) {
        if (!(e instanceof HostFailure) || e.code !== 'NEEDS_PAIRING') throw e
      }
    }
    await pair(r, t)
  }
  async function updateHost(
    r: ManagedHostRecord,
    artifact: ManagedServerArtifact,
  ) {
    const numeric = (v: string) => v.split(/[.-]/).slice(0, 3).map(Number)
    const from = numeric(r.installedVersion),
      to = numeric(artifact.version)
    for (let i = 0; i < 3; i++) {
      if (to[i] < from[i])
        fail('ARTIFACT', 'An older Desktop cannot downgrade this managed host.')
      if (to[i] > from[i]) break
    }
    const t = await openTunnel(r)
    await verifyConnection(r, t)
    await idle(r, t.baseUrl)
    await prepare(r)
    await install(r, artifact)
    await idle(r, t.baseUrl)
    const next = {
      ...r,
      installedVersion: artifact.version,
      artifactSha256: artifact.sha256,
    }
    try {
      await steady(next)
    } catch {
      let restored = false
      try {
        await steady(r)
        restored = true
      } catch {
        /* Keep both artifacts for explicit Repair. */
      }
      fail(
        'UNAVAILABLE',
        restored
          ? 'Update restart failed; the previous service was restored. Use Repair to retry the desired artifact.'
          : 'Update restart failed and the previous service could not be restored. Use Repair to recover the installed or desired artifact.',
      )
    }
    r.installedVersion = artifact.version
    r.artifactSha256 = artifact.sha256
    await save()
    await verifyConnection(r, t)
    const info = await health(t.baseUrl)
    if (info.forgeVersion !== artifact.version)
      fail(
        'ARTIFACT',
        'The restarted host reports an unexpected version. Repair the service; the previous artifact has been retained.',
      )
    return statuses.get(r.hostAlias)!
  }
  return {
    start: async () => {
      await load()
      const artifact = await options.artifact().catch(() => null)
      for (const r of records!) {
        set(r, 'connecting')
        statuses.get(r.hostAlias)!.desiredVersion = artifact?.version ?? null
      }
      await Promise.all(records!.map(reconnect))
    },
    add: (input: ManagedHostAddInput) =>
      action(input?.hostAlias, async () => {
        if (records!.some((r) => r.hostAlias === input.hostAlias))
          fail('INVALID_INPUT', 'This alias is already managed. Use Repair.')
        const artifact = await desired()
        const home = await preflight(input.hostAlias)
        const serviceName = input.serviceName ?? 'forge-managed'
        const raw =
          input.installDir ?? `~/.local/share/forge/managed/${serviceName}`
        const installDir = raw.startsWith('~/') ? home + raw.slice(1) : raw
        const r: ManagedHostRecord = {
          hostAlias: input.hostAlias,
          installDir,
          installedVersion: artifact.version,
          artifactSha256: artifact.sha256,
          serviceName,
          remotePort: input.remotePort ?? 47787,
          environmentId: null,
        }
        validateRecord(r)
        records!.push(r)
        await save()
        set(r, 'installing')
        statuses.get(r.hostAlias)!.desiredVersion = artifact.version
        await setup(r, artifact)
        return statuses.get(r.hostAlias)!
      }),
    status: (alias?: string) =>
      envelope(async () => {
        await load()
        if (alias !== undefined) validateAlias(alias)
        for (const r of records!)
          if (!statuses.has(r.hostAlias)) set(r, 'offline')
        return [...statuses.values()].filter(
          (s) => !alias || s.hostAlias === alias,
        )
      }),
    repair: (alias: string) =>
      action(alias, async () => {
        const r = record(alias)
        const artifact = await options.artifact().catch(() => null)
        await closeTunnel(alias)
        let installed = false
        try {
          await verifyInstalled(r)
          installed = true
        } catch {
          /* Matching pinned archive can repair missing content. */
        }
        const matches =
          artifact?.version === r.installedVersion &&
          artifact.sha256 === r.artifactSha256
        if (!installed && !matches)
          fail(
            'ARTIFACT',
            'The installed artifact is unavailable. Restore its pinned archive to repair this host.',
          )
        await setup(r, installed ? null : artifact)
        if (artifact && !matches) return updateHost(r, artifact)
        return statuses.get(alias)!
      }),
    update: (alias: string) =>
      action(alias, async () => updateHost(record(alias), await desired())),
    removeConnection: (alias: string) =>
      action(alias, async () => {
        const r = record(alias)
        await closeTunnel(alias)
        if (r.environmentId) {
          const result = await options.credentials.remove(r.environmentId)
          if (!result.ok) fail('UNAVAILABLE', result.error.message)
        }
        records = records!.filter((item) => item !== r)
        await save()
        statuses.delete(alias)
        options.onChanged?.([...statuses.values()])
        return { removed: true }
      }),
    dispose: async () => {
      if (disposed) return
      disposed = true
      for (const alias of timers.keys()) cancelRetry(alias)
      await Promise.all([...tunnels.keys()].map(closeTunnel))
      await driver.dispose?.()
      await Promise.allSettled([...reconnects.values()])
    },
  }
}
