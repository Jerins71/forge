import type {
  ArtifactRef,
  CommandReceipt,
  Method,
  RpcInput,
  RpcOutput,
  RpcStreamItem,
  StreamMethod,
} from '@forge/protocol/environment-v2'
import {
  ProjectSummarySchema,
  SessionSummarySchema,
  StreamCursorSchema,
  ArtifactRefSchema,
  rpcRegistry,
  decodeEnvironmentValue,
} from '@forge/protocol/environment-v2'
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type {
  EnvironmentCatalogEntry,
  EnvironmentClient,
  StreamObserver,
} from './types.js'
import type { PendingCommand, RuntimePorts } from './ports.js'
import { AuthenticatedHttp } from './connection/authenticated-http.js'
import { EnvironmentSupervisor } from './connection/supervisor.js'
import { ShellStore } from './stores/shell-store.js'
import { ReadCache } from './stores/read-cache.js'
import { KeyedSelectorStore } from './stores/selector-store.js'
import { DetailCache } from './stores/detail-cache.js'
import { createFeatureClients } from './feature-clients/index.js'
import { EnvironmentRuntimeError, unavailable } from './errors.js'
const CachedProjectsSchema = Type.Array(ProjectSummarySchema)
const CachedSessionsSchema = Type.Array(SessionSummarySchema)
function requiresProjectPolicy(method: string): boolean { return method.startsWith('project.') || method === 'session.configure' || method.startsWith('workspace.directories.') || method === 'settings.recommendedDefaults.apply' }
export class RuntimeEnvironmentClient implements EnvironmentClient {
  readonly environmentId: string
  readonly http: AuthenticatedHttp
  readonly supervisor: EnvironmentSupervisor
  readonly shell: ShellStore
  readonly connection: EnvironmentSupervisor['connection']
  readonly features: EnvironmentClient['features']
  private readonly details: DetailCache
  private readonly pending = new Map<string, PendingCommand>()
  readonly receipts = new KeyedSelectorStore<
    ReadonlyMap<string, CommandReceipt>
  >(new Map())
  private pendingWrite: Promise<void> = Promise.resolve()
  private readonly urls = new Set<string>()
  private readonly platformAssets = new Set<() => void>()
  private readonly readCache = new ReadCache()
  private cacheTimer: ReturnType<typeof setTimeout> | null = null
  private cacheWrite: Promise<void> = Promise.resolve()
  private started = false
  private readonly detachConnection: () => void
  constructor(
    readonly entry: EnvironmentCatalogEntry,
    readonly ports: RuntimePorts,
  ) {
    this.environmentId = entry.environmentId
    this.http = new AuthenticatedHttp(entry, ports)
    this.supervisor = new EnvironmentSupervisor(
      this.http,
      ports,
      () => this.prepareCache(),
      (error) =>
        error.code === 'PROTOCOL_MISMATCH'
          ? this.clearProtectedCache()
          : this.purge(),
    )
    this.connection = this.supervisor.connection
    this.shell = new ShellStore(
      ports,
      (page, onOutput) => {
        void this.supervisor
          .request('shell.page', { page }, { onOutput })
          .catch((error) => {
            this.shell.invalidateCursor()
            this.supervisor.invalidate(error)
          })
      },
      () => {
        this.supervisor.synchronized()
        void this.recoverCommands()
      },
      () => this.scheduleCache(),
      () => this.supervisor.invalidate(unavailable()),
    )
    this.supervisor.subscribe(
      'shell.subscribe',
      () => ({
        ...(this.shell.getSnapshot().cursor
          ? { cursor: this.shell.getSnapshot().cursor! }
          : {}),
      }),
      {
        next: (item) => this.shell.ingest(item),
        error: (error) => {
          this.supervisor.markStale()
          if (
            error instanceof EnvironmentRuntimeError &&
            error.code === 'RESYNC_REQUIRED'
          )
            this.shell.invalidateCursor()
        },
      },
    )
    this.http.onUnauthorized = (error) => this.supervisor.invalidate(error)
    this.details = new DetailCache(
      this.supervisor,
      ports,
      () => this.readCache.clear(),
      (r) => this.applyReceipt(r),
    )
    this.features = createFeatureClients(this.http, this, (blob) => {
      const url = this.ports.createObjectUrl?.(blob) ?? URL.createObjectURL(blob)
      this.urls.add(url)
      return {
        url,
        release: () => {
          if (this.urls.delete(url))
            (this.ports.revokeObjectUrl ?? URL.revokeObjectURL)(url)
        },
      }
    })
    this.detachConnection = this.connection.subscribe(
      (s) => s.transportHealthy,
      () => {
        if (!this.connection.getSnapshot().transportHealthy) this.shell.flush()
      },
    )
  }
  descriptor() {
    return this.http.descriptor
  }
  deviceSession() {
    return this.http.deviceSession
  }
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const received = await this.ports.persistence
      .loadShell(this.environmentId)
      .catch(() => null)
    const cached = received && this.decodeCache(received)
    const credential = await this.ports.credentials.load(this.environmentId)
    if (
      credential?.expiresAt &&
      Date.parse(credential.expiresAt) <= this.now()
    ) {
      await this.purge()
      if (this.entry.enabled)
        this.supervisor.startBlocked(
          new EnvironmentRuntimeError(
            'UNAUTHENTICATED',
            'Device expired',
            false,
            undefined,
            'expired',
          ),
        )
      return
    }
    const mayHydrate =
      this.ports.platform ||
      !this.ports.clientOrigin ||
      this.ports.clientOrigin === this.entry.baseUrl ||
      credential?.deviceSessionId === cached?.deviceSessionId
    if (
      cached &&
      mayHydrate &&
      (!credential?.deviceSessionId ||
        credential.deviceSessionId === cached.deviceSessionId)
    )
      this.shell.hydrate(cached)
    if (this.entry.enabled) this.supervisor.start()
  }
  private decodeCache(
    cached: import('./ports.js').ShellCacheRecord,
  ): import('./ports.js').ShellCacheRecord | null {
    if (
      cached.environmentId !== this.environmentId ||
      cached.protocolVersion !== 1 ||
      cached.cacheSchemaVersion !== 1 ||
      cached.streamEpoch !== cached.cursor?.streamEpoch ||
      !(Date.parse(cached.cachedAt) > this.now() - 30 * 86400000) ||
      new TextEncoder().encode(JSON.stringify(cached)).byteLength > 4194304
    )
      return null
    const cursor = decodeEnvironmentValue(StreamCursorSchema, cached.cursor)
    const projects = decodeEnvironmentValue(CachedProjectsSchema, cached.projects)
    const sessions = decodeEnvironmentValue(CachedSessionsSchema, cached.sessions)
    return cursor && projects && sessions
      ? { ...cached, cursor, projects, sessions }
      : null
  }
  setEnabled(enabled: boolean): void {
    this.entry.enabled = enabled
    if (enabled && this.started) this.supervisor.start()
    else this.supervisor.stop()
  }
  private async prepareCache(): Promise<void> {
    const descriptor = this.descriptor()!,
      device = this.http.deviceSession!
    const state = this.shell.getSnapshot()
    if (state.cursor && state.cursor.streamEpoch !== descriptor.streamEpoch) {
      this.shell.reset()
      this.details.purge()
      this.readCache.clear()
    }
    const received = await this.ports.persistence.loadShell(this.environmentId)
    const cached = received && this.decodeCache(received)
    if (
      cached &&
      cached.deviceSessionId === device.deviceSessionId &&
      cached.streamEpoch === descriptor.streamEpoch
    ) {
      if (!this.shell.getSnapshot().complete) this.shell.hydrate(cached)
    } else if (received) {
      this.shell.reset()
      this.readCache.clear()
      await this.ports.persistence.deleteShell(this.environmentId)
    }
    const journal = await this.ports.persistence.loadPending?.(
      this.environmentId,
    )
    if (
      Array.isArray(journal) &&
      new TextEncoder().encode(JSON.stringify(journal)).byteLength <= 262144
    )
      for (const command of journal.slice(0, 100))
        if (
          command?.method in rpcRegistry &&
          rpcRegistry[command.method as PendingCommand['method']].receipt &&
          (!requiresProjectPolicy(command.method) || descriptor.capabilities.projectPolicy) &&
          Value.Check(
            rpcRegistry[command.method as PendingCommand['method']].input,
            command.input,
          ) &&
          command.deviceSessionId === device.deviceSessionId &&
          command.credentialRef === this.entry.credentialRef
        )
          this.pending.set(command.input.commandId, command)
    this.details.resume()
  }
  async request<M extends Method>(
    method: M,
    input: RpcInput<M>,
    options?: { signal?: AbortSignal },
  ): Promise<RpcOutput<M>> {
    if (requiresProjectPolicy(method) && !this.descriptor()?.capabilities.projectPolicy) throw new EnvironmentRuntimeError('PROTOCOL_MISMATCH', 'Update this environment to use project policy controls')
    if (!this.supervisor.isOpen()) throw unavailable()
    const readKey =
      method === 'session.content' ||
      (method === 'session.history' &&
        !!(input as RpcInput<'session.history'>).before)
        ? JSON.stringify([
            this.descriptor()?.streamEpoch,
            this.http.deviceSession?.deviceSessionId,
            method,
            input,
          ])
        : null
    if (readKey && !options?.signal?.aborted) {
      const cached = this.readCache.get<RpcOutput<M>>(readKey)
      if (cached) return cached
    }
    const receipt = rpcRegistry[method].receipt
    let command: PendingCommand | undefined
    let journalWrite: Promise<void> = Promise.resolve()
    if (receipt) {
      if (this.pending.size >= 100)
        throw new EnvironmentRuntimeError(
          'RATE_LIMITED',
          'Too many unresolved commands',
        )
      if (!Value.Check(rpcRegistry[method].input, input))
        throw new EnvironmentRuntimeError('INVALID_INPUT', 'Invalid command')
      command = {
        method: method as PendingCommand['method'],
        input: structuredClone(input) as PendingCommand['input'],
        credentialRef: this.entry.credentialRef,
        deviceSessionId: this.http.deviceSession!.deviceSessionId,
      }
      if (
        new TextEncoder().encode(
          JSON.stringify([...this.pending.values(), command]),
        ).byteLength > 262144
      )
        throw new EnvironmentRuntimeError(
          'RATE_LIMITED',
          'Pending command journal is full',
        )
      const previous = this.pending.get(command.input.commandId)
      if (previous && JSON.stringify(previous) !== JSON.stringify(command))
        throw new EnvironmentRuntimeError(
          'CONFLICT',
          'Command identity already has a different payload',
        )
    }
    try {
      const resultPromise = this.supervisor.request(method, input, {
        ...options,
        onSent: () => {
          if (command) {
            this.pending.set(command.input.commandId, command)
            journalWrite = this.persistPending()
          }
        },
      })
      const result = await resultPromise
      await journalWrite
      if (receipt) this.applyReceipt(result as CommandReceipt)
      if (readKey) this.readCache.set(readKey, result)
      if (
        method === 'access.devices.revoke' &&
        (input as RpcInput<'access.devices.revoke'>).deviceSessionId ===
          this.http.deviceSession?.deviceSessionId
      ) {
        this.supervisor.stop()
        await this.purge()
        this.connection.set({
          ...this.connection.getSnapshot(),
          phase: 'auth-blocked',
          blockedCause: 'revoked',
          reason: 'Device revoked',
        })
      }
      return result
    } catch (error) {
      await journalWrite
      if (
        receipt &&
        error instanceof EnvironmentRuntimeError &&
        !error.retryable &&
        error.code !== 'UNAVAILABLE'
      ) {
        this.pending.delete((input as { commandId: string }).commandId)
        await this.persistPending()
      }
      throw error
    }
  }
  private applyReceipt(receipt: CommandReceipt): void {
    const next = new Map(this.receipts.getSnapshot())
    next.set(receipt.commandId, receipt)
    while (next.size > 100) next.delete(next.keys().next().value!)
    this.receipts.set(next, [receipt.commandId])
    if (['succeeded', 'failed', 'interrupted'].includes(receipt.state)) {
      this.pending.delete(receipt.commandId)
      void this.persistPending().catch(() => {})
    }
  }
  private recovering = false
  private async recoverCommands(): Promise<void> {
    if (this.recovering) return
    this.recovering = true
    try {
      for (const command of this.pending.values()) {
        if (requiresProjectPolicy(command.method) && !this.descriptor()?.capabilities.projectPolicy) continue
        if (
          command.deviceSessionId !==
            this.http.deviceSession?.deviceSessionId ||
          command.credentialRef !== this.entry.credentialRef
        ) {
          this.pending.delete(command.input.commandId)
          continue
        }
        try {
          this.applyReceipt(
            await this.supervisor.request('command.get', {
              commandId: command.input.commandId,
            }),
          )
        } catch (error) {
          if (
            error instanceof EnvironmentRuntimeError &&
            error.code === 'NOT_FOUND'
          )
            this.applyReceipt(
              await this.supervisor.request(
                command.method,
                command.input as RpcInput<typeof command.method>,
              ),
            )
          else break
        }
      }
    } finally {
      this.recovering = false
      await this.persistPending()
    }
  }
  private persistPending(): Promise<void> {
    const commands = structuredClone([...this.pending.values()])
    this.pendingWrite = this.pendingWrite
      .catch(() => {})
      .then(() =>
        this.ports.persistence.savePending?.(this.environmentId, commands),
      )
    return this.pendingWrite
  }
  subscribe<M extends StreamMethod>(
    method: M,
    input: RpcInput<M>,
    observer: StreamObserver<RpcStreamItem<M>>,
  ) {
    return this.supervisor.subscribe(method, () => input, observer)
  }
  attachTerminal(
    terminalId: string,
    session: import('@forge/protocol/environment-v2').SessionRef,
    observer: StreamObserver<RpcStreamItem<'terminal.attach'>>,
  ): import('./feature-clients/index.js').TerminalAttachment {
    if (session.environmentId !== this.environmentId)
      throw new Error('Terminal belongs to another environment')
    let subscriptionId: string | null = null
    const release = this.supervisor.subscribe(
      'terminal.attach',
      async () => {
        subscriptionId = null
        const ticket = await this.features.terminals.ticket(terminalId, {
          sessionAgentId: session.sessionId,
          requesterAgentId: session.sessionId,
        })
        return {
          terminalId,
          sessionId: session.sessionId,
          ticket: ticket.ticket,
        }
      },
      {
        next: (item) => observer.next(item),
        error: (error) => {
          subscriptionId = null
          observer.error(error)
        },
      },
      (id) => {
        subscriptionId = id
      },
    )
    return {
      release,
      input: async (data) => {
        if (!subscriptionId) throw unavailable()
        await this.request('terminal.input', {
          subscriptionId,
          inputId: this.ports.crypto?.randomUUID() ?? crypto.randomUUID(),
          data,
        })
      },
      resize: async (cols, rows) => {
        if (!subscriptionId) throw unavailable()
        await this.request('terminal.resize', { subscriptionId, cols, rows })
      },
    }
  }
  acquireDetail(sessionId: string) {
    if (!sessionId.trim() || sessionId.length > 128)
      throw new Error('Invalid session')
    return this.details.acquire(sessionId)
  }
  async uploadArtifact(
    input: Parameters<EnvironmentClient['uploadArtifact']>[0],
  ): Promise<ArtifactRef> {
    if (!this.supervisor.isOpen()) throw unavailable()
    const received = this.ports.platform?.uploadArtifact
      ? await this.ports.platform.uploadArtifact(this.entry, input)
      : await this.http.json<ArtifactRef>(
          `/api/v2/artifacts?projectId=${encodeURIComponent(input.projectId)}&uploadId=${encodeURIComponent(input.uploadId)}`,
          {
            method: 'POST',
            headers: {
              'content-type': input.mimeType,
              'x-forge-file-name': encodeURIComponent(input.fileName),
            },
            body: input.body as BodyInit,
            signal: input.signal,
          },
        )
    const result = decodeEnvironmentValue(ArtifactRefSchema, received)
    if (!result)
      throw new EnvironmentRuntimeError(
        'PROTOCOL_MISMATCH',
        'Invalid artifact response',
      )
    return result
  }
  async artifactUrl(
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; release: () => void }> {
    if (this.ports.platform?.artifactUrl) {
      const asset = await this.ports.platform.artifactUrl(
        this.entry,
        artifactId,
        signal,
      )
      const release = () => {
        if (this.platformAssets.delete(release)) asset.release()
      }
      this.platformAssets.add(release)
      if (signal?.aborted) {
        release()
        throw new Error('Artifact request aborted')
      }
      return { url: asset.url, release }
    }
    const response = await this.http.fetch(
      `/api/v2/artifacts/${encodeURIComponent(artifactId)}`,
      { signal },
    )
    if (!response.ok)
      throw new Error(`Artifact request failed (${response.status})`)
    const blob = await response.blob()
    if (blob.size > 26214400) throw new Error('Artifact preview too large')
    const url = this.ports.createObjectUrl?.(blob) ?? URL.createObjectURL(blob)
    this.urls.add(url)
    return {
      url,
      release: () => {
        if (this.urls.delete(url))
          (this.ports.revokeObjectUrl ?? URL.revokeObjectURL)(url)
      },
    }
  }
  private now(): number {
    return this.ports.now?.() ?? Date.now()
  }
  private scheduleCache(): void {
    if (!this.cacheTimer)
      this.cacheTimer = setTimeout(() => {
        this.cacheTimer = null
        void this.flushCache()
      }, 1000)
  }
  async flushCache(): Promise<void> {
    if (this.cacheTimer) {
      clearTimeout(this.cacheTimer)
      this.cacheTimer = null
    }
    const record = this.http.deviceSession
      ? this.shell.snapshotRecord(
          this.environmentId,
          this.http.deviceSession.deviceSessionId,
        )
      : null
    if (
      record &&
      new TextEncoder().encode(JSON.stringify(record)).byteLength <= 4194304
    )
      this.cacheWrite = this.cacheWrite
        .catch(() => {})
        .then(() => this.ports.persistence.saveShell(record))
    await this.cacheWrite
  }
  private async clearProtectedCache(): Promise<void> {
    if (this.cacheTimer) {
      clearTimeout(this.cacheTimer)
      this.cacheTimer = null
    }
    this.shell.reset()
    this.details.purge()
    this.readCache.clear()
    await this.cacheWrite.catch(() => {})
    await this.ports.persistence.deleteShell(this.environmentId)
  }
  async purge(): Promise<void> {
    if (this.cacheTimer) {
      clearTimeout(this.cacheTimer)
      this.cacheTimer = null
    }
    this.shell.reset()
    this.details.purge()
    this.pending.clear()
    this.receipts.set(new Map())
    this.readCache.clear()
    for (const url of this.urls)
      (this.ports.revokeObjectUrl ?? URL.revokeObjectURL)(url)
    this.urls.clear()
    for (const release of this.platformAssets) release()
    await this.ports.credentials.delete(this.environmentId)
    await Promise.all([
      this.cacheWrite.catch(() => {}),
      this.pendingWrite.catch(() => {}),
    ])
    await (this.ports.persistence.purgeEnvironment?.(this.environmentId) ??
      this.ports.persistence.deleteShell(this.environmentId))
    // Main's clear wipes pending as well; do not recreate an encrypted empty journal after clear.
    if (!this.ports.persistence.purgeEnvironment) await this.persistPending()
  }
  async dispose(): Promise<void> {
    this.supervisor.dispose()
    this.detachConnection()
    this.details.dispose()
    this.shell.flush()
    await this.flushCache()
    for (const url of this.urls)
      (this.ports.revokeObjectUrl ?? URL.revokeObjectURL)(url)
    this.urls.clear()
    for (const release of this.platformAssets) release()
  }
}
