import { projectPanelRevealRequest } from './ws-client/browser-state'
import { projectFeatureEvent } from './ws-client/environment-feature-projection'
import type { RpcInput, RpcOutput } from '@forge/protocol/environment-v2'
import { EnvironmentRuntimeError, isInterruptedReceipt, type EnvironmentClient, type DetailState } from '@forge/client-runtime'
import {
  projectShell,
  projectSession,
  projectDetailMessages,
  projectDetailActivity,
  projectItems,
  projectActivityItems,
  projectWorker,
  projectSessionWorkers,
} from './ws-client/environment-projection'
import { getCatalogModelsByFamily } from '@forge/protocol'
import type { CommandReceipt } from '@forge/protocol/environment-v2'
import { environmentCommandIntentKey, sendEnvironmentCommand } from './ws-client/environment-command-transport'
import { EnvironmentOutbox } from './ws-client/environment-outbox'
import type { CodexElicitationDecision, CodexElicitationPersistScope, SessionGoalControlAction, SessionProjectAgentInput, WorkModeId } from '@forge/protocol'
import type { ConversationSnapshotCache } from './ws-client/conversation-snapshot-cache'
import {
  conversationBootstrapMetrics,
  type ConversationSubscriptionReason,
} from './ws-client/conversation-bootstrap-metrics'
import { handleManagerIdleTransition, removeMutedAgent } from './notification-service'
import {
  assertConnectedSocket,
  assertReconnectableSocket,
  buildChoiceResponseCommand,
  buildCreateSessionCommand,
  buildGetConversationPageCommand,
  buildGetSessionWorkersCommand,
  buildSubscribeCommand,
  buildUserMessageCommand,
  isSocketOpen,
  RECONNECTING_SOCKET_ERROR,
} from './ws-client/request-definitions'
import { WebSocketTransport } from './ws-client/websocket-transport'
import { BootstrapBuffer } from './ws-client/bootstrap-buffer'
import { SessionWorkerCache } from './ws-client/session-worker-cache'
import { applyLoadedModelCacheVisualizationSetting as reduceLoadedModelCacheVisualizationSetting } from './ws-client/model-cache-visualization-state'
import {
  INITIAL_CONNECT_DELAY_MS,
  RECONNECT_MS,
  SESSION_WORKERS_REQUEST_TIMEOUT_MS,
  CONVERSATION_PAGE_REQUEST_TIMEOUT_MS,
} from './ws-client/runtime-types'

export const CONVERSATION_BOOTSTRAP_WATCHDOG_MS = 30_000
const GENERATION_TERMINAL_SETTLE_MS = 5_000
const MAX_DEFERRED_WORKER_THROUGHPUT_EVENTS = 64

/** Server close code for a permanently invalidated collaboration session. */
const SESSION_INVALIDATED_CLOSE_CODE = 4001

/** How long an optimistic send may wait for its server echo before expiring. */
const OPTIMISTIC_SEND_EXPIRY_MS = 20_000

function generateClientRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // fall through
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
import {
  reduceAgentStatus,
  reduceAgentsSnapshot,
  reduceSessionDeleted,
} from './ws-client/snapshot-reducers'
import {
  clearGenerationThroughputForAgents,
  clearGenerationThroughputState,
  pendingGenerationThroughputWorkerMetadataSessionId,
  removeGenerationThroughputTombstone,
  type GenerationThroughputReduction,
} from './ws-client/generation-throughput-state'
import type {
  DirectoriesListedResult,
  DirectoryCreatedResult,
  DirectoryValidationResult,
  Listener,
  ProjectAgentConfigResult,
  ProjectAgentExternalDirectoryResult,
  ProjectAgentReferenceDeletedResult,
  ProjectAgentReferenceResult,
  ProjectAgentReferencesResult,
  ProjectAgentReferenceSavedResult,
  ProjectAgentSharingResult,
  ProjectAgentSharingUpdatedResult,
  ProfileArchiveResult,
  ProfileRestoreResult,
  SessionActionResult,
  SessionArchiveResult,
  SessionCreatedResult,
  SessionForkedResult,
  SessionProjectAgentResult,
  SessionRestoreResult,
  SessionWorkersResult,
  ConversationPageResult,
} from './ws-client/types'
import { createSystemConversationMessage, normalizeAgentId, normalizeConversationAttachments, resolveTerminalScopeAgentId } from './ws-client/utils'
import { RequestDispatcher } from './ws-client/request-dispatcher'
import {
  createInitialManagerWsState,
  type ManagerWsState,
} from './ws-state'
import {
  applySecureSessionSnapshot as reduceSecureSessionSnapshot,
  handleConversationEvent,
} from './ws-client/event-handlers/conversation-event-handlers'
import { handleTerminalEvent } from './ws-client/event-handlers/terminal-event-handlers'
import { handleAgentEvent } from './ws-client/event-handlers/agent-event-handlers'
import { handleGenerationThroughputEvent } from './ws-client/event-handlers/generation-throughput-event-handlers'
import { handleSessionEvent } from './ws-client/event-handlers/session-event-handlers'
import { handleSessionAttentionEvent } from './ws-client/event-handlers/session-attention-event-handlers'
import { handleConfigEvent } from './ws-client/event-handlers/config-event-handlers'
import { handleSystemEvent } from './ws-client/event-handlers/system-event-handlers'
import type {
  AgentDescriptor,
  AgentSessionPurpose,
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostLifecycleRequest,
  BrowserHostLifecycleResponse,
  BrowserHostRegistration,
  BrowserHostSessionStateReport,
  BrowserHostStateReportResult,
  BrowserSessionSnapshot,
  BrowserViewportSetting,
  BuilderTimelineChannelView,
  ChoiceAnswer,
  ClientCommand,
  ConversationAttachment,
  ConversationReplyTargetInput,
  DeliveryMode,
  ManagerExactModelSelection,
  ManagerModelPreset,
  ManagerReasoningLevel,
  ServerEvent,
  SecureSessionSnapshot,
  SessionAttentionUpdateEvent,
} from '@forge/protocol'

export type { ManagerWsState } from './ws-state'
export type {
  DirectoriesListedResult,
  DirectoryCreatedResult,
  DirectoryValidationResult,
  ProjectAgentConfigResult,
  ProjectAgentReferenceDeletedResult,
  ProjectAgentReferenceResult,
  ProjectAgentReferencesResult,
  ProjectAgentReferenceSavedResult,
} from './ws-client/types'

export interface ManagerWsClientOptions {
  environmentClient?: EnvironmentClient
  socketless?: boolean
  originId?: string
  conversationSnapshotCache?: ConversationSnapshotCache
  conversationBootstrapWatchdogMs?: number
}

export class ManagerWsClient {
  private readonly transport: WebSocketTransport | null
  private readonly environmentClient?: EnvironmentClient
  private readonly environmentDetach: Array<() => void> = []
  private detailLease: ReturnType<EnvironmentClient['acquireDetail']> | null =
    null
  private detailDetach: (() => void) | null = null
  /** User-message submits on the environment path; null for legacy transports. */
  private readonly outbox: EnvironmentOutbox | null = null
  /** Command ID per receipt-backed intent (launch/stop/choice) until the server returns its receipt. */
  private readonly intentCommandIds = new Map<string, string>()
  /** Command IDs currently echoed locally in `messages` before the projection shows them. */
  private outboxEchoIds = new Set<string>()
  private environmentProjection: DetailState['projection'] = null
  private desiredAgentId: string | null
  private conversationView: BuilderTimelineChannelView = 'web'
  private readonly originId: string
  private readonly conversationSnapshotCache?: ConversationSnapshotCache
  private readonly conversationBootstrapWatchdogMs: number
  private conversationBootstrapTimer: ReturnType<typeof setTimeout> | null = null
  private stalePresentationAttachedAt: number | null = null
  private readonly subscriptionIdPrefix = generateClientRequestId()
  private nextSubscriptionId = 1
  /** Bounded metric guard: only the current/most-recent subscription can terminal twice. */
  private terminalSubscriptionId: string | null = null
  /** Destructive requests suppress recapture until fresh history replaces authority. */
  private readonly nonCapturableConversationAgentIds = new Set<string>()

  /** Convenience accessor — delegates to transport so existing guards work unchanged. */
  private get socket(): WebSocket | null {
    if (this.environmentClient)
      return {
        readyState: this.environmentClient.connection.getSnapshot()
          .transportHealthy
          ? 1
          : 3,
      } as WebSocket
    return this.transport?.getSocket() ?? null
  }

  private hasExplicitAgentSelection = false
  private explicitAgentSelectionAgentId: string | null = null
  private explicitAgentSelectionPending = false
  private rejectedExplicitAgentSelectionId: string | null = null
  private sessionInvalidatedObserver: (() => void) | null = null
  private readonly optimisticSendExpiryTimers = new Set<ReturnType<typeof setTimeout>>()
  private readonly generationTerminalCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Worker telemetry that arrived before this connection received its roster. */
  private deferredWorkerThroughputEvents: Array<Extract<ServerEvent, {
    type: 'generation_throughput' | 'generation_throughput_snapshot'
  }>> = []

  private state: ManagerWsState
  private readonly listeners = new Set<Listener>()

  private readonly requestDispatcher: RequestDispatcher
  private readonly bootstrapBuffer: BootstrapBuffer
  private readonly sessionWorkerCache: SessionWorkerCache
  private browserHostRegistration: BrowserHostRegistration | null = null
  private browserHostDetach: (() => void) | null = null

  constructor(url: string, initialAgentId?: string | null, options: ManagerWsClientOptions = {},
  ) {
    const normalizedInitialAgentId = normalizeAgentId(initialAgentId)
    this.desiredAgentId = normalizedInitialAgentId
    this.environmentClient = options.environmentClient
    this.originId =
      options.environmentClient?.environmentId ?? options.originId ??
      'unregistered'
    this.conversationSnapshotCache = options.conversationSnapshotCache
    this.conversationBootstrapWatchdogMs = options.conversationBootstrapWatchdogMs ?? CONVERSATION_BOOTSTRAP_WATCHDOG_MS
    this.state = createInitialManagerWsState(normalizedInitialAgentId)

    this.requestDispatcher = new RequestDispatcher({
      send: (command) => this.send(command),
    })

    this.bootstrapBuffer = new BootstrapBuffer({
      getState: () => this.state,
      updateState: (patch) => this.updateState(patch),
      applyConversationEvent: handleConversationEvent,
    })

    this.sessionWorkerCache = new SessionWorkerCache({
      getState: () => this.state,
      updateState: (patch) => this.updateState(patch),
      onWorkersRemoved: (agentIds) => this.clearGenerationThroughputForAgents(agentIds),
      requestSessionWorkers: (sessionAgentId) => {
        // Environment sessions receive workers on their detail stream; there is no separate fetch.
        if (this.environmentClient)
          return Promise.resolve({
            sessionAgentId,
            workers: this.state.agents.filter((agent) => agent.role === 'worker' && agent.managerId === sessionAgentId),
          })
        assertConnectedSocket(this.socket)
        // Short timeout: a lost response must not hold the cache's in-flight
        // dedupe for the full default request timeout — the cache retries with
        // backoff on failure.
        return this.requestDispatcher.enqueueRequest(
          'get_session_workers',
          (requestId) => buildGetSessionWorkersCommand(sessionAgentId, requestId),
          { timeoutMs: SESSION_WORKERS_REQUEST_TIMEOUT_MS },
        )
      },
    })

    this.transport =
      options.environmentClient || options.socketless
        ? null
        : new WebSocketTransport({
      url,
      reconnectDelayMs: RECONNECT_MS,
      onOpen: () => this.handleTransportOpen(),
      onClose: (event) => this.handleTransportClose(event),
      onMessage: (data) => this.handleServerEvent(data),
      onError: () => this.handleTransportError(),
    })
    if (this.environmentClient) {
      const client = this.environmentClient
      this.outbox = new EnvironmentOutbox(client, () => this.refreshEnvironmentCommands())
      this.environmentDetach.push(
        client.receipts.subscribe((receipts) => receipts, () => {
          this.outbox?.settle()
          this.refreshEnvironmentCommands()
        }),
      )
      const updateShell = () => {
        const shell = client.shell.getSnapshot();
        for (const profile of this.state.profiles) {
          const current = shell.projects.get(profile.profileId);
          if (!current || current.archived && !profile.archivedAt) {
            this.conversationSnapshotCache?.evictProfile(this.originId, profile.profileId);
            for (const agent of this.state.agents) if (agent.profileId === profile.profileId) this.invalidateConversationSnapshotAgent(agent.agentId);
          }
        }
        this.updateState({ ...projectShell(shell, this.state.agents, this.state.profiles, this.state.unreadCounts, this.state.sessionAttentions), restartRecovery: shell.recovery ?? null });
      }
      updateShell()
      this.environmentDetach.push(
        // Keyed wake-ups only: a project-only change replaces `projects` but not `sessions`.
        client.shell.subscribe((s) => s, updateShell, Object.is, [
          'sessions',
          'projects',
          'recovery',
        ]),
      )
      const updateConnection = () => {
        const c = client.connection.getSnapshot()
        this.updateState({ connected: c.transportHealthy, lastError: c.reason })
        // The host connection ends with the socket; the channel reports attached again after reconnect.
        if (!c.transportHealthy) this.resetEnvironmentBrowserHost()
      }
      updateConnection()
      this.environmentDetach.push(
        client.connection.subscribe((s) => s, updateConnection),
      )
      if (normalizedInitialAgentId)
        this.subscribeToAgent(normalizedInitialAgentId)
    }
  }

  /**
   * Observe permanent session invalidation (server close code 4001 on remote
   * collaboration origins — role change, disable, sign-out). The client stops
   * reconnecting when it fires; the origin manager flips the origin to
   * `unauthorized`. Local builder sockets never receive 4001.
   */
  setSessionInvalidatedObserver(observer: (() => void) | null): void {
    this.sessionInvalidatedObserver = observer
  }

  applyCompatibilitySnapshot(patch: Partial<ManagerWsState>): void {
    this.updateState(patch)
  }

  getEnvironmentClient(): EnvironmentClient | undefined {
    return this.environmentClient
  }

  getState(): ManagerWsState {
    return this.state
  }

  applyLoadedModelCacheVisualizationSetting(enabled: boolean): void {
    this.bootstrapBuffer.flush()
    this.updateState(
      reduceLoadedModelCacheVisualizationSetting({
        enabled,
        currentObservations: this.state.modelCacheObservations,
        pendingObservations: this.state.pendingModelCacheObservations,
      }),
    )
  }

  applySecureSessionSnapshot(snapshot: SecureSessionSnapshot): void {
    reduceSecureSessionSnapshot(snapshot, {
      state: this.state,
      updateState: (patch) => this.updateState(patch),
    })
  }

  markUnread(agentId: string): void {
    void this.sessionState('session.readState.set', { sessionId: agentId, read: false }).catch(error => this.reportSessionStateError(error))
  }

  markAllRead(profileId: string): void {
    void this.sessionState('project.readState.clear', { projectId: profileId }).catch(error => this.reportSessionStateError(error))
  }

  async dismissSessionAttention(attentionIds: string[]): Promise<SessionAttentionUpdateEvent> {
    await this.sessionState('session.attention.dismiss', { occurrenceIds: attentionIds })
    // State comes from the authoritative shell. The return is a facade result,
    // never applied as a competing optimistic attention reducer.
    return { type: 'session_attention_update', revision: this.state.sessionAttentionRevision, changes: [] }
  }

  private reportSessionStateError(error: unknown): void {
    this.updateState({ lastError: error instanceof Error ? error.message : 'Session state update failed' })
  }

  private async sessionState<M extends 'session.update' | 'session.message.pin' | 'session.pins.clear' | 'session.readState.set' | 'project.readState.clear' | 'session.attention.dismiss'>(method: M, input: Omit<RpcInput<M>, 'commandId'>): Promise<CommandReceipt> {
    const client = this.environmentClient
    if (!client?.descriptor()?.capabilities.sessionState) throw new Error('Update this environment to manage pins and read state')
    const key = JSON.stringify([method, input])
    const commandId = this.intentCommandIds.get(key) ?? crypto.randomUUID()
    this.intentCommandIds.set(key, commandId)
    const receipt = await client.request(method, { ...input, commandId } as RpcInput<M>)
    this.intentCommandIds.delete(key)
    if (receipt.state !== 'succeeded') throw new Error(receipt.error?.message ?? 'Session state update did not complete')
    return receipt
  }

  resumeRestartRecovery(): void {
    this.decideRecovery('resume')
  }

  dismissRestartRecovery(): void {
    this.decideRecovery('dismiss')
  }

  private decideRecovery(action: 'resume' | 'dismiss'): void {
    const recovery = this.environmentClient?.shell.getSnapshot().recovery
    if (!this.environmentClient || !recovery) return
    const key = `recovery:${recovery.recoveryId}:${action}`
    const commandId = this.intentCommandIds.get(key) ?? crypto.randomUUID()
    this.intentCommandIds.set(key, commandId)
    void this.environmentClient.request('recovery.decide', { commandId, recoveryId: recovery.recoveryId, action })
      .then(receipt => { if (receipt.error) this.updateState({ lastError: receipt.error.message }); else this.intentCommandIds.delete(key) })
      .catch(error => this.updateState({ lastError: error instanceof Error ? error.message : 'Recovery decision failed' }))
  }

  registerBrowserAutomationHost(
    registration: BrowserHostRegistration,
    handleRequest: (request: BrowserAutomationRequest) => Promise<BrowserAutomationResponse>,
    handleLifecycle?: (request: BrowserHostLifecycleRequest) => Promise<BrowserHostLifecycleResponse>,
  ): () => void {
    const client = this.requireBrowserEnvironment()
    this.detachEnvironmentBrowserHost()
    this.browserHostRegistration = registration
    this.browserHostDetach = client.features.browserHost.register(registration, {
      host: browserHost => this.updateState({ browserHost }),
      hydrated: sessions => {
        const browserSessions = Object.fromEntries(sessions.map(snapshot => [snapshot.sessionAgentId, snapshot]))
        this.updateState({ browserSessions, browserHostHydrated: true, browserMetadataStale: false,
          browserPanelRevealRequest: projectPanelRevealRequest(this.state, browserSessions, this.state.browserHost.hostGeneration) })
      },
      snapshot: snapshot => this.updateBrowserSnapshot(snapshot),
      disconnected: () => this.resetEnvironmentBrowserHost(),
      error: error => this.updateState({ lastError: error instanceof Error ? error.message : String(error) }),
    }, handleRequest, handleLifecycle)
    return () => { if (this.browserHostRegistration === registration) { this.browserHostRegistration = null; this.detachEnvironmentBrowserHost() } }
  }

  private requireBrowserEnvironment(): EnvironmentClient {
    if (!this.environmentClient) throw new Error('The Browser workspace requires an environment connection')
    return this.environmentClient
  }
  private detachEnvironmentBrowserHost(): void { this.browserHostDetach?.(); this.browserHostDetach = null }
  private resetEnvironmentBrowserHost(): void {
    if (!this.state.browserHost.connected && !this.state.browserHostHydrated) return
    this.updateState({ browserHost: { connected: false, hostId: null, hostGeneration: null, focused: false, capabilities: null, connectedAt: null },
      browserHostHydrated: false, browserPanelRevealRequest: null, browserMetadataStale: Object.keys(this.state.browserSessions).length > 0 })
  }
  private updateBrowserSnapshot(snapshot: BrowserSessionSnapshot): void {
    const previous = this.state.browserSessions[snapshot.sessionAgentId]
    if (previous && snapshot.revision <= previous.revision) return
    const browserSessions = { ...this.state.browserSessions }
    if (snapshot.hostingState === 'removed') delete browserSessions[snapshot.sessionAgentId]
    else browserSessions[snapshot.sessionAgentId] = snapshot
    this.updateState({ browserSessions, browserMetadataStale: false, browserPanelRevealRequest: this.state.browserHostHydrated
      ? projectPanelRevealRequest(this.state, browserSessions, this.state.browserHost.hostGeneration) : null })
  }
  reportBrowserHostState(sessions: BrowserHostSessionStateReport[]): Promise<BrowserHostStateReportResult> {
    return this.requireBrowserEnvironment().features.browserHost.report(sessions)
  }
  setBrowserHostFocused(focused: boolean): void {
    void this.requireBrowserEnvironment().features.browserHost.focus(focused).catch(error => this.updateState({ lastError: error instanceof Error ? error.message : String(error) }))
  }
  async acknowledgeBrowserPanelReveal(options: { sessionAgentId: string; profileId: string; tabId: string; sequence: number }): Promise<BrowserSessionSnapshot> {
    const snapshot = await this.requireBrowserEnvironment().features.browserHost.reveal({ sessionId: options.sessionAgentId, tabId: options.tabId, sequence: options.sequence })
    this.updateBrowserSnapshot(snapshot); return snapshot
  }
  private async browserCommand<M extends 'browser.tab.open' | 'browser.tab.activate' | 'browser.tab.close' | 'browser.recording.start' | 'browser.recording.stop'>(method: M, input: Omit<RpcInput<M>, 'commandId'>): Promise<CommandReceipt> {
    const client = this.requireBrowserEnvironment()
    const key = JSON.stringify([method, input])
    const commandId = this.intentCommandIds.get(key) ?? crypto.randomUUID(); this.intentCommandIds.set(key, commandId)
    let receipt = await client.request(method, { ...input, commandId } as RpcInput<M>)
    const deadline = Date.now() + 15000
    while (receipt.state === 'accepted' || receipt.state === 'running') {
      if (Date.now() >= deadline) throw new Error('Browser action is still settling; inspect its state before retrying')
      await new Promise(resolve => setTimeout(resolve, 50)); receipt = await client.request('command.get', { commandId })
    }
    if (receipt.state !== 'succeeded' || receipt.delivery === 'unknown') throw new Error('Browser action delivery is unknown; inspect the tab or recording before issuing another action')
    this.intentCommandIds.delete(key)
    return receipt
  }
  async openBrowserTab(sessionAgentId: string, profileId: string, options?: { url?: string; activate?: boolean }): Promise<BrowserSessionSnapshot> {
    const projectId = this.requireBrowserEnvironment().shell.getSnapshot().sessions.get(sessionAgentId)?.projectId
    if (projectId && projectId !== profileId) throw new Error('Browser profile does not match this session')
    await this.browserCommand('browser.tab.open', { sessionId: sessionAgentId, ...options }); return this.readBrowserSnapshot(sessionAgentId)
  }
  async activateBrowserTab(sessionAgentId: string, tabId: string): Promise<BrowserSessionSnapshot> {
    await this.browserCommand('browser.tab.activate', { sessionId: sessionAgentId, tabId }); return this.readBrowserSnapshot(sessionAgentId)
  }
  async closeBrowserTab(sessionAgentId: string, tabId: string): Promise<BrowserSessionSnapshot> {
    await this.browserCommand('browser.tab.close', { sessionId: sessionAgentId, tabId }); return this.readBrowserSnapshot(sessionAgentId)
  }
  async resizeBrowserTab(sessionAgentId: string, tabId: string, viewport: BrowserViewportSetting): Promise<BrowserSessionSnapshot> {
    const snapshot = await this.requireBrowserEnvironment().request('browser.tab.resize', { sessionId: sessionAgentId, tabId, viewport }); this.updateBrowserSnapshot(snapshot); return snapshot
  }
  async startBrowserRecording(sessionAgentId: string, tabId: string) {
    const receipt = await this.browserCommand('browser.recording.start', { sessionId: sessionAgentId, tabId }); await this.readBrowserSnapshot(sessionAgentId)
    const result = receipt.result?.browserRecording; if (!result || !('recording' in result)) throw new Error('Browser recording result is unavailable'); return result
  }
  async stopBrowserRecording(sessionAgentId: string, tabId: string, recordingId: string) {
    const receipt = await this.browserCommand('browser.recording.stop', { sessionId: sessionAgentId, tabId, recordingId }); await this.readBrowserSnapshot(sessionAgentId)
    const result = receipt.result?.browserRecording; if (!result || !('path' in result)) throw new Error('Browser recording artifact is unavailable'); return result
  }
  private async readBrowserSnapshot(sessionId: string): Promise<BrowserSessionSnapshot> {
    const snapshot = await this.requireBrowserEnvironment().request('browser.get', { sessionId }); this.updateBrowserSnapshot(snapshot); return snapshot
  }

  hasExplicitSelection(): boolean {
    return this.hasExplicitAgentSelection
  }

  getExplicitSelectionAgentId(): string | null {
    return this.explicitAgentSelectionAgentId
  }

  getRejectedExplicitSelectionAgentId(): string | null {
    return this.rejectedExplicitAgentSelectionId
  }

  isExplicitSelectionPending(): boolean {
    return this.explicitAgentSelectionPending
  }

  private resolveTerminalScopeAgentId(
    agentId: string | null | undefined,
    agents: AgentDescriptor[] = this.state.agents,
  ): string | null {
    return resolveTerminalScopeAgentId(agentId, agents)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.state)

    return () => {
      this.listeners.delete(listener)
    }
  }

  start(): void {
    if (typeof window === 'undefined') return

    this.transport?.connect(INITIAL_CONNECT_DELAY_MS)
  }

  destroy(): void {
    this.detailDetach?.()
    this.detailLease?.release()
    this.detailDetach = null
    this.detailLease = null
    for (const detach of this.environmentDetach) detach()
    this.requestDispatcher.rejectAllPendingRequests('Client destroyed before request completed.')
    this.sessionWorkerCache.destroy()
    this.bootstrapBuffer.clear()
    this.cancelConversationBootstrapWatchdog()
    for (const timer of this.optimisticSendExpiryTimers) {
      clearTimeout(timer)
    }
    this.optimisticSendExpiryTimers.clear()
    this.clearGenerationTerminalCleanupTimers()
    this.detachEnvironmentBrowserHost()

    this.transport?.disconnect()
  }

  subscribeToAgent(agentId: string, options?: { explicit?: boolean; reason?: ConversationSubscriptionReason },
  ): void {
    const trimmed = agentId.trim()
    if (!trimmed) return
    if (this.environmentClient) {
      // Re-subscribing to the mounted session must not remount it: a remount republishes state,
      // and route effects that re-subscribe on state change would otherwise never settle.
      if (this.detailLease && this.desiredAgentId === trimmed) return
      this.mountEnvironmentDetail(trimmed)
      return
    }

    const isExplicitSelection = options?.explicit ?? true
    this.hasExplicitAgentSelection = isExplicitSelection
    this.explicitAgentSelectionAgentId = isExplicitSelection ? trimmed : null
    this.explicitAgentSelectionPending = isExplicitSelection
    this.rejectedExplicitAgentSelectionId = null

    const previousTerminalScopeId = this.resolveTerminalScopeAgentId(this.state.targetAgentId)
    const nextTerminalScopeId = this.resolveTerminalScopeAgentId(trimmed)
    const nextUnread = { ...this.state.unreadCounts }
    delete nextUnread[trimmed]
    this.desiredAgentId = trimmed
    this.beginConversationSubscription({
      agentId: trimmed,
      requestedView: this.conversationView,
      reason: options?.reason ?? 'selection',
      patch: {
        planSnapshotLoadingSessionId: trimmed,
        goalSnapshotLoadingSessionId: trimmed,
        secureSessionSnapshotLoadingSessionId: trimmed,
        ...(previousTerminalScopeId !== nextTerminalScopeId
          ? { terminals: [], terminalSessionScopeId: null }
          : {}),
        unreadCounts: nextUnread,
      },
    })
  }

  retryConversationBootstrap(): boolean {
    if (this.environmentClient && this.state.targetAgentId) {
      this.mountEnvironmentDetail(this.state.targetAgentId)
    return true
    }
    const agentId = this.state.conversationBootstrap.agentId ?? this.state.targetAgentId
    if (!agentId) return false
    this.beginConversationSubscription({
      agentId,
      requestedView: this.state.conversationBootstrap.requestedView,
      reason: 'retry',
    })
    return true
  }

  setConversationView(view: BuilderTimelineChannelView): boolean {
    if (this.environmentClient) {
      this.conversationView = view
      return false
    }
    if (this.conversationView === view) return false
    this.conversationView = view
    const agentId = this.state.targetAgentId
    if (!agentId) return false
    this.beginConversationSubscription({ agentId, requestedView: view, reason: 'view_change' })
    return isSocketOpen(this.socket)
  }

  sendUserMessage(
    text: string,
    options?: {
      agentId?: string
      artifactIds?: string[]
      delivery?: DeliveryMode
      attachments?: ConversationAttachment[]
      replyTo?: ConversationReplyTargetInput
      sessionReferenceAgentIds?: string[]
    },
  ): void {
    if (this.outbox) {
      const sessionId = options?.agentId ?? this.state.targetAgentId
      if (!sessionId) {
        this.updateState({ lastError: 'No session selected' })
        return
      }
      this.outbox.submit(sessionId, text, options?.attachments ?? [], options?.artifactIds ?? [])
      return
    }
    const trimmed = text.trim()
    const attachments = normalizeConversationAttachments(options?.attachments)
    if (!trimmed && attachments.length === 0) return

    if (!isSocketOpen(this.socket)) {
      this.updateState({
        lastError: RECONNECTING_SOCKET_ERROR,
      })
      return
    }

    const agentId =
      options?.agentId ?? this.state.targetAgentId ?? this.state.subscribedAgentId ?? this.desiredAgentId

    if (!agentId) {
      this.updateState({
        lastError: 'No active agent selected. Create a manager or select an active thread.',
      })
      return
    }

    if (
      !options?.agentId &&
      !this.state.targetAgentId &&
      !this.state.subscribedAgentId &&
      this.state.agents.length === 0
    ) {
      this.updateState({
        lastError: 'No active agent selected. Create a manager or select an active thread.',
      })
      return
    }

    if (
      this.state.agents.length > 0 &&
      !this.state.agents.some((agent) => agent.agentId === agentId) &&
      !this.state.statuses[agentId]
    ) {
      this.updateState({
        lastError: 'No active agent selected. Create a manager or select an active thread.',
      })
      return
    }

    // Optimistic multi-writer send (SPEC §4.6): append the message locally
    // keyed by a clientRequestId; the server echoes the id on the broadcast
    // and the shared reducer replaces this entry instead of duplicating it.
    const clientRequestId = generateClientRequestId()
    if (agentId === this.state.targetAgentId) {
      const optimisticEntry = {
        type: 'conversation_message' as const,
        agentId,
        role: 'user' as const,
        text: trimmed,
        timestamp: new Date().toISOString(),
        source: 'user_input' as const,
        clientRequestId,
      }
      this.updateState({ messages: [...this.state.messages, optimisticEntry] })
      this.scheduleOptimisticSendExpiry(clientRequestId)
    }

    this.send(
      buildUserMessageCommand({
        text: trimmed,
        attachments,
        replyTo: options?.replyTo,
        agentId,
        delivery: options?.delivery,
        clientRequestId,
        sessionReferenceAgentIds: options?.sessionReferenceAgentIds,
      }),
    )
  }

  /**
   * Drop an optimistic entry the server never confirmed (send lost, denied,
   * or the socket died) so it cannot persist as a ghost message.
   */
  private scheduleOptimisticSendExpiry(clientRequestId: string): void {
    const timer = setTimeout(() => {
      this.optimisticSendExpiryTimers.delete(timer)
      const index = this.state.messages.findIndex(
        (message) =>
          message.type === 'conversation_message' &&
          !message.id &&
          message.clientRequestId === clientRequestId,
      )
      if (index < 0) return
      const nextMessages = [...this.state.messages]
      nextMessages.splice(index, 1)
      this.updateState({
        messages: nextMessages,
        lastError: 'Message delivery was not confirmed. Please try again.',
      })
    }, OPTIMISTIC_SEND_EXPIRY_MS)
    this.optimisticSendExpiryTimers.add(timer)
  }

  /** Retries an unacknowledged environment message with its original command ID. */
  retryEnvironmentMessage(commandId: string): boolean {
    return this.outbox?.retry(commandId) ?? false
  }

  /** Sends an interrupted or failed environment message again as a new command. */
  resendEnvironmentMessage(commandId: string): boolean {
    if (!this.outbox) return false
    const projected = this.environmentProjection?.items.find((item) => item.commandId === commandId && item.kind === 'user')
    return this.outbox.resend(commandId, projected
      ? { sessionId: this.environmentProjection!.session.sessionId, text: projected.text, artifactIds: projected.artifacts.map((a) => a.artifactId) }
      : undefined) !== null
  }

  sendChoiceResponse(agentId: string, choiceId: string, answers: ChoiceAnswer[]): void {
    this.send(buildChoiceResponseCommand(agentId, choiceId, answers))
  }

  sendChoiceCancel(agentId: string, choiceId: string): void {
    const owner = this.state.agents.find(agent => agent.agentId === agentId)
    const sessionId = owner?.role === 'worker' ? owner.managerId : agentId
    void this.lifecycle('session.choice.cancel', { sessionId, choiceId }).catch(error => this.updateState({ lastError: error instanceof Error ? error.message : 'Choice cancellation failed' }))
  }

  async readCodexElicitationUrl(agentId: string, elicitationId: string): Promise<string> {
    if (!this.environmentClient) throw new Error('Elicitation is unavailable')
    const response = await this.environmentClient.request('session.elicitation.url', { sessionId: agentId, elicitationId, generation: elicitationId })
    return response.url
  }

  sendCodexElicitationResponse(
    agentId: string,
    elicitationId: string,
    decision: CodexElicitationDecision,
    values?: Record<string, unknown>,
    persistScope?: CodexElicitationPersistScope,
  ): void {
    if (!this.environmentClient) return
    const scalarValues = values as Record<string, string | number | boolean> | undefined
    void this.environmentClient.request('session.elicitation.respond', { sessionId: agentId, elicitationId, generation: elicitationId, decision, values: scalarValues, persistScope })
      .catch(error => this.updateState({ lastError: error instanceof Error ? error.message : 'Elicitation response failed' }))
  }

  pinMessage(agentId: string, messageId: string, pinned: boolean): void {
    void this.sessionState('session.message.pin', { sessionId: agentId, itemId: messageId, pinned }).catch(error => this.reportSessionStateError(error))
  }

  clearAllPins(agentId: string): void {
    void this.sessionState('session.pins.clear', { sessionId: agentId }).catch(error => this.reportSessionStateError(error))
  }

  deleteAgent(agentId: string): void {
    const workerId = agentId.trim()
    const sessionId = this.state.agents.find(agent => agent.agentId === workerId)?.managerId ?? this.environmentProjection?.session.sessionId ?? this.desiredAgentId
    if (!workerId || !sessionId) return
    void this.lifecycle('worker.kill', { sessionId, workerId }).catch(error => this.updateState({ lastError: error instanceof Error ? error.message : 'Worker kill failed' }))
  }
  async stopAllAgents(managerId: string): Promise<{ managerId: string; stoppedWorkerIds: string[]; managerStopped: boolean }> {
    const receipt = await this.lifecycle('session.stopAll', { sessionId: managerId })
    return { managerId, stoppedWorkerIds: receipt.result?.stoppedWorkerIds ?? [], managerStopped: receipt.result?.managerStopped ?? false }
  }
  private async lifecycle<M extends Extract<CommandReceipt['method'], 'session.stop' | 'session.stopAll' | 'session.resume' | 'session.archive' | 'session.restore' | 'session.clear' | 'session.delete' | 'session.fork' | 'session.choice.cancel' | 'worker.stop' | 'worker.resume' | 'worker.kill'>>(method: M, input: Omit<RpcInput<M>, 'commandId'>): Promise<CommandReceipt> {
    if (!this.environmentClient) throw new Error('A paired environment is required')
    const key = JSON.stringify([method, input])
    const commandId = this.intentCommandIds.get(key) ?? crypto.randomUUID()
    this.intentCommandIds.set(key, commandId)
    try {
      let receipt = await this.environmentClient.request(method, { ...input, commandId } as RpcInput<M>)
      const deadline = Date.now() + 10_000
      while (receipt.state === 'accepted' || receipt.state === 'running') {
        if (Date.now() >= deadline) throw new EnvironmentRuntimeError('UNAVAILABLE', 'Session operation is still settling; retry to inspect its receipt', true)
        await new Promise(resolve => setTimeout(resolve, 25))
        receipt = await this.environmentClient.request('command.get', { commandId })
      }
      this.intentCommandIds.delete(key)
      if (receipt.state === 'failed' || receipt.state === 'interrupted') throw new Error(receipt.error?.message ?? 'Session operation was interrupted; inspect the current state')
      return receipt
    } catch (error) { if (!isRetryableEnvironmentError(error)) this.intentCommandIds.delete(key); throw error }
  }

  private requirePolicyClient(): void {
    if (!this.environmentClient?.descriptor()?.capabilities.projectPolicy) throw new Error('Update this environment to configure projects and sessions')
  }
  private policyModel(preset?: ManagerModelPreset, exact?: ManagerExactModelSelection, thinkingLevel?: ManagerReasoningLevel): RpcInput<'project.create'>['model'] {
    const selected = exact ?? (preset ? getCatalogModelsByFamily(preset).find(model => model.isFamilyDefault) : undefined)
    if (!selected) throw new Error('Select an exact model for this environment')
    return { provider: selected.provider, modelId: selected.modelId, ...(thinkingLevel ? { thinkingLevel } : {}) }
  }
  private async policy<M extends Extract<CommandReceipt['method'], `project.${string}` | 'session.configure' | 'workspace.directories.create'>>(method: M, input: Omit<RpcInput<M>, 'commandId'>): Promise<CommandReceipt> {
    this.requirePolicyClient()
    const key = JSON.stringify([method, input])
    const commandId = this.intentCommandIds.get(key) ?? crypto.randomUUID()
    this.intentCommandIds.set(key, commandId)
    const receipt = await this.environmentClient!.request(method, { ...input, commandId } as RpcInput<M>)
    this.intentCommandIds.delete(key)
    if (receipt.state !== 'succeeded') throw new Error(receipt.error?.message ?? 'Configuration was interrupted; inspect the current state before retrying')
    return receipt
  }

  async createManager(input: {
    name: string
    cwd: string
    model?: ManagerModelPreset
    modelSelection?: ManagerExactModelSelection
    reasoningLevel?: ManagerReasoningLevel
    secureSessionsEnabled?: boolean
  }): Promise<AgentDescriptor> {
    const model = this.policyModel(input.model, input.modelSelection, input.reasoningLevel)
    const receipt = await this.policy('project.create', { title: input.name, cwd: input.cwd, model, ...(input.secureSessionsEnabled !== undefined ? { secureSessionsEnabled: input.secureSessionsEnabled } : {}) })
    const sessionId = receipt.result?.sessionId ?? receipt.sessionId
    if (!sessionId) throw new Error('Project creation has no default session')
    const shell = this.environmentClient!.shell.getSnapshot()
    return projectSession(shell.sessions.get(sessionId) ?? { sessionId, projectId: receipt.result?.projectId ?? receipt.projectId!, title: input.name, status: 'idle', attention: 'none', unread: 0, workerCount: 0, updatedAt: receipt.updatedAt, sortKey: receipt.updatedAt, archived: false, workspace: { kind: 'current_checkout', cwd: input.cwd, branch: null }, model: { ...model, thinkingLevel: model.thinkingLevel ?? '', origin: 'profile_default' } }, shell)

  }

  async deleteManager(managerId: string): Promise<{ managerId: string }> {
    await this.policy('project.delete', { projectId: managerId })
    this.invalidateConversationSnapshotAgent(managerId)
    return { managerId }

  }

  async updateProfileDefaultModel(
    profileId: string,
    model?: ManagerModelPreset,
    reasoningLevel?: ManagerReasoningLevel,
    modelSelection?: ManagerExactModelSelection,
  ): Promise<{ profileId: string }> {
    await this.policy('project.update', { projectId: profileId, patch: { modelDefault: this.policyModel(model, modelSelection, reasoningLevel) } })
    return { profileId }

  }

  async updateProjectDelegationDefaults(
    profileId: string,
    updates: {
      managerPosture?: WorkModeId | null
      delegationRosterId?: string | null
    },
  ): Promise<{ profileId: string }> {
    await this.policy('project.update', { projectId: profileId, patch: { delegationDefaults: { ...(updates.managerPosture !== undefined ? { managerPosture: updates.managerPosture as 'delegation_first' | 'adaptive' | 'hands_on' | null } : {}), ...(updates.delegationRosterId !== undefined ? { rosterId: updates.delegationRosterId } : {}) } } })
    return { profileId }

  }

  async updateManagerCwd(managerId: string, cwd: string): Promise<{ managerId: string; cwd: string }> {
    await this.policy('project.update', { projectId: managerId, patch: { cwd } })
    return { managerId, cwd: this.environmentClient!.shell.getSnapshot().projects.get(managerId)?.cwd ?? cwd }

  }

  reorderProfiles(profileIds: string[]): boolean {
    if (!this.environmentClient?.descriptor()?.capabilities.projectPolicy) return false
    void this.policy('project.reorder', { projectIds: profileIds }).catch(error => this.updateState({ lastError: error instanceof Error ? error.message : String(error) }))
    return true

  }

  async listDirectories(path?: string): Promise<DirectoriesListedResult> {
    this.requirePolicyClient()
    const listed = await this.environmentClient!.request('workspace.directories.list', { ...(path ? { path } : {}) })
    return { ...listed, path: listed.resolvedPath, directories: listed.entries.map(entry => entry.path) }

  }

  async validateDirectory(path: string): Promise<DirectoryValidationResult> {
    this.requirePolicyClient()
    const result = await this.environmentClient!.request('workspace.directories.validate', { path })
    return { ...result, path: result.requestedPath, message: result.message ?? null }

  }

  async createDirectory(parentPath: string, name: string): Promise<DirectoryCreatedResult> {
    const receipt = await this.policy('workspace.directories.create', { parentPath, name })
    if (!receipt.result?.path) throw new Error('Directory creation has no result')
    return { path: receipt.result.path, parentPath, name }

  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    const bridge = typeof window !== 'undefined' ? window.electronBridge : undefined
    if (bridge?.showOpenDialog) {
      const result = await bridge.showOpenDialog({
        title: 'Select Directory',
        defaultPath: defaultPath?.trim() || undefined,
        properties: ['openDirectory'],
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    }

    throw new Error('Directory picking requires Forge Desktop; browse the target environment folders instead')

  }

  async createSession(
    profileId: string,
    name?: string,
    opts?: { sessionPurpose?: AgentSessionPurpose; label?: string },
  ): Promise<SessionCreatedResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('create_session', (requestId) =>
      buildCreateSessionCommand(profileId, name, opts, requestId),
    )
  }

  async updateSessionModel(
    sessionAgentId: string,
    mode: 'inherit' | 'override',
    model?: ManagerModelPreset,
    reasoningLevel?: ManagerReasoningLevel,
    modelSelection?: ManagerExactModelSelection,
  ): Promise<{ sessionAgentId: string; mode: 'inherit' | 'override' }> {
    await this.policy('session.configure', { sessionId: sessionAgentId, model: mode === 'inherit' ? { mode } : { mode, ...this.policyModel(model, modelSelection, reasoningLevel) } })
    return { sessionAgentId, mode }

  }

  async updateSessionDelegation(
    sessionAgentId: string,
    updates: {
      managerPosture?: { mode: 'inherit' } | {
        mode: 'override'
        value: WorkModeId
      }
      delegationRoster?: { mode: 'inherit' } | {
        mode: 'override'
        rosterId: string
      }
    },
  ): Promise<{ sessionAgentId: string }> {
    await this.policy('session.configure', { sessionId: sessionAgentId, delegation: updates as RpcInput<'session.configure'>['delegation'] })
    return { sessionAgentId }

  }

  async stopSession(agentId: string): Promise<SessionActionResult> {
    const worker = this.state.agents.find(agent => agent.agentId === agentId && agent.role === 'worker')
    if (worker) await this.lifecycle('worker.stop', { sessionId: worker.managerId, workerId: agentId })
    else await this.lifecycle('session.stop', { sessionId: agentId })
    return { agentId }
  }
  async resumeSession(agentId: string): Promise<SessionActionResult> {
    const worker = this.state.agents.find(agent => agent.agentId === agentId && agent.role === 'worker')
    if (worker) await this.lifecycle('worker.resume', { sessionId: worker.managerId, workerId: agentId })
    else await this.lifecycle('session.resume', { sessionId: agentId })
    return { agentId }
  }
  async archiveSession(agentId: string): Promise<SessionArchiveResult> {
    const receipt = await this.lifecycle('session.archive', { sessionId: agentId })
    this.invalidateConversationSnapshotAgent(agentId)
    return { agentId, profileId: receipt.projectId!, archivedAt: receipt.result?.archivedAt ?? receipt.updatedAt }
  }
  async restoreSession(agentId: string): Promise<SessionRestoreResult> {
    const receipt = await this.lifecycle('session.restore', { sessionId: agentId })
    return { agentId, profileId: receipt.projectId!, openAgentId: receipt.result?.openAgentId }
  }
  async deleteSession(agentId: string): Promise<SessionActionResult> {
    await this.lifecycle('session.delete', { sessionId: agentId })
    this.invalidateConversationSnapshotAgent(agentId)
    return { agentId }
  }
  async clearSession(agentId: string): Promise<SessionActionResult> {
    await this.lifecycle('session.clear', { sessionId: agentId })
    this.invalidateConversationSnapshotAgent(agentId)
    return { agentId }
  }

  controlSessionGoal(agentId: string, action: SessionGoalControlAction): void {
    if (!this.environmentClient) return
    const key = JSON.stringify(['goal', agentId, action])
    const commandId = this.intentCommandIds.get(key) ?? crypto.randomUUID()
    this.intentCommandIds.set(key, commandId)
    void this.environmentClient.request('session.goal.control', { commandId, sessionId: agentId, ...action })
      .then(receipt => { if (receipt.error) this.updateState({ lastError: receipt.error.message }); else this.intentCommandIds.delete(key) })
      .catch(error => this.updateState({ lastError: error instanceof Error ? error.message : 'Goal control failed' }))
  }

  async renameSession(agentId: string, label: string): Promise<SessionActionResult> {
    await this.sessionState('session.update', { sessionId: agentId, title: label })
    return { agentId }
  }

  async pinSession(agentId: string, pinned: boolean): Promise<{ pinnedAt: string | null }> {
    const receipt = await this.sessionState('session.update', { sessionId: agentId, pinned })
    return { pinnedAt: receipt.result?.pinnedAt ?? null }
  }

  async renameProfile(profileId: string, displayName: string): Promise<{ profileId: string }> {
    await this.policy('project.update', { projectId: profileId, patch: { title: displayName } })
    return { profileId }

  }

  async archiveProfile(profileId: string): Promise<ProfileArchiveResult> {
    const receipt = await this.policy('project.archive', { projectId: profileId })
    this.conversationSnapshotCache?.evictProfile(this.originId, profileId)
    return { profileId, archivedAt: receipt.updatedAt }

  }

  async restoreProfile(profileId: string): Promise<ProfileRestoreResult> {
    const receipt = await this.policy('project.restore', { projectId: profileId })
    return { profileId, openAgentId: receipt.result?.sessionId ?? '' }

  }

  async forkSession(sourceAgentId: string, label?: string, fromMessageId?: string, options?: { sessionPurpose?: 'side_chat' }): Promise<SessionForkedResult> {
    const receipt = await this.lifecycle('session.fork', { sessionId: sourceAgentId, ...(label ? { title: label } : {}), ...(fromMessageId ? { fromItemId: fromMessageId } : {}), ...(options?.sessionPurpose ? { purpose: options.sessionPurpose } : {}) })
    const sessionId = receipt.result?.sessionId ?? receipt.sessionId
    if (!sessionId) throw new Error('Session fork has no reserved identity')
    const shell = this.environmentClient!.shell.getSnapshot()
    const source = shell.sessions.get(sourceAgentId)
    const summary = shell.sessions.get(sessionId) ?? (source && { ...source, sessionId, title: label ?? source.title, status: 'idle' as const, archived: false, updatedAt: receipt.updatedAt })
    if (!summary) throw new Error('Session fork is awaiting shell synchronization')
    return { sourceAgentId, newSessionAgent: projectSession(summary, shell) }
  }

  private projectAgentFeatures() {
    if (!this.environmentClient) throw new Error('A paired environment is required for Project Agents.')
    return this.environmentClient.features.projectAgents
  }

  private async projectAgentMutation<M extends 'projectAgent.set' | 'projectAgent.sharing.set' | 'projectAgent.recommend'>(method: M, input: Omit<RpcInput<M>, 'commandId'>): Promise<RpcOutput<M>> {
    const key = JSON.stringify([method, input])
    const commandId = this.intentCommandIds.get(key) ?? crypto.randomUUID()
    this.intentCommandIds.set(key, commandId)
    try {
      const result = await this.projectAgentFeatures().request(method, { ...input, commandId } as RpcInput<M>)
      this.intentCommandIds.delete(key)
      return result
    } catch (error) {
      if (!isRetryableEnvironmentError(error)) this.intentCommandIds.delete(key)
      throw error
    }
  }

  async setSessionProjectAgent(agentId: string, projectAgent: SessionProjectAgentInput | null): Promise<SessionProjectAgentResult> {
    const result = await this.projectAgentMutation('projectAgent.set', { sessionId: agentId, projectAgent })
    this.updateState({ promptChangeKey: this.state.promptChangeKey + 1 })
    return { agentId: result.sessionId, profileId: result.projectId, projectAgent: result.projectAgent }
  }

  async getProjectAgentConfig(agentId: string): Promise<ProjectAgentConfigResult> {
    const { sessionId, ...result } = await this.projectAgentFeatures().request('projectAgent.get', { sessionId: agentId })
    return { agentId: sessionId, ...result }
  }

  async getProjectAgentSharing(agentId: string): Promise<ProjectAgentSharingResult> {
    const { sessionId, ...result } = await this.projectAgentFeatures().request('projectAgent.sharing.get', { sessionId: agentId })
    return { agentId: sessionId, ...result }
  }

  async setProjectAgentSharing(agentId: string, targetProfileIds: string[]): Promise<ProjectAgentSharingUpdatedResult> {
    const { sessionId, receipt: _receipt, ...result } = await this.projectAgentMutation('projectAgent.sharing.set', { sessionId: agentId, targetProjectIds: targetProfileIds })
    this.updateState({ promptChangeKey: this.state.promptChangeKey + 1 })
    return { agentId: sessionId, ...result }
  }

  async getProjectAgentExternalDirectory(projectId: string): Promise<ProjectAgentExternalDirectoryResult> {
    const result = await this.projectAgentFeatures().request('projectAgent.directory', { projectId })
    return { profileId: result.projectId, entries: result.entries }
  }

  async listProjectAgentReferences(agentId: string): Promise<ProjectAgentReferencesResult> {
    const result = await this.projectAgentFeatures().request('projectAgent.references.list', { sessionId: agentId })
    return { agentId: result.sessionId, references: result.references }
  }

  async getProjectAgentReference(agentId: string, fileName: string): Promise<ProjectAgentReferenceResult> {
    const { sessionId, ...result } = await this.projectAgentFeatures().request('projectAgent.reference.read', { sessionId: agentId, fileName })
    return { agentId: sessionId, ...result }
  }

  async setProjectAgentReference(agentId: string, fileName: string, content: string, expectedRevision: string | null): Promise<ProjectAgentReferenceSavedResult> {
    const { sessionId, ...result } = await this.projectAgentFeatures().writeReference({ sessionId: agentId, fileName, content, expectedRevision })
    return { agentId: sessionId, ...result }
  }

  async deleteProjectAgentReference(agentId: string, fileName: string, expectedRevision: string | null): Promise<ProjectAgentReferenceDeletedResult> {
    const { sessionId, ...result } = await this.projectAgentFeatures().deleteReference({ sessionId: agentId, fileName, expectedRevision })
    return { agentId: sessionId, ...result }
  }

  async requestProjectAgentRecommendations(agentId: string): Promise<{ agentId: string; whenToUse: string; systemPrompt: string }> {
    const { sessionId, receipt: _receipt, ...result } = await this.projectAgentMutation('projectAgent.recommend', { sessionId: agentId })
    return { agentId: sessionId, ...result }
  }

  async getSessionWorkers(sessionAgentId: string): Promise<SessionWorkersResult> {
    if(this.environmentClient){
      const output=await this.environmentClient.request('session.workers',{sessionId:sessionAgentId})
      return {sessionAgentId,workers:output.workers.map(w=>projectWorker(w,sessionAgentId,this.environmentClient!.shell.getSnapshot()))}
    }
    return this.sessionWorkerCache.getSessionWorkers(sessionAgentId)
  }

  async loadOlderConversation(limit?: number): Promise<ConversationPageResult | null> {
    if (this.state.conversationBootstrap.phase !== 'ready') return null
    const agentId = this.state.targetAgentId
    const cursor = this.state.conversationPage?.nextCursor
    if (!agentId || !cursor || !this.state.conversationPage?.hasOlder || this.state.conversationPageLoading) {
      return null
    }

    assertReconnectableSocket(this.socket)
    this.updateState({ conversationPageLoading: true, lastError: null })
    let pageRequestId: string | null = null
    try {
      if(this.environmentClient){
        const page=await this.environmentClient.request('session.history',{sessionId:agentId,before:cursor,turns:Math.min(20,Math.max(1,limit??20))})
        const messages=projectItems(page.items,agentId)
        const result:ConversationPageResult={agentId,messages,page:{hasOlder:!!page.nextCursor,...(page.nextCursor?{nextCursor:page.nextCursor}:{}),completeness:'complete',source:'canonical'}}
        if(this.state.targetAgentId===agentId)this.updateState({messages:[...messages,...this.state.messages],activityMessages:[...projectActivityItems(page.items,agentId),...this.state.activityMessages],conversationPage:result.page,conversationPageLoading:false,conversationHistoryMutation:{revision:(this.state.conversationHistoryMutation?.revision??0)+1,kind:'prepend'}})
        return result
      }
      return await this.requestDispatcher.enqueueRequest(
        'get_conversation_page',
        (requestId) => {
          pageRequestId = requestId
          this.updateState({ conversationPageRequestId: requestId })
          return buildGetConversationPageCommand(
            agentId,
            cursor,
            requestId,
            limit,
            this.conversationView,
          )
        },
        { timeoutMs: CONVERSATION_PAGE_REQUEST_TIMEOUT_MS },
      )
    } catch (error) {
      if (
        this.state.targetAgentId === agentId &&
        this.state.conversationPageRequestId === pageRequestId
      ) {
        this.updateState({
          conversationPageLoading: false,
          conversationPageRequestId: null,
          lastError: error instanceof Error ? error.message : String(error),
        })
      }
      throw error
    }
  }

  refreshConversationHistory(): boolean {
    if (this.environmentClient && this.state.targetAgentId) {
      this.mountEnvironmentDetail(this.state.targetAgentId)
      return true
    }
    const agentId = this.state.targetAgentId
    if (!agentId) return false
    this.beginConversationSubscription({
      agentId,
      requestedView: this.conversationView,
      reason: 'refresh',
    })
    return isSocketOpen(this.socket)
  }

  private beginConversationSubscription(input: {
    agentId: string | null
    requestedView: BuilderTimelineChannelView
    reason: ConversationSubscriptionReason
    patch?: Partial<ManagerWsState>
    /** Destructive fallback reducers have already revoked the outgoing authority. */
    captureOutgoingSnapshot?: boolean
  }): void {
    const previous = this.state.conversationBootstrap
    if (previous.phase === 'pending' && previous.subscriptionId) {
      this.recordConversationBootstrapTerminal(previous.subscriptionId, 'superseded')
    }
    this.cancelConversationBootstrapWatchdog()
    if (input.captureOutgoingSnapshot !== false) this.captureCurrentConversationSnapshot()
    this.bootstrapBuffer.clear()
    this.clearGenerationTerminalCleanupTimers()

    const subscriptionId = `${this.subscriptionIdPrefix}-${this.nextSubscriptionId++}`.slice(0, 128)
    const startedAt = Date.now()
    this.stalePresentationAttachedAt = null
    this.updateState({
      ...input.patch,
      targetAgentId: input.agentId,
      subscribedAgentId: null,
      messages: [],
      activityMessages: [],
      conversationPage: null,
      conversationPageLoading: false,
      conversationPageRequestId: null,
      conversationHistoryMutation: null,
      modelCacheObservations: [],
      pendingModelCacheObservations: [],
      pendingChoiceIds: new Set(),
      codexElicitations: [],
      managerToolActivity: null,
      ...clearGenerationThroughputState(),
      secureSessionSnapshotLoadingSessionId: input.agentId,
      conversationPresentation: null,
      conversationBootstrap: {
        phase: 'pending',
        agentId: input.agentId,
        subscriptionId,
        requestedView: input.requestedView,
        servedView: null,
        reason: input.reason,
        protocolMode: previous.protocolMode,
        startedAt,
      },
      lastError: null,
    })
    conversationBootstrapMetrics.started(input.reason)

    if (!isSocketOpen(this.socket)) return
    if (input.agentId) this.bootstrapBuffer.begin(input.agentId)
    this.startConversationBootstrapWatchdog(subscriptionId)
    this.emitActiveSubscriptionCommand()
  }

  /** The sole subscribe command emitter. Pending state is installed before this runs. */
  private emitActiveSubscriptionCommand(): void {
    const bootstrap = this.state.conversationBootstrap
    if (bootstrap.phase !== 'pending' || !bootstrap.subscriptionId) return
    this.send(buildSubscribeCommand(
      bootstrap.agentId,
      bootstrap.requestedView,
      bootstrap.subscriptionId,
    ))
  }

  private startConversationBootstrapWatchdog(subscriptionId: string): void {
    this.cancelConversationBootstrapWatchdog()
    this.conversationBootstrapTimer = setTimeout(() => {
      this.conversationBootstrapTimer = null
      const current = this.state.conversationBootstrap
      if (current.phase !== 'pending' || current.subscriptionId !== subscriptionId) return
      this.recordConversationBootstrapTerminal(subscriptionId, 'timed_out')
      this.updateState({
        conversationBootstrap: {
          ...current,
          phase: 'error',
          errorCode: 'BOOTSTRAP_TIMEOUT',
          errorMessage: 'Conversation loading timed out.',
        },
      })
    }, this.conversationBootstrapWatchdogMs)
  }

  private cancelConversationBootstrapWatchdog(): void {
    if (this.conversationBootstrapTimer) clearTimeout(this.conversationBootstrapTimer)
    this.conversationBootstrapTimer = null
  }

  private recordConversationBootstrapTerminal(
    subscriptionId: string,
    terminal: 'completed' | 'failed' | 'timed_out' | 'superseded' | 'disconnected',
  ): void {
    if (this.terminalSubscriptionId === subscriptionId) return
    this.terminalSubscriptionId = subscriptionId
    conversationBootstrapMetrics.terminal(terminal)
  }

  private invalidateConversationSnapshotAgent(agentId: string): void {
    this.nonCapturableConversationAgentIds.add(agentId)
    this.conversationSnapshotCache?.evictAgent(this.originId, agentId)
  }

  private captureCurrentConversationSnapshot(): void {
    const bootstrap = this.state.conversationBootstrap
    if (
      !this.conversationSnapshotCache ||
      bootstrap.phase !== 'ready' ||
      bootstrap.protocolMode !== 'correlated' ||
      !bootstrap.agentId ||
      !bootstrap.servedView ||
      this.nonCapturableConversationAgentIds.has(bootstrap.agentId)
    ) return
    const profileId = this.state.agents.find((agent) => agent.agentId === bootstrap.agentId)?.profileId ?? null
    this.conversationSnapshotCache.capture({
      originId: this.originId,
      agentId: bootstrap.agentId,
      servedView: bootstrap.servedView,
      profileId,
      messages: this.state.messages,
      activityMessages: this.state.activityMessages,
      conversationPage: this.state.conversationPage,
    })
  }

  // -----------------------------------------------------------------------
  // Transport callbacks
  // -----------------------------------------------------------------------

  private handleTransportOpen(): void {
    this.hasExplicitAgentSelection = false
    this.explicitAgentSelectionAgentId = null
    this.explicitAgentSelectionPending = false
    this.rejectedExplicitAgentSelectionId = null

    // A reconnect (including after a backend restart) re-hydrates state IN
    // PLACE — never a full page reload. Resetting the bootstrap-tracking flags
    // below and re-issuing `subscribe` re-triggers the backend bootstrap and
    // refreshes WS state without discarding the SPA. Do NOT re-add a
    // `window.location.reload()` here: it re-runs the entire bootstrap from
    // scratch and, under a large session on a backpressured socket, fuels a
    // reconnect→reload loop (see UI-RELOAD-LOOP-INVESTIGATION.md).
    //
    // `loadedSessionIds` must survive the reconnect: the re-bootstrap
    // agents_snapshot is managers-only, and reduceAgentsSnapshot both preserves
    // cached workers and queues drift refetches ONLY for sessions in
    // `loadedSessionIds`. Clearing it here silently dropped every worker row
    // (sidebar + pill bar) after any reconnect, with no refetch, until a full
    // page reload. Stale entries are safe — a workerCount mismatch in the
    // fresh snapshot invalidates and refetches per session.
    this.updateState({
      connected: true,
      connectionEpoch: this.state.connectionEpoch + 1,
      // Invalidation revisions are scoped to one backend connection epoch. A
      // restarted backend may legitimately reload local preference authority
      // at R0, so an old R5 watermark must not suppress its new R1..R5 events.
      builderSidebarOrderRevision: null,
      secureSecretCatalogRevision: null,
      secureSessionSnapshots: {},
      secureSessionSnapshotLoadingSessionId: this.desiredAgentId,
      sessionAttentionAvailable: false,
      sessionAttentionRevision: -1,
      sessionAttentions: {},
      hasReceivedAgentsSnapshot: false,
      hasReceivedProfilesSnapshot: false,
      workerMetadataSessionIds: new Set(),
      remoteUpdateAwarenessSnapshot: null,
      codexElicitations: [],
      browserHost: {
        connected: false,
        hostId: null,
        hostGeneration: null,
        focused: false,
        capabilities: null,
        connectedAt: null,
      },
      browserSessions: {},
      browserHostHydrated: false,
      browserPanelRevealRequest: null,
      browserMetadataStale: false,
      managerToolActivity: null,
      conversationBootstrap: {
        ...this.state.conversationBootstrap,
        protocolMode: 'unknown',
      },
      conversationPresentation: null,
      ...clearGenerationThroughputState(),
      lastError: null,
    })

    // Fetch failures accumulated against the old socket don't predict anything
    // on the new one — reset the retry budget and requeue sessions whose
    // worker fetch was lost to the disconnect.
    this.sessionWorkerCache.retryFailedFetchesAfterReconnect()

    this.beginConversationSubscription({
      agentId: this.desiredAgentId,
      requestedView: this.conversationView,
      reason: 'reconnect',
    })
  }

  private handleTransportClose(event?: CloseEvent): void {
    this.hasExplicitAgentSelection = false
    this.explicitAgentSelectionAgentId = null
    this.explicitAgentSelectionPending = false
    this.rejectedExplicitAgentSelectionId = null
    this.bootstrapBuffer.clear()
    this.cancelConversationBootstrapWatchdog()
    this.deferredWorkerThroughputEvents = []
    const pendingBootstrap = this.state.conversationBootstrap
    if (pendingBootstrap.phase === 'pending' && pendingBootstrap.subscriptionId) {
      this.recordConversationBootstrapTerminal(pendingBootstrap.subscriptionId, 'disconnected')
    }
    this.clearGenerationTerminalCleanupTimers()

    // Keep `loadedSessionIds` — see handleTransportOpen.
    this.updateState({
      connected: false,
      hasReceivedAgentsSnapshot: false,
      hasReceivedProfilesSnapshot: false,
      workerMetadataSessionIds: new Set(),
      subscribedAgentId: null,
      remoteUpdateAwarenessSnapshot: null,
      codexElicitations: [],
      browserHost: {
        connected: false,
        hostId: null,
        hostGeneration: null,
        focused: false,
        capabilities: null,
        connectedAt: null,
      },
      browserHostHydrated: false,
      browserPanelRevealRequest: null,
      browserMetadataStale: Object.keys(this.state.browserSessions).length > 0,
      managerToolActivity: null,
      ...clearGenerationThroughputState(),
      ...(pendingBootstrap.phase === 'pending'
        ? {
            conversationBootstrap: {
              ...pendingBootstrap,
              phase: 'error' as const,
              errorCode: 'DISCONNECTED',
              errorMessage: 'Disconnected while loading conversation.',
            },
          }
        : {}),
    })

    this.sessionWorkerCache.clearQueuedRefetches()
    this.requestDispatcher.rejectAllPendingRequests('WebSocket disconnected before request completed.')

    // Remote collaboration origins: 4001 means the session is permanently
    // invalid — reconnecting would 401 forever. Stop the transport and let
    // the origin manager surface the sign-in state.
    if (event?.code === SESSION_INVALIDATED_CLOSE_CODE) {
      this.transport?.disconnect()
      this.updateState({
        lastError: 'Your session has been invalidated. Please sign in again.',
      })
      this.sessionInvalidatedObserver?.()
    }
  }

  private handleTransportError(): void {
    this.updateState({
      connected: false,
      lastError: 'WebSocket connection error',
    })
  }

  private handleServerEvent(parsed: unknown): void {
    const event = parsed as ServerEvent

    if (event.type === 'conversation_reset') {
      this.invalidateConversationSnapshotAgent(event.agentId)
    } else if (event.type === 'conversation_page' && event.page.completeness === 'source_changed') {
      this.invalidateConversationSnapshotAgent(event.agentId)
    } else if (event.type === 'session_archived' || event.type === 'session_cleared') {
      this.invalidateConversationSnapshotAgent(event.agentId)


    }

    if (
      event.type === 'error' &&
      event.code === 'UNKNOWN_AGENT' &&
      this.explicitAgentSelectionAgentId === this.desiredAgentId
    ) {
      this.rejectedExplicitAgentSelectionId = this.explicitAgentSelectionAgentId
      this.explicitAgentSelectionPending = false
      this.bootstrapBuffer.clear()
    }

    if (this.handleConversationBootstrapFrame(event)) return

    if (
      event.type === 'ready' &&
      event.subscribedAgentId === this.explicitAgentSelectionAgentId
    ) {
      this.rejectedExplicitAgentSelectionId = null
      this.explicitAgentSelectionPending = false
    }

    if (event.type === 'conversation_page') {
      this.requestDispatcher.tracker.resolve('get_conversation_page', event.requestId, {
        agentId: event.agentId,
        messages: event.messages,
        page: event.page,
      })
    }

    if (this.bootstrapBuffer.active) {
      const consumed = this.bootstrapBuffer.handleEvent(event)
      if (consumed) return
    }

    if (handleSessionAttentionEvent(event, {
      state: this.state,
      updateState: (patch) => this.updateState(patch),
      requestTracker: this.requestDispatcher.tracker,
    })) {
      return
    }

    if (event.type === 'generation_throughput' || event.type === 'generation_throughput_snapshot') {
      const pendingWorkerMetadataSessionId =
        pendingGenerationThroughputWorkerMetadataSessionId(this.state, event)
      if (pendingWorkerMetadataSessionId) {
        this.deferWorkerThroughputEvent(event)
        return
      }
    }

    if (handleGenerationThroughputEvent(event, {
      state: this.state,
      applyGenerationThroughputReduction: (reduction) => this.applyGenerationThroughputReduction(reduction),
    })) {
      return
    }

    if (
      handleConversationEvent(event, {
        state: this.state,
        updateState: (patch) => this.updateState(patch),
      })
    ) {
      return
    }

    // Gate terminal snapshots at the facade so handlers stay pure: reject late
    // prior-scope frames after A→B when the selected target's resolved scope differs.
    // Environment detail leases are already session-scoped and server-routed.
    if (event.type === 'terminals_snapshot' && !this.environmentClient) {
      const expectedTerminalScopeId = this.resolveTerminalScopeAgentId(this.state.targetAgentId)
      if (event.sessionAgentId !== expectedTerminalScopeId) {
        return
      }
    }

    if (
      handleTerminalEvent(event, {
        state: this.state,
        updateState: (patch) => this.updateState(patch),
      })
    ) {
      return
    }

    if (
      handleAgentEvent(event, {
        applyAgentStatus: (agentEvent) => this.applyAgentStatus(agentEvent),
        applyAgentsSnapshot: (agents) => this.applyAgentsSnapshot(agents),
        applySessionWorkersSnapshot: (sessionAgentId, workers, requestId) =>
          this.applySessionWorkersSnapshot(sessionAgentId, workers, requestId),
        requestTracker: this.requestDispatcher.tracker,

      })
    ) {
      return
    }

    if (
      handleSessionEvent(event, {
        applySessionDeleted: (agentId, profileId) => this.applySessionDeleted(agentId, profileId),
        requestTracker: this.requestDispatcher.tracker,
      })
    ) {
      return
    }

    if (event.type === 'builder_sidebar_order_updated') {
      if (
        this.state.builderSidebarOrderRevision === null
        || event.revision > this.state.builderSidebarOrderRevision
      ) {
        this.updateState({ builderSidebarOrderRevision: event.revision })
      }
      return
    }

    if (
      handleConfigEvent(event, {
        state: this.state,
        updateState: (patch) => this.updateState(patch),
        requestTracker: this.requestDispatcher.tracker,
      })
    ) {
      return
    }



    handleSystemEvent(event, {
      requestTracker: this.requestDispatcher.tracker,
      updateState: (patch) => this.updateState(patch),
      pushSystemMessage: (text) => this.pushSystemMessage(text),
      rejectPendingFromError: (code, message, requestId) =>
        this.requestDispatcher.rejectPendingFromError(code, message, requestId),
    })
  }

  private handleConversationBootstrapFrame(event: ServerEvent): boolean {
    if (
      event.type !== 'ready' &&
      event.type !== 'conversation_history' &&
      event.type !== 'pending_choices_snapshot' &&
      event.type !== 'bootstrap_failed'
    ) return false

    const frame = event.type
    const current = this.state.conversationBootstrap
    const eventSubscriptionId = 'subscriptionId' in event ? event.subscriptionId : undefined

    // Uncorrelated ready may be a ping. It can refresh connection health only.
    if (frame === 'ready' && !eventSubscriptionId && current.phase === 'pending') {
      if (!this.state.connected) this.updateState({ connected: true })
      return true
    }

    // A matching uncorrelated history is the sole legacy-peer detector.
    if (frame === 'conversation_history' && !eventSubscriptionId && current.phase === 'pending') {
      const expectedAgentId = current.agentId ?? event.agentId
      if (event.agentId !== expectedAgentId) return true
      this.conversationSnapshotCache?.evictOrigin(this.originId)
      this.bootstrapBuffer.flush()
      let patch: Partial<ManagerWsState> = {}
      handleConversationEvent(event, {
        state: this.state,
        updateState: (next) => { patch = { ...patch, ...next } },
      })
      this.cancelConversationBootstrapWatchdog()
      if (current.subscriptionId) this.recordConversationBootstrapTerminal(current.subscriptionId, 'completed')
      if (event.agentId === this.explicitAgentSelectionAgentId) {
        this.hasExplicitAgentSelection = false
        this.explicitAgentSelectionAgentId = null
        this.explicitAgentSelectionPending = false
        this.rejectedExplicitAgentSelectionId = null
      }
      this.updateState({
        ...patch,
        targetAgentId: event.agentId,
        subscribedAgentId: event.agentId,
        conversationPresentation: null,
        conversationBootstrap: {
          ...current,
          phase: 'ready',
          agentId: event.agentId,
          servedView: current.requestedView,
          protocolMode: 'legacy',
          errorCode: undefined,
          errorMessage: undefined,
        },
      })
      return true
    }

    // Legacy choices may arrive before legacy history. Apply only to the
    // selected target, but do not let them prove capability or completion.
    if (!eventSubscriptionId) {
      if (
        frame === 'pending_choices_snapshot' &&
        (current.agentId === null || event.agentId === current.agentId)
      ) {
        handleConversationEvent(event, {
          state: this.state,
          updateState: (patch) => this.updateState(patch),
        })
        return true
      }
      return false
    }

    if (
      current.phase === 'ready' &&
      frame === 'pending_choices_snapshot' &&
      current.subscriptionId === eventSubscriptionId &&
      current.agentId === event.agentId &&
      current.servedView === event.servedConversationView
    ) {
      handleConversationEvent(event, {
        state: this.state,
        updateState: (patch) => this.updateState(patch),
      })
      return true
    }

    const mismatchDimension = (() => {
      if (current.phase !== 'pending') return 'phase' as const
      if (current.subscriptionId !== eventSubscriptionId) return 'id' as const
      const eventAgentId = frame === 'ready' ? event.subscribedAgentId : event.agentId
      if (current.agentId !== null && eventAgentId !== current.agentId) return 'agent' as const
      if (event.servedConversationView !== current.requestedView) return 'view' as const
      return null
    })()
    if (mismatchDimension) {
      conversationBootstrapMetrics.mismatch({ frame, dimension: mismatchDimension })
      return true
    }

    const eventAgentId = frame === 'ready' ? event.subscribedAgentId : event.agentId
    if (frame === 'ready') {
      const presentation = this.conversationSnapshotCache?.get({
        originId: this.originId,
        agentId: eventAgentId,
        servedView: event.servedConversationView!,
      }) ?? null
      this.stalePresentationAttachedAt = presentation ? Date.now() : null
      this.rejectedExplicitAgentSelectionId = null
      this.explicitAgentSelectionPending = false
      this.updateState({
        connected: true,
        targetAgentId: eventAgentId,
        subscribedAgentId: eventAgentId,
        sessionAttentionAvailable: event.sessionAttention === true,
        conversationPresentation: presentation,
        conversationBootstrap: {
          ...current,
          agentId: eventAgentId,
          servedView: event.servedConversationView!,
          protocolMode: 'correlated',
        },
      })
      return true
    }

    if (frame === 'bootstrap_failed') {
      this.cancelConversationBootstrapWatchdog()
      this.recordConversationBootstrapTerminal(eventSubscriptionId, 'failed')
      if (event.code === 'UNKNOWN_AGENT' || event.code === 'TARGET_REMOVED') {
        this.conversationSnapshotCache?.evictAgent(this.originId, eventAgentId)
      }
      this.updateState({
        conversationBootstrap: {
          ...current,
          phase: 'error',
          agentId: eventAgentId,
          servedView: event.servedConversationView,
          protocolMode: 'correlated',
          errorCode: event.code,
          errorMessage: event.message,
        },
      })
      return true
    }

    if (frame === 'pending_choices_snapshot') {
      handleConversationEvent(event, {
        state: this.state,
        updateState: (patch) => this.updateState(patch),
      })
      return true
    }

    // Correlated history is the success point. Reduce fresh authority and
    // release stale presentation in the same state notification.
    this.bootstrapBuffer.flush()
    let patch: Partial<ManagerWsState> = {}
    handleConversationEvent(event, {
      state: this.state,
      updateState: (next) => { patch = { ...patch, ...next } },
    })
    this.cancelConversationBootstrapWatchdog()
    this.recordConversationBootstrapTerminal(eventSubscriptionId, 'completed')
    // The correlated history is fresh authority, so a reset/clear suppression
    // can be released before capturing the replacement snapshot below.
    this.nonCapturableConversationAgentIds.delete(eventAgentId)
    if (this.stalePresentationAttachedAt !== null) {
      conversationBootstrapMetrics.staleDwell(Date.now() - this.stalePresentationAttachedAt)
      this.stalePresentationAttachedAt = null
    }
    this.updateState({
      ...patch,
      conversationPresentation: null,
      conversationBootstrap: {
        ...current,
        phase: 'ready',
        agentId: eventAgentId,
        servedView: event.servedConversationView!,
        protocolMode: 'correlated',
        errorCode: undefined,
        errorMessage: undefined,
      },
    })
    this.captureCurrentConversationSnapshot()
    return true
  }

  private deferWorkerThroughputEvent(
    event: Extract<ServerEvent, { type: 'generation_throughput' | 'generation_throughput_snapshot' }>,
  ): void {
    this.deferredWorkerThroughputEvents.push(event)
    if (this.deferredWorkerThroughputEvents.length > MAX_DEFERRED_WORKER_THROUGHPUT_EVENTS) {
      this.deferredWorkerThroughputEvents.shift()
    }
  }

  private flushDeferredWorkerThroughputEvents(sessionAgentId: string): void {
    const deferred = this.deferredWorkerThroughputEvents
    this.deferredWorkerThroughputEvents = []
    for (const event of deferred) {
      const eventSessionAgentId = event.type === 'generation_throughput'
        ? event.measurement.sessionId
        : event.sessionAgentId
      if (eventSessionAgentId !== sessionAgentId) {
        this.deferredWorkerThroughputEvents.push(event)
        continue
      }
      handleGenerationThroughputEvent(event, {
        state: this.state,
        applyGenerationThroughputReduction: (reduction) => this.applyGenerationThroughputReduction(reduction),
      })
    }
  }

  private applyGenerationThroughputReduction(reduction: GenerationThroughputReduction): void {
    if (!reduction.accepted) return
    this.updateState(reduction.patch)
    if (!reduction.terminal) return

    const timerKey = reduction.terminal.measurementId
    const existingTimer = this.generationTerminalCleanupTimers.get(timerKey)
    if (existingTimer) clearTimeout(existingTimer)
    const timer = setTimeout(() => {
      this.generationTerminalCleanupTimers.delete(timerKey)
      this.updateState(removeGenerationThroughputTombstone(this.state, reduction.terminal!))
    }, GENERATION_TERMINAL_SETTLE_MS)
    this.generationTerminalCleanupTimers.set(timerKey, timer)
  }

  private clearGenerationTerminalCleanupTimers(): void {
    for (const timer of this.generationTerminalCleanupTimers.values()) clearTimeout(timer)
    this.generationTerminalCleanupTimers.clear()
  }

  private clearGenerationThroughputForAgents(agentIds: Iterable<string>): void {
    this.updateState(clearGenerationThroughputForAgents(this.state, agentIds))
  }

  private applyAgentStatus(
    event: Extract<ServerEvent, { type: 'agent_status' }>,
  ): void {
    const result = reduceAgentStatus({ state: this.state, event })
    this.updateState(result.patch)

    if (result.queueSessionWorkersRefetchId) {
      this.sessionWorkerCache.queueRefetch(result.queueSessionWorkersRefetchId)
    }

    if (result.managerIdleTransitionAgentId) {
      handleManagerIdleTransition(result.managerIdleTransitionAgentId, result.nextState)
    }
  }

  private applyAgentsSnapshot(agents: AgentDescriptor[]): void {
    // A full agents snapshot is authoritative for managers. Workers may be
    // intentionally omitted and preserved by the worker cache, but a missing
    // manager (and every worker owned by it) is definitively removed.
    const incomingManagerIds = new Set(
      agents.filter((agent) => agent.role === 'manager').map((agent) => agent.agentId),
    )
    const removedManagerIds = new Set(
      this.state.agents
        .filter((agent) => agent.role === 'manager' && !incomingManagerIds.has(agent.agentId))
        .map((agent) => agent.agentId),
    )
    for (const agent of this.state.agents) {
      if (
        (agent.role === 'manager' && removedManagerIds.has(agent.agentId)) ||
        (agent.role === 'worker' && removedManagerIds.has(agent.managerId))
      ) this.invalidateConversationSnapshotAgent(agent.agentId)
    }

    const result = reduceAgentsSnapshot({
      state: this.state,
      desiredAgentId: this.desiredAgentId,
      explicitAgentSelectionAgentId: this.explicitAgentSelectionAgentId,
      agents,
    })

    for (const sessionAgentId of result.queueSessionWorkersRefetchIds) {
      this.sessionWorkerCache.queueRefetch(sessionAgentId)
    }

    if (result.shouldClearExplicitSelection) {
      this.hasExplicitAgentSelection = false
      this.explicitAgentSelectionAgentId = null
      this.explicitAgentSelectionPending = false
    }

    this.desiredAgentId = result.nextDesiredAgentId
    const nextAgentIds = new Set((result.patch.agents ?? this.state.agents).map((agent) => agent.agentId))
    const removedAgentIds = this.state.agents
      .filter((agent) => !nextAgentIds.has(agent.agentId))
      .map((agent) => agent.agentId)
    const throughputCleanup = clearGenerationThroughputForAgents(
      { ...this.state, ...result.patch },
      removedAgentIds,
    )
    const patch = { ...result.patch, ...throughputCleanup }

    if (result.subscribeToAgentId) {
      this.beginConversationSubscription({
        agentId: result.subscribeToAgentId,
        requestedView: this.conversationView,
        reason: 'fallback',
        patch,
        captureOutgoingSnapshot: false,
      })
    } else {
      this.updateState(patch)
    }
  }

  private applySessionWorkersSnapshot(
    sessionAgentId: string,
    workers: AgentDescriptor[],
    requestId?: string,
  ): void {
    this.sessionWorkerCache.applySessionWorkersSnapshot(sessionAgentId, workers)
    this.flushDeferredWorkerThroughputEvents(sessionAgentId)

    if (requestId) {
      this.requestDispatcher.tracker.resolve('get_session_workers', requestId, {
        sessionAgentId,
        workers,
      })
    }
  }

  private applySessionDeleted(agentId: string, profileId: string): void {
    const result = reduceSessionDeleted({
      state: this.state,
      agentId,
      profileId,
      socketOpen: isSocketOpen(this.socket),
    })

    this.sessionWorkerCache.clearQueuedRefetch(agentId)
    this.invalidateConversationSnapshotAgent(agentId)
    removeMutedAgent(result.mutedAgentIdToRemove)

    if (result.nextDesiredAgentId !== undefined) {
      this.hasExplicitAgentSelection = false
      this.explicitAgentSelectionAgentId = null
      this.explicitAgentSelectionPending = false
      this.desiredAgentId = result.nextDesiredAgentId
    }

    const removedAgentIds = this.state.agents
      .filter((agent) => agent.agentId === agentId || agent.managerId === agentId)
      .map((agent) => agent.agentId)
    const throughputCleanup = clearGenerationThroughputForAgents(this.state, removedAgentIds)
    const sessionAttentions = { ...this.state.sessionAttentions }
    delete sessionAttentions[agentId]
    const patch = { ...result.patch, ...throughputCleanup, sessionAttentions }

    if (result.subscribeToAgentId) {
      this.beginConversationSubscription({
        agentId: result.subscribeToAgentId,
        requestedView: this.conversationView,
        reason: 'fallback',
        patch,
        captureOutgoingSnapshot: false,
      })
    } else {
      this.updateState(patch)
    }
  }

  private pushSystemMessage(text: string): void {
    const message = createSystemConversationMessage(
      this.state.targetAgentId,
      this.state.subscribedAgentId,
      this.desiredAgentId,
      text,
    )
    this.updateState({ messages: [...this.state.messages, message] })
  }

  private send(command: ClientCommand): boolean {
    if (this.environmentClient) {
      if (!this.environmentClient.connection.getSnapshot().transportHealthy)
        return false
      // A repeated intent before its receipt is a retry of the same command, never a new one.
      const intentKey = environmentCommandIntentKey(command)
      const commandId = (intentKey && this.intentCommandIds.get(intentKey)) || crypto.randomUUID()
      if (intentKey) this.intentCommandIds.set(intentKey, commandId)
      void sendEnvironmentCommand(
        this.environmentClient,
        command,
        commandId,
        this.state.targetAgentId ?? this.desiredAgentId ?? undefined,
      )
        .then(({ events, receipt }) => {
          if (intentKey) this.intentCommandIds.delete(intentKey)
          if (receipt && isInterruptedReceipt(receipt))
            this.updateState({ lastError: interruptedCommandMessage(receipt.method) })
          for (const event of events) this.handleServerEvent(event)
        })
        .catch((error) => {
          if (intentKey && !isRetryableEnvironmentError(error)) this.intentCommandIds.delete(intentKey)
          this.updateState({
            lastError: error instanceof Error ? error.message : String(error),
          })
          this.requestDispatcher.rejectAllPendingRequests(
            error instanceof Error ? error.message : String(error),
          )
        })
      return true
    }
    return this.transport?.send(command) ?? false
  }

  /** Re-derives local message echoes and delivery states after a submit or receipt changes. */
  private refreshEnvironmentCommands(): void {
    if (!this.outbox) return
    const sessionId = this.state.targetAgentId
    const echoes = sessionId && this.environmentProjection?.session.sessionId === sessionId
      ? this.outbox.pendingMessages(sessionId, projectedCommandIds(this.environmentProjection))
      : []
    const previousEchoIds = this.outboxEchoIds
    this.outboxEchoIds = new Set(echoes.map((echo) => echo.clientRequestId!))
    const kept = this.state.messages.filter((message) =>
      !(message.type === 'conversation_message' && !message.id && message.clientRequestId && previousEchoIds.has(message.clientRequestId)))
    const firstChoice = kept.findIndex((message) => message.type === 'choice_request')
    const at = firstChoice < 0 ? kept.length : firstChoice
    this.updateState({
      messages: previousEchoIds.size || echoes.length ? [...kept.slice(0, at), ...echoes, ...kept.slice(at)] : this.state.messages,
      commandStatuses: this.outbox.statuses(),
    })
  }

  private mountEnvironmentDetail(sessionId: string): void {
    if (!this.environmentClient) return
    this.detailDetach?.()
    this.detailLease?.release()
    this.desiredAgentId = sessionId
    if (this.environmentClient.deviceSession()?.scopes.includes('session:operate') && this.environmentClient.descriptor()?.capabilities.sessionState)
      void this.sessionState('session.readState.set', { sessionId, read: true }).catch(error => this.reportSessionStateError(error))
    this.detailLease = this.environmentClient.acquireDetail(sessionId)
    const store = this.detailLease.store
    let projection: DetailState['projection'] = null
    let transient: DetailState['transient'] = new Map()
    const apply = () => {
      const detail = store.getSnapshot()
      if (detail.projection !== projection) {
        projection = detail.projection
        this.environmentProjection = projection
        if (projection?.plan) this.handleServerEvent({ type: 'session_plan_snapshot', sessionAgentId: sessionId, profileId: projection.session.projectId, ...projection.plan })
        if (projection?.goal) this.handleServerEvent({ type: 'session_goal_snapshot', sessionAgentId: sessionId, profileId: projection.session.projectId, ...projection.goal })
        if (projection?.recovery !== undefined) this.updateState({ restartRecovery: projection.recovery })
        const projectedMessages = projectDetailMessages(detail)
        const echoes = this.outbox?.pendingMessages(sessionId, projectedCommandIds(projection)) ?? []
        this.outboxEchoIds = new Set(echoes.map((echo) => echo.clientRequestId!))
        this.updateState({
          messages: [...projectedMessages,...echoes,...(projection?.choices??[]).filter(c=>c.status==='pending').map(c=>({type:'choice_request' as const,agentId:c.agentId,choiceId:c.choiceId,status:'pending' as const,questions:c.questions,timestamp:projection!.session.updatedAt}))],
          commandStatuses: this.outbox?.statuses(),
          pendingChoiceIds:new Set((projection?.choices??[]).filter(c=>c.status==='pending').map(c=>c.choiceId)),
          agents: projectSessionWorkers(this.state.agents, projection?.workers ?? [], sessionId, this.environmentClient!.shell.getSnapshot()),
          conversationPage:projection?{hasOlder:!!projection.historyCursor,...(projection.historyCursor?{nextCursor:projection.historyCursor}:{}),completeness:'complete',source:'canonical'}:null,
          conversationPageLoading:false,
          activityMessages: projectDetailActivity(detail),
          conversationPresentation: null,
          conversationHistoryMutation: {
            revision:
              (this.state.conversationHistoryMutation?.revision ?? 0) + 1,
            kind: 'replace',
          },
        })
      }
      for (const [key, event] of detail.transient)
        if (transient.get(key) !== event) this.handleServerEvent(projectFeatureEvent(event))
      transient = detail.transient
      if (detail.browser) this.updateBrowserSnapshot(detail.browser)
      const bootstrap = this.state.conversationBootstrap
      const phase = detail.freshness === 'live' ? 'ready' : 'pending'
      this.updateState({
        targetAgentId: sessionId,
        subscribedAgentId: sessionId,
        // Same session and phase keeps the same object, so an unchanged detail tick publishes nothing.
        conversationBootstrap: bootstrap.agentId === sessionId && bootstrap.phase === phase
          ? bootstrap
          : { ...bootstrap, agentId: sessionId, phase },
        planSnapshotLoadingSessionId: null,
        goalSnapshotLoadingSessionId: null,
        secureSessionSnapshotLoadingSessionId: null,
      })
    }
    apply()
    this.detailDetach = store.subscribe((s) => s, apply)
  }

  private updateState(patch: Partial<ManagerWsState>): void {
    if (Object.keys(patch).every(key => Object.is(patch[key as keyof ManagerWsState], this.state[key as keyof ManagerWsState]))) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }
}

function projectedCommandIds(projection: DetailState['projection']): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const item of projection?.items ?? []) if (item.commandId) ids.add(item.commandId)
  return ids
}

/** Only a transport failure leaves an intent unacknowledged; anything after a receipt settles it. */
function isRetryableEnvironmentError(error: unknown): boolean {
  return error instanceof EnvironmentRuntimeError && (error.retryable || error.code === 'UNAVAILABLE')
}

function interruptedCommandMessage(method: string): string {
  const action = method === 'session.choose' ? 'Choice response' : method === 'session.stop' ? 'Stop request' : 'Session launch'
  return `${action} was interrupted; delivery is unknown. Submit it again to resend.`
}
