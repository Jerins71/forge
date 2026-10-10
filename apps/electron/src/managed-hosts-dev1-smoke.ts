/** Explicit operator-only native macOS + Linux proof. Never runs in the ordinary test suite. */
import { app, safeStorage } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import {
  createManagedHostService,
  type ManagedHostDriver,
} from './managed-hosts.js'
import { createEnvironmentCredentialService } from './environment-credentials-ipc.js'
import { createOpenSshDriver, shellQuote as q } from './managed-hosts-ssh.js'
const proofRoot = resolve(process.env.FORGE_MANAGED_PROOF_DIR ?? '')
if (
  process.env.FORGE_MANAGED_TEST_ALLOW !== 'dev1' ||
  !proofRoot.includes('/.internal/ssh-managed/')
)
  throw new Error('Explicit isolated dev1 proof directory is required')
app.setPath('userData', join(proofRoot, 'desktop-user-data'))
const evidence: {
  startedAt: string
  ok: boolean
  stages: Record<string, unknown>[]
  limits: string[]
  failure?: string
  cleanup?: boolean
} = {
  startedAt: new Date().toISOString(),
  ok: false,
  stages: [],
  limits: [
    'No real host reboot; service restart exercised.',
    'Native OpenSSH Desktop path qualified on macOS only.',
    'Explicit update has an idle-check/restart race; no host admission lock.',
    'Published artifact channel is a main-only manifest seam.',
  ],
}
const native = createOpenSshDriver()
let service: ReturnType<typeof createManagedHostService> | undefined
let installDir: string | undefined
const stage = (name: string, details: Record<string, unknown> = {}) =>
  evidence.stages.push({ name, at: new Date().toISOString(), ...details })
function requireOk<T>(
  result:
    | {
        ok: true
        value: T
      }
    | {
        ok: false
        error: {
          code: string
        }
      },
): T {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}
void app
  .whenReady()
  .then(async () => {
    await mkdir(proofRoot, { recursive: true, mode: 0o700 })
    const credentials = createEnvironmentCredentialService({
      storePath: join(
        proofRoot,
        'desktop-user-data',
        'environment-credentials.json',
      ),
      safeStorage,
      clientOrigin: 'app://forge',
    })
    let tunnelCount = 0,
      grantReadCount = 0
    const driver: ManagedHostDriver = {
      ...native,
      tunnel: async (...args) => {
        tunnelCount++
        return native.tunnel(...args)
      },
      run: async (...args) => {
        if (args[1].includes('# forge:grant')) grantReadCount++
        try {
          return await native.run(...args)
        } catch {
          stage('remote-command-failed', {
            phase: args[1].match(/# forge:([a-z-]+)/)?.[1] ?? 'cleanup',
          })
          throw new Error(
            'SSH_PHASE_' +
              (args[1].match(/# forge:([a-z-]+)/)?.[1] ?? 'cleanup'),
          )
        }
      },
    }
    const options = {
      storePath: join(proofRoot, 'desktop-user-data', 'managed-hosts.json'),
      credentials,
      clientOrigin: 'app://forge',
      driver,
      artifact: async () => ({
        version: '0.26.1',
        sha256:
          'd0c127a5c4ca36720f58416258ef6baa8f2298c39964e2e490a4345b2469f17b',
        source: process.env.FORGE_MANAGED_TEST_ARCHIVE ?? '',
      }),
    }
    try {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error('NATIVE_ENCRYPTION_UNAVAILABLE')
      service = createManagedHostService(options)
      const added = requireOk(
        await service.add({
          hostAlias: 'dev1',
          serviceName: 'forge-v2-managed',
          installDir: '~/.forge-managed-test',
          remotePort: 47788,
        }),
      )
      installDir = added.installDir
      if (added.phase !== 'ready' || !added.environmentId || !added.baseUrl)
        throw new Error('ADD_NOT_READY')
      const id = added.environmentId
      const oldSession = requireOk(await credentials.session(id)).deviceSession
        .deviceSessionId
      stage('add-health-paired', {
        environmentId: id,
        version: added.installedVersion,
        baseUrl: added.baseUrl,
        nativeEncryptedStorage: true,
      })
      await service.dispose()
      service = createManagedHostService(options)
      await service.start()
      const reopened = requireOk(await service.status('dev1'))[0]
      if (
        reopened.phase !== 'ready' ||
        reopened.environmentId !== id ||
        requireOk(await credentials.session(id)).deviceSession
          .deviceSessionId !== oldSession
      )
        throw new Error('REOPEN_IDENTITY_CHANGED')
      stage('close-reopen-tunnel', {
        environmentId: id,
        baseUrl: reopened.baseUrl,
        portChanged: reopened.baseUrl !== added.baseUrl,
      })
      await native.run(
        'dev1',
        'set -eu\nsystemctl --user restart forge-v2-managed.service\n',
      )
      await service.dispose()
      service = createManagedHostService(options)
      await service.start()
      const restarted = requireOk(await service.status('dev1'))[0]
      if (
        restarted.phase !== 'ready' ||
        restarted.environmentId !== id ||
        requireOk(await credentials.session(id)).deviceSession
          .deviceSessionId !== oldSession
      )
        throw new Error('RESTART_IDENTITY_CHANGED')
      stage('remote-service-restart', {
        environmentId: id,
        deviceSessionKept: true,
      })
      const updated = requireOk(await service.update('dev1'))
      if (updated.phase !== 'ready' || updated.environmentId !== id)
        throw new Error('UPDATE_NOT_READY')
      const updatedSessionKept =
        requireOk(await credentials.session(id)).deviceSession.deviceSessionId ===
        oldSession
      if (!updatedSessionKept) throw new Error('UPDATE_SESSION_CHANGED')
      stage('explicit-update-rerun', {
        environmentId: id,
        version: updated.installedVersion,
        deviceSessionKept: updatedSessionKept,
      })
      const bootstrapSafe = await native.run(
        'dev1',
        `set -eu\n! test -e "$HOME/.config/systemd/user/forge-v2-managed.service.d/forge-pairing.conf"\n! find ${q(installDir + '/bootstrap')} -name 'pairing-*.url' | read -r line\n! systemctl --user cat forge-v2-managed.service | grep -q -- '--pair'\n`,
      )
      if (bootstrapSafe) throw new Error('BOOTSTRAP_CLEANUP_INVALID')
      requireOk(await service.removeConnection('dev1'))
      stage('remove-connection', {
        removed: true,
        serviceStillRunning:
          (
            await native.run(
              'dev1',
              'systemctl --user is-active forge-v2-managed.service\n',
            )
          ).trim() === 'active',
        tunnelCount,
        grantReadCount,
      })
      evidence.ok = true
    } catch (error) {
      evidence.failure = error instanceof Error ? error.message : 'PROOF_FAILED'
    } finally {
      await service?.dispose()
      // Bounded, explicitly authorized test cleanup. Never touch the pre-existing Forge/T3 installations.
      try {
        const owner = createHash('sha256')
          .update(hostname() + '\n' + options.storePath)
          .digest('hex')
        const marker = owner + '\nforge-v2-managed\n47788'
        await native.run(
          'dev1',
          `set -eu\nroot="$HOME/.forge-managed-test"\nunit="$HOME/.config/systemd/user/forge-v2-managed.service"\nif test -f "$root/.forge-managed-owner" && test "$(cat "$root/.forge-managed-owner")" = ${q(marker)} && test -f "$unit" && test "$(head -n 1 "$unit")" = ${q('# Forge managed: ' + owner)}; then\n if systemctl --user is-active --quiet forge-v2-managed.service; then systemctl --user stop forge-v2-managed.service; fi\n systemctl --user disable forge-v2-managed.service >/dev/null\n rm -f "$unit" "$unit.d/forge-pairing.conf"\n rmdir "$unit.d" 2>/dev/null || true\n systemctl --user daemon-reload\n rm -rf "$root"\nfi\ntest ! -e "$root" && test ! -e "$unit"\n`,
        )
        evidence.cleanup = true
      } catch {
        evidence.cleanup = false
      }
      await writeFile(
        join(proofRoot, 'dev1-evidence.json'),
        JSON.stringify(evidence, null, 2) + '\n',
        { mode: 0o600 },
      )
      process.stdout.write(
        JSON.stringify({
          ok: evidence.ok,
          cleanup: evidence.cleanup,
          stages: evidence.stages.map((s) => s.name),
          failure: evidence.failure,
        }) + '\n',
      )
      app.exit(evidence.ok && evidence.cleanup ? 0 : 1)
    }
  })
  .catch(() => {
    process.stdout.write('{"ok":false,"failure":"ELECTRON_STARTUP_FAILED"}\n')
    app.exit(1)
  })
