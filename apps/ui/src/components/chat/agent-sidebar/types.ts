import type {
  AgentContextUsage,
  AgentDescriptor,
  BuilderSidebarOrderRef,
  AgentStatus,
  ManagerExactModelSelection,
  ManagerReasoningLevel,
  ManagerProfile,
  ProjectAgentConfigSourceSnapshot,
  ProjectAgentInfo,
  ProjectAgentShareEligibleTarget,
  ProjectAgentShareGrantInfo,
  PersistedProjectAgentConfig,
  SessionModelUpdateMode,
  SessionProjectAgentInput,
} from '@forge/protocol'
import type { DirectoryValidationResult } from '@/lib/ws-client'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core'
import type { ProfileTreeRow, SessionRow } from '@/lib/agent-hierarchy'
import type { EnvironmentSessionNavigation } from './LogicalProjectGroup'

export type AgentLiveStatus = {
  status: AgentStatus
  pendingCount: number
}

export type StatusMap = Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage; contextRecoveryInProgress?: boolean }>

export interface AgentSidebarProps {
  connected: boolean
  modelConfigChangeKey?: number
  connectionEpoch?: number
  agents: AgentDescriptor[]
  profiles: ManagerProfile[]
  statuses: StatusMap
  unreadCounts: Record<string, number>
  terminalScopeId?: string | null
  terminalCount?: number
  selectedAgentId: string | null
  isSettingsActive: boolean
  isStatsActive?: boolean
  isArchiveActive?: boolean
  isMobileOpen?: boolean
  onMobileClose?: () => void
  onAddManager: () => void
  onSelectAgent: (agentId: string) => void
  onDeleteAgent: (agentId: string, ownerSessionId?: string) => void
  onDeleteManager: (managerId: string) => void
  onOpenSettings: () => void
  onOpenProjectSettings?: (profileId: string) => void
  onOpenProjectSecrets?: (profileId: string) => void
  onOpenStats?: () => void
  onOpenArchive?: () => void
  onCreateSession?: (profileId: string, name?: string) => void
  onStopSession?: (agentId: string) => void
  onResumeSession?: (agentId: string) => void
  onDeleteSession?: (agentId: string) => void
  onArchiveSession?: (agentId: string) => void
  onArchiveProfile?: (profileId: string) => void
  onRenameSession?: (agentId: string, label: string) => void
  /** Absent when the environment cannot regenerate titles. */
  onRegenerateSessionTitle?: (agentId: string) => Promise<void>
  onPinSession?: (agentId: string, pinned: boolean) => void
  onRenameProfile?: (profileId: string, displayName: string) => void
  onForkSession?: (sourceAgentId: string, name?: string) => void
  forkDisabledReasonFor?: (agentId: string) => string | undefined
  workerContinuation?: WorkerContinuation
  onMarkUnread?: (agentId: string) => void
  onMarkAllRead?: (profileId: string) => void
  onUpdateManagerModel?: (profileId: string, modelSelection: ManagerExactModelSelection, reasoningLevel?: ManagerReasoningLevel) => void
  onUpdateSessionModel?: (sessionAgentId: string, mode: SessionModelUpdateMode, modelSelection?: ManagerExactModelSelection, reasoningLevel?: ManagerReasoningLevel) => void
  onUpdateManagerCwd?: (managerId: string, cwd: string) => Promise<void>
  onBrowseDirectory?: (defaultPath: string) => Promise<string | null>
  onValidateDirectory?: (path: string) => Promise<DirectoryValidationResult>
  onRequestSessionWorkers?: (sessionId: string) => void
  /** Reconciled local-instance authority, including hidden/offline anchors. */
  builderSidebarOrder?: BuilderSidebarOrderRef[]
  onMoveBuilderProject?: (active: BuilderSidebarOrderRef, over: BuilderSidebarOrderRef) => void
  onSetSessionProjectAgent?: (agentId: string, projectAgent: SessionProjectAgentInput | null) => Promise<void>
  onGetProjectAgentConfig?: (agentId: string) => Promise<{ agentId: string; config: PersistedProjectAgentConfig; systemPrompt: string | null; references: string[]; source?: ProjectAgentConfigSourceSnapshot }>
  onGetProjectAgentSharing?: (agentId: string) => Promise<{ agentId: string; grants: ProjectAgentShareGrantInfo[]; eligibleTargets: ProjectAgentShareEligibleTarget[] }>
  onSetProjectAgentSharing?: (agentId: string, targetProfileIds: string[]) => Promise<{ agentId: string; grants: ProjectAgentShareGrantInfo[]; eligibleTargets: ProjectAgentShareEligibleTarget[]; addedTargetProfileIds: string[]; removedTargetProfileIds: string[] }>
  onListProjectAgentReferences?: (agentId: string) => Promise<{ agentId: string; references: string[] }>
  onGetProjectAgentReference?: (agentId: string, fileName: string) => Promise<{ agentId: string; fileName: string; content: string; revision: string | null }>
  onSetProjectAgentReference?: (agentId: string, fileName: string, content: string, expectedRevision: string | null) => Promise<{ agentId: string; fileName: string; revision: string | null }>
  onDeleteProjectAgentReference?: (agentId: string, fileName: string, expectedRevision: string | null) => Promise<{ agentId: string; fileName: string; revision: string | null }>
  onRequestProjectAgentRecommendations?: (agentId: string) => Promise<{ whenToUse: string; systemPrompt: string }>
  onCreateAgentCreator?: (profileId: string) => void
  /** Present only when the environment runtime is mounted; adds other environments' projects and sessions. */
  environmentNavigation?: EnvironmentSessionNavigation
}

export interface WorkerRowProps {
  agent: AgentDescriptor
  liveStatus: AgentLiveStatus
  /** Rooms rollout styling only; classic preserves the existing row treatment. */
  roomsV2?: boolean
  isSelected: boolean
  onSelect: () => void
  onDelete?: () => void
  onStop?: () => void
  onResume?: () => void
  /** Continue a finished worker as a normal conversation. */
  onContinue?: () => void
  /** Why continuing is refused; the action stays visible, disabled, with this text. */
  continueDisabledReason?: string
  highlightQuery?: string
}

/** Continuing a finished worker as a normal conversation, or the reason it is refused. */
export interface WorkerContinuation {
  onContinue: (workerId: string) => void
  disabledReason?: string
}

export interface SessionContextMenuActionSource {
  /** Why a session cannot be forked, from what its provider declares. */
  forkDisabledReasonFor?: (agentId: string) => string | undefined
  workerContinuation?: WorkerContinuation
  onStopSession?: (agentId: string) => void
  onResumeSession?: (agentId: string) => void
  onDeleteSession?: (agentId: string) => void
  onArchiveSession?: (agentId: string) => void
  onRequestRenameSession?: (agentId: string) => void
  onRegenerateSessionTitle?: (agentId: string) => Promise<void>
  onForkSession?: (sourceAgentId: string) => void
  onMarkUnread?: (agentId: string) => void
  onPinSession?: (agentId: string, pinned: boolean) => void
  onPromoteToProjectAgent?: (agentId: string) => void
  onOpenProjectAgentSharing?: (agentId: string) => void
  onOpenProjectAgentSettings?: (agentId: string) => void
  onDemoteProjectAgent?: (agentId: string) => void | Promise<void>
  onChangeSessionModel?: (sessionAgentId: string) => void
  onUseProjectDefault?: (sessionAgentId: string) => void
  mutedAgents?: Set<string> | ReadonlySet<string>
  onToggleMute?: (agentId: string) => void
  hideCliSessions?: boolean
  onToggleHideCliSessions?: () => void
}

export interface SessionRowItemProps {
  session: SessionRow
  statuses: StatusMap
  /** Rooms rollout styling only; classic preserves the existing row treatment. */
  roomsV2?: boolean
  unreadCount: number
  selectedAgentId: string | null
  isSettingsActive: boolean
  isCollapsed: boolean
  isWorkerListExpanded: boolean
  onToggleCollapse: () => void
  onToggleWorkerListExpanded: () => void
  onSelect: (agentId: string) => void
  onDeleteAgent: (agentId: string, ownerSessionId?: string) => void
  onStop?: () => void
  onResume?: () => void
  onDelete?: () => void
  onArchive?: () => void
  archiveDisabledReason?: string
  onRename?: () => void
  onRegenerateTitle?: () => Promise<void>
  onFork?: () => void
  getForkDisabledReason?: () => string | undefined
  onMarkUnread?: () => void
  onStopWorker?: (agentId: string) => void
  onResumeWorker?: (agentId: string) => void
  workerContinuation?: WorkerContinuation
  highlightQuery?: string
  onPinSession?: (agentId: string, pinned: boolean) => void
  onPromoteToProjectAgent?: () => void
  onOpenProjectAgentSharing?: () => void
  onOpenProjectAgentSettings?: () => void
  onDemoteProjectAgent?: () => void
  onViewCreationHistory?: () => void
  onChangeSessionModel?: () => void
  onUseProjectDefault?: () => void
  isMutedSession?: boolean
  onToggleMute?: () => void
  getCreatorAttribution?: (creatorAgentId: string) => string | null
  hideCliSessions?: boolean
  onToggleHideCliSessions?: () => void
}

export interface ProfileGroupProps {
  treeRow: ProfileTreeRow
  statuses: StatusMap
  /** Rooms rollout styling only; classic preserves the existing row treatment. */
  roomsV2?: boolean
  unreadCounts: Record<string, number>
  selectedAgentId: string | null
  isSettingsActive: boolean
  isCollapsed: boolean
  collapsedSessionIds: Set<string>
  visibleSessionLimit: number
  expandedWorkerListSessionIds: Set<string>
  onToggleProfileCollapsed: (profileId: string) => void
  onToggleSessionCollapsed: (sessionId: string) => void
  onShowMoreSessions: (profileId: string) => void
  onShowLessSessions: (profileId: string) => void
  onToggleWorkerListExpanded: (sessionId: string) => void
  onSelect: (agentId: string) => void
  onDeleteAgent: (agentId: string, ownerSessionId?: string) => void
  onDeleteManager: (managerId: string) => void
  onOpenSettings: () => void
  onOpenProjectSettings?: (profileId: string) => void
  onOpenProjectSecrets?: (profileId: string) => void
  onCreateSession?: (profileId: string, name?: string) => void
  onStopSession?: (agentId: string) => void
  onResumeSession?: (agentId: string) => void
  onDeleteSession?: (agentId: string) => void
  onArchiveSession?: (agentId: string) => void
  onArchiveProfile?: (profileId: string) => void
  onRequestRenameSession?: (agentId: string) => void
  onRegenerateSessionTitle?: (agentId: string) => Promise<void>
  onRequestRenameProfile?: (profileId: string) => void
  onForkSession?: (sourceAgentId: string) => void
  forkDisabledReasonFor?: (agentId: string) => string | undefined
  workerContinuation?: WorkerContinuation
  onMarkUnread?: (agentId: string) => void
  onMarkAllRead?: (profileId: string) => void
  onChangeModel?: (profileId: string) => void
  onChangeSessionModel?: (sessionAgentId: string) => void
  onUseProjectDefault?: (sessionAgentId: string) => void
  onChangeCwd?: (profileId: string) => void
  showModelIcons?: boolean
  highlightQuery?: string
  dragHandleRef?: (element: HTMLElement | null) => void
  dragHandleListeners?: DraggableSyntheticListeners
  dragHandleAttributes?: DraggableAttributes
  onPinSession?: (agentId: string, pinned: boolean) => void
  onPromoteToProjectAgent?: (agentId: string) => void
  onOpenProjectAgentSharing?: (agentId: string) => void
  onOpenProjectAgentSettings?: (agentId: string) => void
  onDemoteProjectAgent?: (agentId: string) => void | Promise<void>
  onCreateAgentCreator?: (profileId: string) => void
  mutedAgents?: Set<string>
  onToggleMute?: (agentId: string) => void
  onMuteAllSessions?: (sessionAgentIds: string[], mute: boolean) => void
  getCreatorAttribution?: (creatorAgentId: string) => string | null
  hideCliSessions?: boolean
  onToggleHideCliSessions?: () => void
  inactiveRepoProjectAgents?: import('@/hooks/use-inactive-repo-project-agents').RepoProjectAgentSidebarEntry[]
  selectedInactiveRepoEntryKey?: string | null
  onSelectInactiveRepoProjectAgent?: (entry: import('@/hooks/use-inactive-repo-project-agents').RepoProjectAgentSidebarEntry) => void
  environmentNavigation?: EnvironmentSessionNavigation
}

export interface ProjectAgentSettingsSheetProps {
  agentId: string
  sessionLabel: string
  currentProjectAgent: ProjectAgentInfo | null
  onSave: (agentId: string, projectAgent: SessionProjectAgentInput) => Promise<void>
  /** The owning environment's authenticated settings client; null while it is unregistered. */
  settingsClient?: SettingsApiClient | null
  profileId?: string
  onDemote: (agentId: string) => Promise<void>
  onClose: () => void
  onGetProjectAgentConfig?: (agentId: string) => Promise<{ agentId: string; config: PersistedProjectAgentConfig; systemPrompt: string | null; references: string[]; source?: ProjectAgentConfigSourceSnapshot }>
  onGetProjectAgentSharing?: (agentId: string) => Promise<{ agentId: string; grants: ProjectAgentShareGrantInfo[]; eligibleTargets: ProjectAgentShareEligibleTarget[] }>
  onSetProjectAgentSharing?: (agentId: string, targetProfileIds: string[]) => Promise<{ agentId: string; grants: ProjectAgentShareGrantInfo[]; eligibleTargets: ProjectAgentShareEligibleTarget[]; addedTargetProfileIds: string[]; removedTargetProfileIds: string[] }>
  onListReferences?: (agentId: string) => Promise<{ agentId: string; references: string[] }>
  onGetReference?: (agentId: string, fileName: string) => Promise<{ agentId: string; fileName: string; content: string; revision: string | null }>
  onSetReference?: (agentId: string, fileName: string, content: string, expectedRevision: string | null) => Promise<{ agentId: string; fileName: string; revision: string | null }>
  onDeleteReference?: (agentId: string, fileName: string, expectedRevision: string | null) => Promise<{ agentId: string; fileName: string; revision: string | null }>
  onRequestRecommendations?: (agentId: string) => Promise<{ whenToUse: string; systemPrompt: string }>
}
