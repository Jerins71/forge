import type {
  ProjectAgentInfo,
  ProjectAgentSourceProblem,
  ProjectAgentSourceStatus,
} from './shared-types.js'

export type {
  ProjectAgentExternalDirectoryEntry,
  ProjectAgentShareEligibleTarget,
  ProjectAgentShareGrantInfo,
  ProjectAgentSharingSnapshot,
} from './project-agent-sharing.js'

export interface SessionProjectAgentUpdatedEvent {
  type: 'session_project_agent_updated'
  agentId: string
  profileId: string
  projectAgent: ProjectAgentInfo | null
  requestId?: string
}

export interface ProjectAgentConfigSourceSnapshot {
  type: 'repo'
  status: ProjectAgentSourceStatus
  problems: ProjectAgentSourceProblem[]
  workspaceKey: string
  forgeDirRealpath: string
  definitionId: string
  activatedAt: string
  signature?: string
}
