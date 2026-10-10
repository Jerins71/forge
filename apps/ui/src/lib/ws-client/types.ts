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

export interface ManagerWsConversationEventContext {
  state: ManagerWsState
  updateState: (patch: Partial<ManagerWsState>) => void
}

export interface ManagerWsTerminalEventContext {
  state: ManagerWsState
  updateState: (patch: Partial<ManagerWsState>) => void
}

export type ConversationSubscriptionReason = 'selection' | 'view_change' | 'refresh' | 'reconnect' | 'create' | 'fork' | 'fallback' | 'retry'
