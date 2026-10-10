import type { AgentDescriptor, ManagerExactModelSelection, ManagerReasoningLevel } from './shared-types.js'

export interface CreateRepositoryProjectCommandFields {
  name: string
  repositoryUrl: string
  repositoryBasePath: string
  repositoryFolder: string
  modelSelection: ManagerExactModelSelection
  reasoningLevel?: ManagerReasoningLevel
  secureSessionsEnabled?: boolean
  /** Required on the wire for create_repository_project. */
  requestId: string
}

export interface CancelRepositoryProjectCreationCommandFields {
  operationRequestId: string
  requestId?: string
}

export type RepositoryProjectCreationStage =
  | 'validating'
  | 'cloning'
  | 'publishing'
  | 'creating_manager'

export interface RepositoryProjectCreationProgressEvent {
  type: 'repository_project_creation_progress'
  requestId: string
  stage: RepositoryProjectCreationStage
  percent?: number
}

export interface RepositoryProjectCreatedEvent {
  type: 'repository_project_created'
  requestId: string
  manager: AgentDescriptor
  repositoryPath: string
}

export interface RepositoryProjectCreationCancelledEvent {
  type: 'repository_project_creation_cancelled'
  requestId: string
}

export interface RepositoryProjectCreationCancelResultEvent {
  type: 'repository_project_creation_cancel_result'
  requestId?: string
  operationRequestId: string
  accepted: boolean
  tooLate: boolean
}

export type RepositoryProjectCreationErrorCode =
  | 'invalid_repository_url'
  | 'invalid_repository_folder'
  | 'invalid_repository_base_path'
  | 'destination_exists'
  | 'git_unavailable'
  | 'repository_not_found'
  | 'repository_auth_failed'
  | 'repository_network_failed'
  | 'clone_timed_out'
  | 'clone_cancelled'
  | 'destination_permission_denied'
  | 'disk_full'
  | 'manager_creation_failed_after_clone'
  | 'clone_failed'
  | 'duplicate_operation'

/** POST /api/repository-checkouts: set up a repository on this environment (clone or adopt, then register a project). */
export interface RepositoryCheckoutRequest {
  repositoryUrl: string
  /** Folder name under this environment's repositories base path; defaults to the repository name. */
  folder?: string
  /** Project name; defaults to the repository name. */
  name?: string
  /** Project default model; must be create-selectable on that environment. Defaults to its create default. */
  model?: ManagerExactModelSelection & { reasoningLevel?: ManagerReasoningLevel }
}

export type RepositoryCheckoutPhase =
  | 'validating'
  | 'cloning'
  | 'publishing'
  | 'creating_project'
  | 'done'
  | 'error'
  | 'cancelled'

/** GET /api/repository-checkouts/:checkoutId. */
export interface RepositoryCheckoutStatus {
  checkoutId: string
  phase: RepositoryCheckoutPhase
  percent?: number
  projectId?: string
  sessionId?: string
  repositoryPath?: string
  /** True when an existing matching checkout or project was adopted instead of cloned. */
  adopted?: boolean
  message?: string
  code?: RepositoryProjectCreationErrorCode
}
