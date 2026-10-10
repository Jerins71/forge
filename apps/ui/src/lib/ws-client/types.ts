import type { WsRequestTracker } from '../ws-request-tracker'
import type {
  AgentDescriptor,
  PersistedProjectAgentConfig,
  ProjectAgentConfigSourceSnapshot,
  ProjectAgentExternalDirectoryEntry,
  ProjectAgentInfo,
  ProjectAgentShareEligibleTarget,
  ProjectAgentShareGrantInfo,
  ConversationEntry,
  ConversationHistoryPageMetadata,
  InventorySnapshotEvent,
} from '@forge/protocol'
import type { ManagerWsState } from '../ws-state'

export interface DirectoriesListedResult {
  path: string
  directories: string[]
  requestedPath?: string
  resolvedPath?: string
  parentPath?: string | null
  roots?: string[]
  entries?: Array<{ name: string; path: string }>
}

export interface DirectoryValidationResult {
  path: string
  valid: boolean
  message: string | null
  resolvedPath?: string
  roots?: string[]
}

export interface DirectoryCreatedResult {
  path: string
  parentPath: string
  name: string
  roots?: string[]
}

export type Listener = (state: ManagerWsState) => void

export type SessionCreatedResult = { sessionAgent: AgentDescriptor; profileId: string }
export type SessionActionResult = { agentId: string }
export type SessionArchiveResult = { agentId: string; profileId: string; archivedAt: string }
export type SessionRestoreResult = { agentId: string; profileId: string; openAgentId?: string }
export type ProfileArchiveResult = { profileId: string; archivedAt: string }
export type ProfileRestoreResult = { profileId: string; openAgentId: string }
export type SessionForkedResult = { sourceAgentId: string; newSessionAgent: AgentDescriptor }
export type SessionWorkersResult = { sessionAgentId: string; workers: AgentDescriptor[] }
export type ConversationPageResult = {
  agentId: string
  messages: ConversationEntry[]
  page: ConversationHistoryPageMetadata
}

export type SessionProjectAgentResult = {
  agentId: string
  profileId: string
  projectAgent: ProjectAgentInfo | null
}

export type ProjectAgentConfigResult = {
  agentId: string
  config: PersistedProjectAgentConfig
  systemPrompt: string | null
  references: string[]
  source?: ProjectAgentConfigSourceSnapshot
}

export type ProjectAgentReferencesResult = { agentId: string; references: string[] }
export type ProjectAgentReferenceResult = { agentId: string; fileName: string; content: string; revision: string | null }
export type ProjectAgentReferenceSavedResult = { agentId: string; fileName: string; revision: string | null }
export type ProjectAgentReferenceDeletedResult = { agentId: string; fileName: string; revision: string | null }

export type ProjectAgentSharingResult = {
  agentId: string
  grants: ProjectAgentShareGrantInfo[]
  eligibleTargets: ProjectAgentShareEligibleTarget[]
}

export type ProjectAgentSharingUpdatedResult = ProjectAgentSharingResult & {
  addedTargetProfileIds: string[]
  removedTargetProfileIds: string[]
}

export type ProjectAgentExternalDirectoryResult = {
  profileId: string
  entries: ProjectAgentExternalDirectoryEntry[]
}

export type WsRequestResultMap = {

  stop_all_agents: { managerId: string; stoppedWorkerIds: string[]; managerStopped: boolean }
  create_session: SessionCreatedResult
  stop_session: SessionActionResult
  resume_session: SessionActionResult
  archive_session: SessionArchiveResult
  restore_session: SessionRestoreResult
  delete_session: SessionActionResult
  clear_session: SessionActionResult
  subscribe_inventory: InventorySnapshotEvent

  fork_session: SessionForkedResult
  get_session_workers: SessionWorkersResult
  get_conversation_page: ConversationPageResult

}

export type WsRequestType = Extract<keyof WsRequestResultMap, string>

export interface WsRequestErrorHint {
  requestType: WsRequestType
  codeFragment: string
}

export type RequestTrackerAdapter = Pick<
  WsRequestTracker<WsRequestResultMap>,
  'resolve' | 'reject' | 'getPendingRequestType' | 'rejectByRequestId' | 'rejectOldest' | 'rejectOnlyPending'
>

export interface ManagerWsConversationEventContext {
  state: ManagerWsState
  updateState: (patch: Partial<ManagerWsState>) => void
}

export interface ManagerWsTerminalEventContext {
  state: ManagerWsState
  updateState: (patch: Partial<ManagerWsState>) => void
}

export interface ManagerWsAgentEventContext {
  applyAgentStatus: (event: Extract<import('@forge/protocol').ServerEvent, { type: 'agent_status' }>) => void
  applyAgentsSnapshot: (agents: AgentDescriptor[]) => void
  applySessionWorkersSnapshot: (
    sessionAgentId: string,
    workers: AgentDescriptor[],
    requestId?: string,
  ) => void
  requestTracker: RequestTrackerAdapter

}

export interface ManagerWsSessionEventContext {
  applySessionDeleted: (agentId: string, profileId: string) => void
  requestTracker: RequestTrackerAdapter
}

export interface ManagerWsSessionAttentionEventContext {
  state: ManagerWsState
  updateState: (patch: Partial<ManagerWsState>) => void
  requestTracker: RequestTrackerAdapter
}



export interface ManagerWsConfigEventContext {
  state: ManagerWsState
  updateState: (patch: Partial<ManagerWsState>) => void
  requestTracker: RequestTrackerAdapter
}

export interface ManagerWsSystemEventContext {
  requestTracker: Pick<RequestTrackerAdapter, 'resolve'>
  updateState: (patch: Partial<ManagerWsState>) => void
  pushSystemMessage: (text: string) => void
  /** Utility browser command errors reject their caller but are not chat events. */
  rejectPendingFromError: (code: string, message: string, requestId?: string) => void
}
