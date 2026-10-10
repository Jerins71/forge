import type {
  AgentStatusEvent,
  AgentsSnapshotEvent,
  SessionWorkersSnapshotEvent,
} from './agent-events.js'
import type { BuilderSidebarOrderUpdatedEvent } from './builder-sidebar-order.js'
import type { CliServerEvent } from './cli.js'
import type { CodexElicitationDismissedEvent, CodexElicitationRequestEvent } from './codex-elicitation.js'
import type {
  ConversationEntry,
  MessagePinnedEvent,
} from './conversation-events.js'
import type {
  ModelConfigChangedEvent,
  PromptChangedEvent,
  SpecialistRosterChangedEvent,
  ModelCacheVisualizationSettingsChangedEvent,
} from './config-events.js'

import type {StopAllAgentsResultEvent} from './manager-events.js'

import type {
  UnreadCountUpdateEvent,
  UnreadCountsSnapshotEvent,
  UnreadNotificationEvent,
} from './notification-events.js'
import type {ProfilesSnapshotEvent} from './profile-events.js'
import type {
  SessionProjectAgentUpdatedEvent,
} from './project-agent-events.js'
import type {
  SessionArchivedEvent,
  SessionClearedEvent,
  SessionCreatedEvent,
  SessionDeletedEvent,
  SessionForkedEvent,
  SessionRestoredEvent,
  SessionResumedEvent,
  SessionStoppedEvent,
} from './session-events.js'
import type { SessionPlanSnapshotEvent } from './plans.js'
import type { SessionGoalSnapshotEvent } from './goals.js'
import type {
  SessionAttentionSnapshotEvent,
  SessionAttentionUpdateEvent,
} from './session-attention.js'
import type {
  TerminalClosedEvent,
  TerminalCreatedEvent,
  TerminalsSnapshotEvent,
  TerminalUpdatedEvent,
} from './terminal-types.js'
import type {
  ApiProxyResponseEvent,
  BootstrapFailedEvent,
  ConversationHistoryEvent,
  ConversationPageEvent,
  ConversationResetEvent,
  ErrorEvent,
  PendingChoicesSnapshotEvent,
  ReadyEvent,
} from './transport-events.js'
import type { RestartRecoverySnapshotEvent } from './restart-recovery.js'
import type {
  RemoteUpdateAwarenessProjectChangedEvent,
  RemoteUpdateAwarenessProjectClearedEvent,
} from './remote-update-awareness.js'
import type {
  SecureSecretCatalogChangedEvent,
  SecureSessionSnapshotEvent,
} from './secure-sessions.js'
import type { StreamDeckNavigationRequestedEvent } from './stream-deck.js'
import type {
  GenerationThroughputEvent,
  GenerationThroughputSnapshotEvent,
} from './generation-throughput.js'
import type { ManagerToolActivityEvent } from './manager-tool-activity.js'

// Compatibility re-exports from leaf modules
export * from './builder-sidebar-order.js'
export * from './browser-automation.js'
export * from './conversation-events.js'
export * from './agent-events.js'
export * from './cli.js'
export * from './manager-events.js'
export * from './repository-project.js'
export * from './session-attention.js'
export * from './session-events.js'
export * from './project-agent-events.js'
export * from './profile-events.js'
export * from './notification-events.js'
export * from './config-events.js'
export * from './plans.js'
export * from './goals.js'
export * from './transport-events.js'
export * from './restart-recovery.js'
export * from './remote-update-awareness.js'
export * from './secure-sessions.js'

export type ServerEvent =
  import('./builder-inventory.js').InventorySnapshotEvent
  | import('./builder-inventory.js').InventoryPongEvent
  | BuilderSidebarOrderUpdatedEvent
  | CliServerEvent
  | CodexElicitationRequestEvent
  | CodexElicitationDismissedEvent
  | ReadyEvent
  | ConversationResetEvent
  | ConversationHistoryEvent
  | ConversationPageEvent
  | PendingChoicesSnapshotEvent
  | BootstrapFailedEvent
  | RestartRecoverySnapshotEvent
  | RemoteUpdateAwarenessProjectChangedEvent
  | RemoteUpdateAwarenessProjectClearedEvent
  | SecureSessionSnapshotEvent
  | SecureSecretCatalogChangedEvent
  | StreamDeckNavigationRequestedEvent
  | GenerationThroughputEvent
  | GenerationThroughputSnapshotEvent
  | ManagerToolActivityEvent
  | SessionPlanSnapshotEvent
  | SessionGoalSnapshotEvent
  | SessionAttentionSnapshotEvent
  | SessionAttentionUpdateEvent
  | ConversationEntry
  | AgentStatusEvent
  | AgentsSnapshotEvent
  | SessionWorkersSnapshotEvent
  | ProfilesSnapshotEvent
  | UnreadNotificationEvent
  | UnreadCountsSnapshotEvent
  | UnreadCountUpdateEvent
  | SessionCreatedEvent
  | SessionStoppedEvent
  | SessionResumedEvent
  | SessionArchivedEvent
  | SessionRestoredEvent
  | SessionDeletedEvent
  | SessionClearedEvent
  | SessionProjectAgentUpdatedEvent
  | SessionForkedEvent
  | StopAllAgentsResultEvent
  | PromptChangedEvent
  | TerminalCreatedEvent
  | TerminalUpdatedEvent
  | TerminalClosedEvent
  | TerminalsSnapshotEvent
  | SpecialistRosterChangedEvent
  | ModelCacheVisualizationSettingsChangedEvent
  | ModelConfigChangedEvent
  | ApiProxyResponseEvent
  | MessagePinnedEvent
  | ErrorEvent
