import { projectPanelRevealRequest } from './ws-client/browser-state'
import { projectFeatureEvent } from './ws-client/environment-feature-projection'
import type { ContextSourceSelector, RpcInput, RpcOutput } from '@forge/protocol/environment-v2'
import { contextTransferAvailability, type ForkTransferSelection, type SessionTransferModel } from './ws-client/context-transfers'
import { EnvironmentRuntimeError, type EnvironmentClient, type DetailState } from '@forge/client-runtime'
import {
  projectShell,
  projectSession,
  projectItems,
  withChoicesInTimelineOrder,
  projectActivityItems,
  projectWorker,
  projectSessionWorkers,
} from './ws-client/environment-projection'
import { LiveActivityStore } from './ws-client/live-activity-store'
import { getCatalogModelsByFamily } from '@forge/protocol'
import type { CommandReceipt } from '@forge/protocol/environment-v2'
import { EnvironmentOutbox } from './ws-client/environment-outbox'
import { whenSettled } from './settled-request'
import type { CodexElicitationDecision, CodexElicitationPersistScope, SessionGoalControlAction, SessionProjectAgentInput, WorkModeId } from '@forge/protocol'
import type { ConversationSubscriptionReason } from './ws-client/types'
import { applyLoadedModelCacheVisualizationSetting as reduceLoadedModelCacheVisualizationSetting } from './ws-client/model-cache-visualization-state'
const GENERATION_TERMINAL_SETTLE_MS = 5_000

/** Server close code for a permanently invalidated collaboration session. */

/** How long an optimistic send may wait for its server echo before expiring. */

import {
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
import { normalizeAgentId } from './ws-client/utils'
import {
  createInitialManagerWsState,
  type ManagerWsState,
} from './ws-state'
import {
  applySecureSessionSnapshot as reduceSecureSessionSnapshot,
  applyDetailFeature,
} from './ws-client/detail-feature-state'
import { handleTerminalEvent } from './ws-client/event-handlers/terminal-event-handlers'
import { handleGenerationThroughputEvent } from './ws-client/event-handlers/generation-throughput-event-handlers'
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
  conversationBootstrapWatchdogMs?: number
}

export class ManagerWsClient {
  /** Live tool and reasoning rows of the mounted session; updated per frame, outside `state`. */
  readonly liveActivity = new LiveActivityStore()
  private readonly environmentClient?: EnvironmentClient
  private readonly environmentDetach: Array<() => void> = []
  /** In-flight read and attention upkeep for the session in view, keyed per intent. */
  private readonly viewedSessionRequests = new Set<string>()
  private keptUnreadSessionId: string | null = null
  private viewedSessionId: string | null = null
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
  /** Bounded metric guard: only the current/most-recent subscription can terminal twice. */
  /** Destructive requests suppress recapture until fresh history replaces authority. */

  private hasExplicitAgentSelection = false
  private explicitAgentSelectionAgentId: string | null = null
  private explicitAgentSelectionPending = false
  private rejectedExplicitAgentSelectionId: string | null = null
  private readonly optimisticSendExpiryTimers = new Set<ReturnType<typeof setTimeout>>()
  private readonly generationTerminalCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Worker telemetry that arrived before this connection received its roster. */

  private state: ManagerWsState
  private readonly listeners = new Set<Listener>()

  private browserHostRegistration: BrowserHostRegistration | null = null
  private browserHostDetach: (() => void) | null = null

  constructor(_url: string, initialAgentId?: string | null, options: ManagerWsClientOptions = {},
  ) {
    const normalizedInitialAgentId = normalizeAgentId(initialAgentId)
    this.desiredAgentId = normalizedInitialAgentId
    this.environmentClient = options.environmentClient
    this.state = createInitialManagerWsState(normalizedInitialAgentId)

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
        this.updateState({ ...projectShell(shell, this.state.agents, this.state.profiles, this.state.unreadCounts, this.state.sessionAttentions), restartRecovery: shell.recovery ?? null });
        this.keepViewedSessionRead()
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
      if (typeof window !== 'undefined') {
        // Coming back to the window is when a reply that arrived meanwhile gets read.
        const onAttention = () => this.keepViewedSessionRead()
        window.addEventListener('focus', onAttention)
        document.addEventListener('visibilitychange', onAttention)
        this.environmentDetach.push(() => { window.removeEventListener('focus', onAttention); document.removeEventListener('visibilitychange', onAttention) })
      }
      if (normalizedInitialAgentId)
        this.subscribeToAgent(normalizedInitialAgentId)
    }
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
    // An explicit "mark unread" on the session in view holds until it is opened again.
    this.keptUnreadSessionId = agentId
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

  /** The session whose chat is on screen, or null while another view covers it. */
  setViewedSession(sessionId: string | null): void {
    if (this.viewedSessionId === sessionId) return
    this.viewedSessionId = sessionId
    this.keptUnreadSessionId = null
    this.keepViewedSessionRead()
  }

  /**
   * The session on screen is being read. While the page is visible and focused, its unread count and
   * its "work finished" attention are cleared as they appear; streams never mark anything read.
   * A decision or failure keeps its attention until the user acts on it.
   */
  private keepViewedSessionRead(): void {
    const client = this.environmentClient
    const sessionId = this.viewedSessionId
    if (!client || !sessionId || sessionId !== this.environmentProjection?.session.sessionId || typeof document === 'undefined' || document.visibilityState !== 'visible' || !document.hasFocus()) return
    if (!client.deviceSession()?.scopes.includes('session:operate') || !client.descriptor()?.capabilities.sessionState) return
    const summary = client.shell.getSnapshot().sessions.get(sessionId)
    if (!summary) return
    const clear = (key: string, send: () => Promise<unknown>) => {
      if (this.viewedSessionRequests.has(key)) return
      this.viewedSessionRequests.add(key)
      // Background upkeep: a failure is retried by the next shell change, never shown as a session error.
      void send().then(() => true, () => false).then(done => { this.viewedSessionRequests.delete(key); if (done) this.keepViewedSessionRead() })
    }
    if (summary.unread > 0 && this.keptUnreadSessionId !== sessionId) clear(`read:${sessionId}`, () => this.sessionState('session.readState.set', { sessionId, read: true }))
    const occurrence = summary.attentionOccurrence
    if (occurrence && ['work_settled', 'plan_completed', 'work_graph_completed'].includes(occurrence.reason))
      clear(`attention:${occurrence.attentionId}`, () => this.sessionState('session.attention.dismiss', { occurrenceIds: [occurrence.attentionId] }))
  }

  private async sessionState<M extends 'session.update' | 'session.message.pin' | 'session.pins.clear' | 'session.readState.set' | 'project.readState.clear' | 'session.attention.dismiss'>(method: M, input: Omit<RpcInput<M>, 'commandId'>): Promise<CommandReceipt> {
    const client = this.environmentClient
    if (!client?.descriptor()?.capabilities.sessionState) throw new Error('Update this environment to manage pins and read state')
    const key = JSON.stringify([method, input])
    const commandId = this.intentCommandIds.get(key) ?? crypto.randomUUID()
    this.intentCommandIds.set(key, commandId)
    const receipt = await whenSettled(() => client.request(method, { ...input, commandId } as RpcInput<M>))
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

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.state)

    return () => {
      this.listeners.delete(listener)
    }
  }

  destroy(): void {
    this.detailDetach?.()
    this.detailLease?.release()
    this.detailDetach = null
    this.detailLease = null
    for (const detach of this.environmentDetach) detach()
    for (const timer of this.optimisticSendExpiryTimers) {
      clearTimeout(timer)
    }
    this.optimisticSendExpiryTimers.clear()
    this.clearGenerationTerminalCleanupTimers()
    this.detachEnvironmentBrowserHost()

  }

  subscribeToAgent(agentId: string, options?: { explicit?: boolean; reason?: ConversationSubscriptionReason }): void {
 const id = agentId.trim(); if (!id || !this.environmentClient || this.detailLease && this.desiredAgentId === id) return;
 this.hasExplicitAgentSelection = options?.explicit ?? true;
 this.explicitAgentSelectionAgentId = this.hasExplicitAgentSelection ? id : null;
 this.mountEnvironmentDetail(id);
 }

  retryConversationBootstrap(): boolean { if (!this.environmentClient || !this.state.targetAgentId) return false; this.mountEnvironmentDetail(this.state.targetAgentId); return true; }

  setConversationView(view: BuilderTimelineChannelView): boolean { void view; return false; }

  sendUserMessage(text: string, options?: { agentId?: string; artifactIds?: string[]; delivery?: DeliveryMode; attachments?: ConversationAttachment[]; replyTo?: ConversationReplyTargetInput; sessionReferenceAgentIds?: string[] }): void {
 const sessionId = options?.agentId ?? this.state.targetAgentId;
 if (!sessionId || !this.outbox) { this.updateState({ lastError: 'No session selected' }); return; }
 this.outbox.submit(sessionId, text, options?.attachments ?? [], options?.artifactIds ?? []);
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
 const owner = this.state.agents.find(agent => agent.agentId === agentId);
 const sessionId = owner?.role === 'worker' ? owner.managerId : agentId;
 void this.lifecycle('session.choose', { sessionId, choiceId, answers }).catch(error => this.reportSessionStateError(error));
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

  deleteAgent(agentId: string, ownerSessionId?: string): void {
    const workerId = agentId.trim()
    const sessionId = ownerSessionId ?? this.state.agents.find(agent => agent.agentId === workerId)?.managerId ?? this.environmentProjection?.session.sessionId ?? this.desiredAgentId
    if (!workerId || !sessionId) return
    void this.lifecycle('worker.kill', { sessionId, workerId }).then(() => this.getSessionWorkers(sessionId)).catch(error => this.updateState({ lastError: error instanceof Error ? error.message : 'Worker kill failed' }))
  }
  async stopAllAgents(managerId: string): Promise<{ managerId: string; stoppedWorkerIds: string[]; managerStopped: boolean }> {
    const receipt = await this.lifecycle('session.stopAll', { sessionId: managerId })
    return { managerId, stoppedWorkerIds: receipt.result?.stoppedWorkerIds ?? [], managerStopped: receipt.result?.managerStopped ?? false }
  }
  private async lifecycle<M extends Extract<CommandReceipt['method'], 'session.launch' | 'session.choose' | 'session.stop' | 'session.stopAll' | 'session.resume' | 'session.archive' | 'session.restore' | 'session.clear' | 'session.delete' | 'session.fork' | 'session.provider.switch' | 'session.mergeBack' | 'worker.continue' | 'session.choice.cancel' | 'worker.stop' | 'worker.resume' | 'worker.kill'>>(method: M, input: Omit<RpcInput<M>, 'commandId'>): Promise<CommandReceipt> {
    if (!this.environmentClient) throw new Error('A paired environment is required')
    const key = JSON.stringify([method, input])
    const commandId = this.intentCommandIds.get(key) ?? crypto.randomUUID()
    this.intentCommandIds.set(key, commandId)
    try {
      let receipt = await whenSettled(() => this.environmentClient!.request(method, { ...input, commandId } as RpcInput<M>))
      const started = Date.now()
      // A stop stays running while the environment waits for the runtime to exit, then succeeds or
      // explains why it could not. Outwait that bound; reporting a slow exit as a failure would be false.
      const deadline = started + (method === 'session.stop' || method === 'worker.kill' ? 120_000 : 10_000)
      while (receipt.state === 'accepted' || receipt.state === 'running') {
        if (Date.now() >= deadline) throw new EnvironmentRuntimeError('UNAVAILABLE', 'Session operation is still settling; retry to inspect its receipt', true)
        await new Promise(resolve => setTimeout(resolve, Date.now() - started < 10_000 ? 25 : 250))
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
    const receipt = await whenSettled(() => this.environmentClient!.request(method, { ...input, commandId } as RpcInput<M>))
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

  async createSession(profileId: string, name?: string, opts?: { sessionPurpose?: AgentSessionPurpose; label?: string }): Promise<SessionCreatedResult> {
 if (opts?.sessionPurpose) throw new Error('Controlled session purpose is unsupported');
 if (!this.environmentClient) throw new Error('Paired environment is required');
 const receipt = await this.lifecycle('session.launch', { projectId: profileId, title: opts?.label ?? name ?? 'New session', workspaceStrategy: { kind: 'current_checkout' } });
 if (!receipt.sessionId) throw new Error('Session preparation is pending; inspect its command receipt');
 const shell = this.environmentClient.shell.getSnapshot();
 const summary = shell.sessions.get(receipt.sessionId) ?? { sessionId: receipt.sessionId, projectId: profileId, title: opts?.label ?? name ?? 'New session', status: 'preparing' as const, attention: 'none' as const, unread: 0, workerCount: 0, updatedAt: receipt.updatedAt, sortKey: receipt.sessionId, archived: false, workspace: { kind: 'current_checkout' as const, cwd: null, branch: null } };
 const profile = projectShell(shell, []).profiles.find(profile => profile.profileId === profileId);
 if (!profile) throw new Error('Created session project is missing');
 return { sessionAgent: projectSession(summary, shell), profileId };
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

  /** A session action's failure belongs to that session; it is shown only while that session is in view. */
  reportSessionError(agentId: string, message: string): void {
    const session = (id: string) => this.state.agents.find(agent => agent.agentId === id && agent.role === 'worker')?.managerId ?? id
    if (this.state.targetAgentId && session(this.state.targetAgentId) === session(agentId)) this.updateState({ lastError: message })
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
    return { agentId, profileId: receipt.projectId!, archivedAt: receipt.result?.archivedAt ?? receipt.updatedAt }
  }
  async restoreSession(agentId: string): Promise<SessionRestoreResult> {
    const receipt = await this.lifecycle('session.restore', { sessionId: agentId })
    return { agentId, profileId: receipt.projectId!, openAgentId: receipt.result?.openAgentId }
  }
  async deleteSession(agentId: string): Promise<SessionActionResult> {
    await this.lifecycle('session.delete', { sessionId: agentId })
    return { agentId }
  }
  async clearSession(agentId: string): Promise<SessionActionResult> {
    await this.lifecycle('session.clear', { sessionId: agentId })
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
    return { profileId, archivedAt: receipt.updatedAt }

  }

  async restoreProfile(profileId: string): Promise<ProfileRestoreResult> {
    const receipt = await this.policy('project.restore', { projectId: profileId })
    return { profileId, openAgentId: receipt.result?.sessionId ?? '' }

  }

  /** A source point or model makes the fork a context transfer; the source point then replaces the legacy item cut. */
  async forkSession(sourceAgentId: string, label?: string, fromMessageId?: string, options?: { sessionPurpose?: 'side_chat' } & ForkTransferSelection): Promise<SessionForkedResult> {
    if (options?.sourcePoint || options?.model) this.requireContextTransfers()
    const receipt = await this.lifecycle('session.fork', { sessionId: sourceAgentId, ...(label ? { title: label } : {}), ...(options?.sourcePoint ? { sourcePoint: options.sourcePoint } : fromMessageId ? { fromItemId: fromMessageId } : {}), ...(options?.model ? { model: options.model } : {}), ...(options?.sessionPurpose ? { purpose: options.sessionPurpose } : {}) })
    const sessionId = receipt.result?.sessionId ?? receipt.sessionId
    if (!sessionId) throw new Error('Session fork has no reserved identity')
    const shell = this.environmentClient!.shell.getSnapshot()
    const source = shell.sessions.get(sourceAgentId)
    const summary = shell.sessions.get(sessionId) ?? (source && { ...source, sessionId, title: label ?? source.title, status: 'idle' as const, archived: false, updatedAt: receipt.updatedAt })
    if (!summary) throw new Error('Session fork is awaiting shell synchronization')
    return { sourceAgentId, newSessionAgent: projectSession(summary, shell) }
  }

  /** The run a mounted detail item belongs to, when the environment reports it. */
  itemRunId(itemId: string): string | undefined {
    return this.environmentProjection?.items.find(item => item.itemId === itemId)?.runId
  }
  private requireContextTransfers(): void {
    const availability = contextTransferAvailability(this.environmentClient)
    if (!availability.available) throw new Error(availability.reason)
  }
  /** Hands the same session off to another provider or model; never a new conversation. */
  async switchSessionProvider(agentId: string, model: SessionTransferModel): Promise<SessionActionResult> {
    this.requireContextTransfers()
    await this.lifecycle('session.provider.switch', { sessionId: agentId, model })
    return { agentId }
  }
  /** The environment infers the target from the session's lineage parent. */
  async mergeBackSession(agentId: string, sourcePoint?: ContextSourceSelector): Promise<SessionActionResult> {
    this.requireContextTransfers()
    await this.lifecycle('session.mergeBack', { sessionId: agentId, ...(sourcePoint ? { sourcePoint } : {}) })
    return { agentId }
  }
  /** Continues a finished worker as a normal conversation whose identity comes from the receipt. */
  async continueWorker(workerId: string, title?: string): Promise<{ workerId: string; sessionAgentId: string }> {
    this.requireContextTransfers()
    const sessionId = this.state.agents.find(agent => agent.agentId === workerId && agent.role === 'worker')?.managerId
    if (!sessionId) throw new Error('Worker is not part of a loaded session')
    const receipt = await this.lifecycle('worker.continue', { sessionId, workerId, ...(title ? { title } : {}) })
    const sessionAgentId = receipt.result?.sessionId
    if (!sessionAgentId) throw new Error('Continued worker has no conversation identity')
    return { workerId, sessionAgentId }
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
 if (!this.environmentClient) throw new Error('Paired environment is required');
 const output = await this.environmentClient.request('session.workers', { sessionId: sessionAgentId });
 this.updateState({ agents: projectSessionWorkers(this.state.agents, output.workers, sessionAgentId, this.environmentClient.shell.getSnapshot()),
   workerMetadataSessionIds: new Set(this.state.workerMetadataSessionIds).add(sessionAgentId) });
 return { sessionAgentId, workers: output.workers.map(worker => projectWorker(worker, sessionAgentId, this.environmentClient!.shell.getSnapshot())) };
 }

  async loadOlderConversation(limit?: number): Promise<ConversationPageResult | null> {
 if (!this.environmentClient || this.state.conversationBootstrap.phase !== 'ready') return null;
 const agentId = this.state.targetAgentId; const cursor = this.state.conversationPage?.nextCursor;
 if (!agentId || !cursor || !this.state.conversationPage?.hasOlder || this.state.conversationPageLoading) return null;
 this.updateState({ conversationPageLoading: true, lastError: null });
 try {
 const page = await this.environmentClient.request('session.history', { sessionId: agentId, before: cursor, turns: Math.min(20, Math.max(1, limit ?? 20)) });
 const ownerId = this.environmentProjection?.session.sessionId ?? agentId;
 const items = page.items.filter(item => ownerId === agentId || item.actorId === agentId);
 const messages = projectItems(items, agentId, ownerId);
 const result: ConversationPageResult = { agentId, messages, page: { hasOlder: !!page.nextCursor, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), completeness: 'complete', source: 'canonical' } };
 if (this.state.targetAgentId === agentId) this.updateState({ messages: [...messages, ...this.state.messages], activityMessages: [...projectActivityItems(items, ownerId), ...this.state.activityMessages], conversationPage: result.page, conversationPageLoading: false, conversationHistoryMutation: { revision: (this.state.conversationHistoryMutation?.revision ?? 0) + 1, kind: 'prepend' } });
 return result;
 } catch (error) { if (this.state.targetAgentId === agentId) this.updateState({ conversationPageLoading: false, lastError: error instanceof Error ? error.message : String(error) }); throw error; }
 }

  refreshConversationHistory(): boolean { return this.retryConversationBootstrap(); }


  private handleServerEvent(parsed: unknown): void {
 const event = parsed as ServerEvent;
 if (event.type === 'timeline_activity') {
   // The durable row supersedes its live one; a late live update must not bring it back.
   if (!this.environmentProjection?.items.some(item => item.activity?.itemId === event.item.itemId)) this.liveActivity.upsert(event.item);
   // A row that finishes after the timeline last changed still has to give way to its durable form.
   if (event.item.status !== 'running') this.liveActivity.reconcile(new Set(), this.environmentProjection?.session.status === 'running');
   return;
 }
 if (handleGenerationThroughputEvent(event, { state: this.state, applyGenerationThroughputReduction: reduction => this.applyGenerationThroughputReduction(reduction) })) return;
 if (handleTerminalEvent(event, { state: this.state, updateState: patch => this.updateState(patch) })) return;
 applyDetailFeature(event, { state: this.state, updateState: patch => this.updateState(patch) });
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
    this.updateState({
      // Choices hold their place in the timeline, so a message still being sent is always the newest row.
      messages: previousEchoIds.size || echoes.length ? [...kept, ...echoes] : this.state.messages,
      commandStatuses: this.outbox.statuses(),
    })
  }

  private mountEnvironmentDetail(sessionId: string): void {
    if (!this.environmentClient) return
    this.detailDetach?.()
    this.detailLease?.release()
    this.liveActivity.clear()
    this.desiredAgentId = sessionId
    this.detailLease = this.environmentClient.acquireDetail(sessionId)
    const store = this.detailLease.store
    // Lineage and a reported error belong to one session; never present the previous session's on this one.
    this.updateState({ sessionLineage: null, sessionTransferCapabilities: null, ...(this.state.targetAgentId && this.state.targetAgentId !== sessionId ? { lastError: null } : {}) })
    let projection: DetailState['projection'] = null
    let transient: DetailState['transient'] = new Map()
    const apply = () => {
      const detail = store.getSnapshot()
      if (detail.projection !== projection) {
        projection = detail.projection
        this.environmentProjection = projection
        this.keepViewedSessionRead()
        if (projection?.plan) this.handleServerEvent({ type: 'session_plan_snapshot', sessionAgentId: sessionId, profileId: projection.session.projectId, ...projection.plan })
        if (projection?.goal) this.handleServerEvent({ type: 'session_goal_snapshot', sessionAgentId: sessionId, profileId: projection.session.projectId, ...projection.goal })
        if (projection?.recovery !== undefined) this.updateState({ restartRecovery: projection.recovery })
        const capabilities = projection?.session.transferCapabilities ?? null, previous = this.state.sessionTransferCapabilities
        this.updateState({
          sessionLineage: projection?.lineage ?? null,
          // The same declaration keeps its identity so consumers do not re-render on every detail tick.
          sessionTransferCapabilities: capabilities && previous && JSON.stringify(capabilities) === JSON.stringify(previous) ? previous : capabilities,
        })
        this.liveActivity.reconcile(new Set((projection?.items ?? []).flatMap(item => item.activity ? [item.activity.itemId] : [])), projection?.session.status === 'running')
        // A worker is mounted through its owning session and shows only its own rows.
        const ownerId = projection?.session.sessionId ?? sessionId
        const items = (projection?.items ?? []).filter(item => ownerId === sessionId || item.actorId === sessionId)
        const projectedMessages = projectItems(items, sessionId, ownerId)
        const echoes = this.outbox?.pendingMessages(sessionId, projectedCommandIds(projection)) ?? []
        this.outboxEchoIds = new Set(echoes.map((echo) => echo.clientRequestId!))
        this.updateState({
          messages: [...withChoicesInTimelineOrder(projectedMessages, projection?.choices ?? [], !!projection?.historyCursor), ...echoes],
          commandStatuses: this.outbox?.statuses(),
          pendingChoiceIds:new Set((projection?.choices??[]).filter(c=>c.status==='pending').map(c=>c.choiceId)),
          agents: projectSessionWorkers(this.state.agents, projection?.workers ?? [], ownerId, this.environmentClient!.shell.getSnapshot()),
          conversationPage:projection?{hasOlder:!!projection.historyCursor,...(projection.historyCursor?{nextCursor:projection.historyCursor}:{}),completeness:'complete',source:'canonical'}:null,
          conversationPageLoading:false,
          activityMessages: projectActivityItems(items, ownerId),
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
