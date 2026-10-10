import { randomUUID, webcrypto } from 'node:crypto'
import type { ChoiceAnswer, CliAgentShowResponse, CliAgentsListResponse, CliChoiceRouteResult, CliChoiceShowResponse, CliChoicesListResponse, CliHttpErrorResponse, CliMessageDispatchResult, CliProfileShowResponse, CliProfilesListResponse, CliProjectAgentShowResponse, CliProjectAgentsListResponse, CliRunResult, CliSessionCompactionResult, CliSessionCreatedResult, CliSessionShowResponse, CliSessionsListResponse, CliSessionTranscriptResponse, CliStatusResponse } from '@forge/protocol'
import type { CommandReceipt, RpcInput } from '@forge/protocol/environment-v2'
import { createEnvironmentRegistry, createMemoryCredentialStore, createMemoryPersistence, EnvironmentRuntimeError, type EnvironmentClient } from '../../client-runtime/src/index.js'
import { WebSocket } from 'ws'
import { CliError } from './output.js'
import { CLI_PROTOCOL_VERSION, EXIT_CODES } from './version.js'
import { validateCliCredential, type CliEnvironmentCredential } from './commands/pair.js'
import { NativeRunWaitTracker } from './run-wait-tracker.js'

export type ForgeClientOptions = ({ credential: CliEnvironmentCredential; url?: never; apiKey?: never } | { url: string; apiKey: string; credential?: never }) & { fetchImpl?: typeof fetch; WebSocketImpl?: typeof WebSocket }
export interface ChoiceListFilters {
  profileId?: string
  sessionAgentId?: string
}

export type ClientRunTarget =
  | { kind: 'new_session'; profileId: string; label?: string; name?: string }
  | { kind: 'session'; agentId: string }
  | { kind: 'project_agent'; profileId: string; handle: string }

export interface ClientMessageOptions {
  text: string
  delivery?: 'auto' | 'followUp' | 'steer'
}

export interface ClientCreateSessionOptions {
  profileId: string
  label?: string
  name?: string
  invocationCwd?: string
}

export interface ClientRunOptions extends ClientMessageOptions {
  target: ClientRunTarget
  label?: string
  invocationCwd?: string
  timeoutMs?: number
  stopOnTimeout?: boolean
  command: 'run' | 'launch'
}

export interface ClientWaitOptions {
  timeoutMs?: number
  stopOnTimeout?: boolean
}

export interface ClientCompactionOptions {
  customInstructions?: string
}

export interface ClientSessionTranscriptOptions {
  includeWorkerUpdates?: boolean
  limit?: number
  offset?: number
}

export interface ForgeClientLike {
  getStatus(): Promise<CliStatusResponse>
  listProfiles(): Promise<CliProfilesListResponse>
  showProfile(profileId: string): Promise<CliProfileShowResponse>
  listSessions(profileId: string): Promise<CliSessionsListResponse>
  showSession(agentId: string): Promise<CliSessionShowResponse>
  getSessionTranscript(agentId: string, options?: ClientSessionTranscriptOptions): Promise<CliSessionTranscriptResponse>
  listAgents(profileId?: string): Promise<CliAgentsListResponse>
  showAgent(agentId: string): Promise<CliAgentShowResponse>
  listProjectAgents(profileId: string): Promise<CliProjectAgentsListResponse>
  showProjectAgent(profileId: string, handle: string): Promise<CliProjectAgentShowResponse>
  listChoices(filters?: ChoiceListFilters): Promise<CliChoicesListResponse>
  showChoice(choiceId: string, sessionAgentId?: string): Promise<CliChoiceShowResponse>
  createSession(options: ClientCreateSessionOptions): Promise<CliSessionCreatedResult>
  sendSessionMessage(agentId: string, options: ClientMessageOptions): Promise<CliMessageDispatchResult>
  sendProjectAgentMessage(profileId: string, handle: string, options: ClientMessageOptions): Promise<CliMessageDispatchResult>
  launch(options: ClientRunOptions): Promise<CliMessageDispatchResult>
  run(options: ClientRunOptions): Promise<CliRunResult>
  waitForSession(agentId: string, options?: ClientWaitOptions): Promise<CliRunResult>
  stopSession(agentId: string): Promise<unknown>
  resumeSession(agentId: string): Promise<unknown>
  clearSession(agentId: string): Promise<unknown>
  deleteSession(agentId: string): Promise<unknown>
  renameSession(agentId: string, label: string): Promise<unknown>
  pinSession(agentId: string, pinned: boolean): Promise<unknown>
  forkSession(sourceAgentId: string, options?: { label?: string; fromMessageId?: string }): Promise<unknown>
  compactSession(agentId: string, options?: ClientCompactionOptions): Promise<CliSessionCompactionResult>
  smartCompactSession(agentId: string, options?: ClientCompactionOptions): Promise<CliSessionCompactionResult>
  answerChoice(choiceId: string, answers: ChoiceAnswer[], sessionAgentId?: string): Promise<CliChoiceRouteResult>
  cancelChoice(choiceId: string, sessionAgentId?: string): Promise<CliChoiceRouteResult>
}

export class ForgeClient implements ForgeClientLike {
  private readonly baseUrl: URL
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly WebSocketImpl: typeof WebSocket
  private readonly credential?: CliEnvironmentCredential
  constructor(options: ForgeClientOptions) {
    this.credential = options.credential
    if (this.credential) validateCliCredential(this.credential)
    this.baseUrl = normalizeBaseUrl(options.credential?.baseUrl ?? options.url!)
    this.token = options.credential?.bearerToken ?? options.apiKey!
    this.fetchImpl = options.fetchImpl ?? fetch
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket
  }
  getStatus(): Promise<CliStatusResponse> {
    return this.get('status')
  }

  listProfiles(): Promise<CliProfilesListResponse> {
    return this.get('profiles')
  }

  showProfile(profileId: string): Promise<CliProfileShowResponse> {
    return this.get(`profiles/${encodeURIComponent(profileId)}`)
  }

  listSessions(profileId: string): Promise<CliSessionsListResponse> {
    return this.get(`sessions?profileId=${encodeURIComponent(profileId)}`)
  }

  showSession(agentId: string): Promise<CliSessionShowResponse> {
    return this.get(`sessions/${encodeURIComponent(agentId)}`)
  }

  async getSessionTranscript(
    agentId: string,
    options: ClientSessionTranscriptOptions = {},
  ): Promise<CliSessionTranscriptResponse> {
    const params = new URLSearchParams()
    if (options.includeWorkerUpdates) params.set('includeWorkerUpdates', 'true')
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.offset !== undefined) params.set('offset', String(options.offset))
    const query = params.size > 0 ? `?${params.toString()}` : ''
    return this.get(`sessions/${encodeURIComponent(agentId)}/transcript${query}`)
  }

  listAgents(profileId?: string): Promise<CliAgentsListResponse> {
    const query = profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''
    return this.get(`agents${query}`)
  }

  showAgent(agentId: string): Promise<CliAgentShowResponse> {
    return this.get(`agents/${encodeURIComponent(agentId)}`)
  }

  listProjectAgents(profileId: string): Promise<CliProjectAgentsListResponse> {
    return this.get(`project-agents?profileId=${encodeURIComponent(profileId)}`)
  }

  showProjectAgent(profileId: string, handle: string): Promise<CliProjectAgentShowResponse> {
    return this.get(`project-agents/${encodeURIComponent(handle)}?profileId=${encodeURIComponent(profileId)}`)
  }

  listChoices(filters: ChoiceListFilters = {}): Promise<CliChoicesListResponse> {
    const params = new URLSearchParams()
    if (filters.sessionAgentId) params.set('sessionAgentId', filters.sessionAgentId)
    if (filters.profileId) params.set('profileId', filters.profileId)
    const query = params.size > 0 ? `?${params.toString()}` : ''
    return this.get(`choices${query}`)
  }

  showChoice(choiceId: string, sessionAgentId?: string): Promise<CliChoiceShowResponse> {
    const query = sessionAgentId ? `?sessionAgentId=${encodeURIComponent(sessionAgentId)}` : ''
    return this.get(`choices/${encodeURIComponent(choiceId)}${query}`)
  }

  async createSession(options: ClientCreateSessionOptions): Promise<CliSessionCreatedResult> {
    return this.withEnvironment(client => this.create(client, options, 'sessions create'))
  }
  private async create(client: EnvironmentClient, options: ClientCreateSessionOptions, command: 'run' | 'launch' | 'sessions create'): Promise<CliSessionCreatedResult> {
    const cli = { createdBy: 'forge-cli' as const, runId: randomUUID(), command, startedAt: new Date().toISOString(), ...(options.invocationCwd ? { invocationCwd: options.invocationCwd } : {}), ...(options.label ? { label: options.label } : {}) }
    const receipt = await this.control(client, 'session.launch', { commandId: randomUUID(), projectId: options.profileId, title: options.label ?? options.name ?? 'CLI session', workspaceStrategy: { kind: 'current_checkout' }, cli })
    if (!receipt.sessionId) throw new CliError('Session preparation did not return an identity.', { exitCode: EXIT_CODES.connection, code: 'missing_session' })
    const [session, profile] = await Promise.all([this.showSession(receipt.sessionId), this.showProfile(options.profileId)])
    return { session: session.session, profile: profile.profile, cli }
  }
  async sendSessionMessage(agentId: string, options: ClientMessageOptions): Promise<CliMessageDispatchResult> {
    return this.withEnvironment(client => this.send(client, agentId, options))
  }
  async sendProjectAgentMessage(profileId: string, handle: string, options: ClientMessageOptions): Promise<CliMessageDispatchResult> {
    return this.withEnvironment(async client => {
      const target = await this.resolveTarget(client, { kind: 'project_agent', profileId, handle })
      return this.send(client, target.sessionId, options)
    })
  }
  private async send(client: EnvironmentClient, sessionId: string, options: ClientMessageOptions, messageId: string = randomUUID()): Promise<CliMessageDispatchResult> {
    const receipt = await this.control(client, 'session.send', { commandId: messageId, sessionId, message: { text: options.text, artifactIds: [] }, source: { channel: 'cli', messageId }, ...(options.delivery ? { delivery: options.delivery } : {}) })
    return { sessionAgentId: sessionId, profileId: client.shell.getSnapshot().sessions.get(sessionId)?.projectId ?? (await this.showSession(sessionId)).session.profileId, messageId, sourceContext: { channel: 'cli', messageId }, acceptedAt: receipt.acceptedAt }
  }
  async launch(options: ClientRunOptions): Promise<CliMessageDispatchResult> {
    return this.withEnvironment(async client => {
      const target = await this.resolveRunTarget(client, options)
      return this.send(client, target.sessionId, options, target.messageId)
    })
  }
  async run(options: ClientRunOptions): Promise<CliRunResult> {
    const startedAt = Date.now()
    return this.withEnvironment(async client => {
      const target = await this.resolveRunTarget(client, options)
      const tracker = new NativeRunWaitTracker(client, target.sessionId, { ...options, startedAt, requirePostDispatch: true, projectAgentHandle: options.target.kind === 'project_agent' ? options.target.handle : null })
      try {
        await tracker.ready()
        tracker.dispatched()
        await this.send(client, target.sessionId, options, target.messageId)
        const result = await tracker.wait()
        if (result.status === 'timeout' && options.stopOnTimeout) await this.control(client, 'session.stop', { commandId: randomUUID(), sessionId: target.sessionId })
        return this.completeRunResult(result)
      } finally { tracker.dispose() }
    })
  }
  async waitForSession(agentId: string, options: ClientWaitOptions = {}): Promise<CliRunResult> {
    const startedAt = Date.now()
    return this.withEnvironment(async client => {
      const tracker = new NativeRunWaitTracker(client, agentId, { ...options, startedAt, requirePostDispatch: false })
      try {
        await tracker.ready()
        const result = await tracker.wait()
        if (result.status === 'timeout' && options.stopOnTimeout) await this.control(client, 'session.stop', { commandId: randomUUID(), sessionId: agentId })
        return this.completeRunResult(result)
      } finally { tracker.dispose() }
    })
  }
  private async completeRunResult(result: CliRunResult): Promise<CliRunResult> {
    if (result.blocked) result.blocked.choices = await Promise.all(result.blocked.choices.map(async choice => (await this.showChoice(choice.choiceId, result.sessionAgentId)).choice))
    return result
  }
  private async resolveTarget(client: EnvironmentClient, target: Exclude<ClientRunTarget, { kind: 'new_session' }>) {
    const sessionId = target.kind === 'session' ? target.agentId : (await this.showProjectAgent(target.profileId, target.handle)).projectAgent.agentId
    // Resolve only through this selected environment's authenticated read path.
    const descriptor = (await this.showSession(sessionId)).session
    if (target.kind === 'project_agent' && descriptor.profileId !== target.profileId && !(await this.listProjectAgents(target.profileId)).projectAgents.some(agent => agent.agentId === sessionId)) throw new CliError('Project Agent is unavailable in this environment project.', { exitCode: EXIT_CODES.usage, code: 'not_found' })
    return { environmentId: client.environmentId, sessionId }
  }
  private async resolveRunTarget(client: EnvironmentClient, options: ClientRunOptions) {
    if (options.target.kind !== 'new_session') return { ...await this.resolveTarget(client, options.target), messageId: randomUUID() }
    const created = await this.create(client, { profileId: options.target.profileId, label: options.target.label, name: options.target.name, invocationCwd: options.invocationCwd }, options.command)
    return { environmentId: client.environmentId, sessionId: created.session.agentId, messageId: created.cli!.runId }
  }
  stopSession(agentId: string): Promise<unknown> { return this.action('session.stop', agentId) }
  resumeSession(agentId: string): Promise<unknown> { return this.action('session.resume', agentId) }
  clearSession(agentId: string): Promise<unknown> { return this.action('session.clear', agentId) }
  deleteSession(agentId: string): Promise<unknown> { return this.action('session.delete', agentId) }
  private async action(method: 'session.stop' | 'session.resume' | 'session.clear' | 'session.delete', agentId: string): Promise<unknown> {
    return this.withEnvironment(async client => {
      await this.showSession(agentId)
      const receipt = await this.control(client, method, { commandId: randomUUID(), sessionId: agentId })
      if (method === 'session.clear') return { agentId }
      return { agentId, ...(method === 'session.stop' || method === 'session.delete' ? { terminatedWorkerIds: receipt.result?.terminatedWorkerIds ?? [] } : {}) }
    })
  }
  renameSession(agentId: string, label: string): Promise<unknown> { return this.updateSession(agentId, { title: label }) }
  pinSession(agentId: string, pinned: boolean): Promise<unknown> { return this.updateSession(agentId, { pinned }) }
  private async updateSession(agentId: string, patch: { title?: string; pinned?: boolean }): Promise<unknown> {
    return this.withEnvironment(async client => {
      await this.control(client, 'session.update', { commandId: randomUUID(), sessionId: agentId, ...patch })
      const session = (await this.showSession(agentId)).session
      return { agentId, ...(patch.title !== undefined ? { label: patch.title } : { pinned: patch.pinned, pinnedAt: session.pinnedAt ?? null }) }
    })
  }
  async forkSession(sourceAgentId: string, options: { label?: string; fromMessageId?: string } = {}): Promise<unknown> {
    return this.withEnvironment(async client => {
      const receipt = await this.control(client, 'session.fork', { commandId: randomUUID(), sessionId: sourceAgentId, ...(options.label ? { title: options.label } : {}), ...(options.fromMessageId ? { fromItemId: options.fromMessageId } : {}) })
      const sessionId = receipt.result?.sessionId ?? receipt.sessionId!
      const created = await this.showSession(sessionId)
      return { sourceAgentId, session: created.session, profile: (await this.showProfile(created.session.profileId!)).profile, ...(options.fromMessageId ? { fromMessageId: options.fromMessageId } : {}) }
    })
  }
  compactSession(agentId: string, options: ClientCompactionOptions = {}): Promise<CliSessionCompactionResult> { return this.compact(agentId, 'manual', options) }
  smartCompactSession(agentId: string, options: ClientCompactionOptions = {}): Promise<CliSessionCompactionResult> { return this.compact(agentId, 'smart', options) }
  private async compact(agentId: string, mode: 'manual' | 'smart', options: ClientCompactionOptions): Promise<CliSessionCompactionResult> {
    return this.withEnvironment(async client => {
      const customInstructions = options.customInstructions?.trim() || undefined
      const receipt = await this.control(client, 'session.compact', { commandId: randomUUID(), sessionId: agentId, mode, source: 'cli', ...(customInstructions ? { customInstructions } : {}) })
      const compacted = receipt.result?.compacted ?? true
      const reason = receipt.result?.reason
      const skipped = reason === 'claude_runtime_below_compaction_threshold' || reason === 'claude_runtime_context_usage_unknown' || reason === 'runtime_already_compacted'
      return { action: mode === 'manual' ? 'compact' : 'smart_compact', sessionAgentId: agentId, profileId: (await this.showSession(agentId)).session.profileId, outcome: compacted ? 'compacted' : skipped ? 'skipped' : 'not_reduced', compacted, ...(!compacted && reason ? { reason } : {}), customInstructionsProvided: !!customInstructions, completedAt: receipt.updatedAt }
    })
  }
  async answerChoice(choiceId: string, answers: ChoiceAnswer[], sessionAgentId?: string): Promise<CliChoiceRouteResult> {
    return this.withEnvironment(async client => {
      const owner = (await this.showChoice(choiceId, sessionAgentId)).choice
      await this.control(client, 'session.choose', { commandId: randomUUID(), sessionId: owner.sessionAgentId, choiceId, answers })
      return { choiceId, sessionAgentId: owner.sessionAgentId, status: 'answered' }
    })
  }
  async cancelChoice(choiceId: string, sessionAgentId?: string): Promise<CliChoiceRouteResult> {
    return this.withEnvironment(async client => {
      const owner = (await this.showChoice(choiceId, sessionAgentId)).choice
      await this.control(client, 'session.choice.cancel', { commandId: randomUUID(), sessionId: owner.sessionAgentId, choiceId })
      return { choiceId, sessionAgentId: owner.sessionAgentId, status: 'cancelled' }
    })
  }
  private async withEnvironment<T>(operation: (client: EnvironmentClient) => Promise<T>): Promise<T> {
    if (!this.credential) throw new CliError('Session controls require paired environment credentials. Run forge pair and select --environment-id or --credential-file. API keys continue to support CLI HTTP reads.', { exitCode: EXIT_CODES.unsupported, code: 'pairing_required' })
    const credentials = createMemoryCredentialStore()
    await credentials.store(this.credential.environmentId, this.credential)
    const registry = createEnvironmentRegistry({ persistence: createMemoryPersistence(), credentials, fetch: (url, init) => this.fetchImpl(url, init), webSocket: (url, protocols) => new this.WebSocketImpl(url, protocols), crypto: webcrypto as unknown as Crypto, random: () => 0.01 })
    try {
      await registry.register({ environmentId: this.credential.environmentId, baseUrl: this.baseUrl.origin, primary: true, enabled: true, credentialRef: this.credential.deviceSessionId, labelOverride: null })
      await registry.start()
      const client = registry.get(this.credential.environmentId)
      await this.online(client)
      if (!client.descriptor()?.capabilities.cliTransport) throw new CliError('Update this environment to use the paired CLI transport.', { exitCode: EXIT_CODES.unsupported, code: 'unsupported_capability' })
      return await operation(client)
    } catch (error) { throw this.cliError(error) }
    finally { await registry.dispose() }
  }
  private async online(client: EnvironmentClient): Promise<void> {
    const deadline = Date.now() + 10_000
    while (client.connection.getSnapshot().phase !== 'online') {
      const state = client.connection.getSnapshot()
      if (state.phase.endsWith('blocked')) throw new CliError(state.reason ?? 'Environment connection blocked.', { exitCode: state.phase === 'auth-blocked' || state.phase === 'identity-blocked' ? EXIT_CODES.auth : EXIT_CODES.unsupported, code: state.blockedCause ?? state.phase })
      if (Date.now() > deadline) throw new CliError('Could not connect to the paired environment.', { exitCode: EXIT_CODES.connection, code: 'connection_failed' })
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  private async control<M extends CommandReceipt['method']>(client: EnvironmentClient, method: M, input: RpcInput<M>): Promise<CommandReceipt> {
    const commandId = (input as { commandId: string }).commandId
    const deadline = Date.now() + 10_000
    let receipt: CommandReceipt | undefined
    try { receipt = await client.request(method, input, { signal: AbortSignal.timeout(10_000) }) }
    catch (error) {
      if (!(error instanceof EnvironmentRuntimeError) || !error.retryable) throw error
      await this.online(client)
      try { receipt = await client.request('command.get', { commandId }) }
      catch (lookup) {
        if (!(lookup instanceof EnvironmentRuntimeError) || lookup.code !== 'NOT_FOUND') throw lookup
        // Receipt recovery may already be retrying; both producers use the same ID.
        receipt = await client.request(method, input, { signal: AbortSignal.timeout(10_000) })
      }
    }
    while (receipt.state === 'accepted' || receipt.state === 'running') {
      if (Date.now() >= deadline) throw new CliError(`Command ${commandId} was accepted and is still pending.`, { exitCode: EXIT_CODES.connection, code: 'command_pending', details: { commandId } })
      await new Promise(resolve => setTimeout(resolve, 25))
      receipt = await client.request('command.get', { commandId })
    }
    if (receipt.state !== 'succeeded') throw new EnvironmentRuntimeError(receipt.error?.code ?? 'UNAVAILABLE', receipt.error?.message ?? `Command ${commandId} was interrupted; inspect its receipt before sending a new command.`, false)
    return receipt
  }
  private cliError(error: unknown): CliError {
    if (error instanceof CliError) return error
    const fault = error as { code?: string; message?: string }
    const code = fault.code ?? 'connection_failed'
    return new CliError(redactSecret(fault.message ?? 'Environment request failed.', this.token), { code, exitCode: code === 'UNAUTHENTICATED' || code === 'FORBIDDEN' || code === 'IDENTITY_MISMATCH' ? EXIT_CODES.auth : code === 'INVALID_INPUT' || code === 'NOT_FOUND' || code === 'CONFLICT' ? EXIT_CODES.usage : code === 'PROTOCOL_MISMATCH' ? EXIT_CODES.unsupported : EXIT_CODES.connection })
  }
  private async verifyIdentity(): Promise<void> {
    if (!this.credential) return
    const response = await this.fetchImpl(new URL('/api/v2/environment', this.baseUrl), { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new CliError('Environment descriptor is unavailable.', { exitCode: EXIT_CODES.connection, code: 'connection_failed' })
    const descriptor = await response.json() as { environmentId: string; protocolVersion: number }
    if (descriptor.environmentId !== this.credential.environmentId) throw new CliError('Environment identity mismatch; explicitly pair the new environment.', { exitCode: EXIT_CODES.auth, code: 'identity_mismatch' })
    if (descriptor.protocolVersion !== 1) throw new CliError('Environment protocol mismatch.', { exitCode: EXIT_CODES.unsupported, code: 'unsupported_protocol' })
  }
  private async get<T>(path: string): Promise<T> {
    await this.verifyIdentity()
    const url = new URL(`/api/cli/${path}`, this.baseUrl)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
        },
      })
    } catch (error) {
      throw new CliError(`Could not connect to Forge at ${this.baseUrl.origin}: ${redactSecret(errorMessage(error), this.token)}`, {
        exitCode: EXIT_CODES.connection,
        code: 'connection_failed',
      })
    }

    if (!response.ok) {
      const errorPayload = await readErrorPayload(response)
      const message = errorPayload?.error.message ?? `Forge request failed with HTTP ${response.status}`
      const code = errorPayload?.error.code ?? `http_${response.status}`
      throw new CliError(redactSecret(message, this.token), {
        exitCode: mapHttpErrorExitCode(response.status, code),
        code,
        details: { status: response.status },
      })
    }

    try {
      return (await response.json()) as T
    } catch (error) {
      throw new CliError(`Forge returned invalid JSON: ${errorMessage(error)}`, {
        exitCode: EXIT_CODES.connection,
        code: 'invalid_json',
      })
    }
  }
}

export function assertSupportedCapabilities(response: CliStatusResponse): void {
  const capabilities = response.capabilities
  if (!capabilities.available) {
    throw new CliError('Forge CLI API is not available on this server.', {
      exitCode: EXIT_CODES.unsupported,
      code: 'cli_unavailable',
    })
  }
  if (capabilities.protocolVersion !== CLI_PROTOCOL_VERSION) {
    throw new CliError(`Unsupported Forge CLI protocol version: ${capabilities.protocolVersion}`, {
      exitCode: EXIT_CODES.unsupported,
      code: 'unsupported_protocol',
    })
  }
  if (!capabilities.features.bearerAuth) {
    throw new CliError('Forge server does not advertise CLI bearer authentication.', {
      exitCode: EXIT_CODES.unsupported,
      code: 'missing_bearer_auth',
    })
  }
}

export function normalizeBaseUrl(value: string): URL {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new CliError('Forge URL is required.', { exitCode: EXIT_CODES.usage, code: 'missing_url' })
  }

  const httpUrl = trimmed.startsWith('ws://')
    ? `http://${trimmed.slice('ws://'.length)}`
    : trimmed.startsWith('wss://')
      ? `https://${trimmed.slice('wss://'.length)}`
      : trimmed

  try {
    const url = new URL(httpUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`unsupported protocol ${url.protocol}`)
    }
    return url
  } catch (error) {
    throw new CliError(`Invalid Forge URL: ${errorMessage(error)}`, { exitCode: EXIT_CODES.usage, code: 'invalid_url' })
  }
}

async function readErrorPayload(response: Response): Promise<CliHttpErrorResponse | null> {
  try { return await response.json() as CliHttpErrorResponse } catch { return null }
}
function mapHttpErrorExitCode(status: number, code: string) {
  if (status === 401 || isAuthErrorCode(code)) return EXIT_CODES.auth
  if (status >= 400 && status < 500) return EXIT_CODES.usage
  return EXIT_CODES.connection
}

function redactSecret(message: string, secret: string): string {
  if (!secret) return message
  return message.split(secret).join('<redacted>')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAuthErrorCode(code: string): boolean { return ['unauthorized', 'forbidden', 'invalid_api_key', 'missing_api_key', 'revoked_api_key'].includes(code) }
