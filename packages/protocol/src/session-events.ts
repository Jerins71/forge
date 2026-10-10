import type {
  AgentDescriptor,
  ManagerProfile,
} from './shared-types.js'

export interface SessionCreatedEvent {
  type: 'session_created'
  profile: ManagerProfile
  sessionAgent: AgentDescriptor
  requestId?: string
}

export interface SessionStoppedEvent {
  type: 'session_stopped'
  agentId: string
  profileId: string
  terminatedWorkerIds: string[]
  requestId?: string
}

export interface SessionResumedEvent {
  type: 'session_resumed'
  agentId: string
  profileId: string
  requestId?: string
}

export interface SessionArchivedEvent {
  type: 'session_archived'
  agentId: string
  profileId: string
  archivedAt: string
  requestId?: string
}

export interface SessionRestoredEvent {
  type: 'session_restored'
  agentId: string
  profileId: string
  requestId?: string
  openAgentId?: string
}

export interface SessionDeletedEvent {
  type: 'session_deleted'
  agentId: string
  profileId: string
  terminatedWorkerIds: string[]
  requestId?: string
}

export interface SessionClearedEvent {
  type: 'session_cleared'
  agentId: string
  requestId?: string
}

export interface SessionForkedEvent {
  type: 'session_forked'
  sourceAgentId: string
  newSessionAgent: AgentDescriptor
  profile: ManagerProfile
  fromMessageId?: string
  requestId?: string
}
