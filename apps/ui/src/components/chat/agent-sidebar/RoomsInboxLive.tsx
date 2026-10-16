import type React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { SESSION_ATTENTION_MAX_DISMISS_IDS } from '@forge/protocol'
import { originRegistry, useAllOrigins } from '@/lib/origin-store'
import { useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'
import { isSideChatAgent, type ProfileTreeRow } from '@/lib/agent-hierarchy'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import type { ManagerWsState } from '@/lib/ws-state'
import { RoomsInbox } from './RoomsInbox'
import { buildSessionContextMenuActions } from './utils'
import type { SessionContextMenuActionSource } from './types'
import {
  selectRoomsInboxSections,
  type RoomsInboxIdentity,
  type RoomsInboxOriginInput,
  type RoomsInboxProjectInput,
  type RoomsInboxSessionInput,
  type RoomsInboxSessionViewModel,
} from './rooms-inbox-selectors'

interface InboxOriginSnapshot {
  connected: boolean
  /** Both inventories must be complete before a missing session can be GCed. */
  inventoryReady: boolean
  attentionAvailable: boolean
  attentions: RoomsInboxOriginInput['attentions']
  sessions: RoomsInboxSessionInput[]
  projects: RoomsInboxProjectInput[]
}

// Every origin runs this selector on each store read, so results are cached by state and per agent/profile;
// unchanged sessions keep their identity and equality is a cheap identity walk.
const snapshotByState = new WeakMap<ManagerWsState, InboxOriginSnapshot>()
const sessionByAgent = new WeakMap<AgentDescriptor, { live: unknown; unread: number; profile: ManagerProfile; value: RoomsInboxSessionInput }>()
const projectByProfile = new WeakMap<ManagerProfile, RoomsInboxProjectInput>()

function selectInboxOriginSnapshot(state: ManagerWsState): InboxOriginSnapshot {
  const cached = snapshotByState.get(state)
  if (cached) return cached
  const profiles = state.profiles.filter((profile) => !profile.archivedAt && profile.profileType !== 'system')
  const profilesById = new Map(profiles.map((profile) => [profile.profileId, profile]))
  const sessions = state.agents.flatMap((agent): RoomsInboxSessionInput[] => {
    const profileId = agent.profileId
    if (
      agent.role !== 'manager'
      || !profileId
      || agent.archivedAt
      || agent.agentCreatorResult
      || isSideChatAgent(agent)
    ) return []
    const profile = profilesById.get(profileId)
    if (!profile) return []
    const live = state.statuses[agent.agentId]
    const unread = state.unreadCounts[agent.agentId] ?? 0
    const previous = sessionByAgent.get(agent)
    if (previous && previous.live === live && previous.unread === unread && previous.profile === profile) return [previous.value]
    const value: RoomsInboxSessionInput = {
      // The owning environment ID is applied when origins are combined below.
      identity: { originId: '', profileId, sessionAgentId: agent.agentId },
      label: agent.sessionLabel || agent.displayName || agent.agentId,
      profileName: profile.displayName,
      agentStatus: live?.status ?? agent.status,
      activeWorkerCount: agent.activeWorkerCount ?? 0,
      pendingChoiceCount: agent.pendingChoiceCount ?? 0,
      unreadCount: unread,
      contextRecoveryInProgress: live?.contextRecoveryInProgress === true,
      streamingStartedAt: agent.streamingStartedAt,
      updatedAt: agent.updatedAt,
      lastUserMessageAt: agent.lastUserMessageAt,
      createdAt: agent.createdAt,
      pinnedAt: agent.pinnedAt,
      cli: Boolean(agent.cli),
    }
    sessionByAgent.set(agent, { live, unread, profile, value })
    return [value]
  })
  const projects = profiles.map((profile) => {
    let project = projectByProfile.get(profile)
    if (!project) {
      project = {
        originId: '',
        profileId: profile.profileId,
        profileName: profile.displayName,
        updatedAt: profile.updatedAt,
        createdAt: profile.createdAt,
      }
      projectByProfile.set(profile, project)
    }
    return project
  })
  // Worker-only status and unread updates do not change any session input, so neither the
  // project tree nor unrelated origin Inbox rows rerender for them.
  const inventoryReady = state.connected
    && state.hasReceivedAgentsSnapshot
    && state.hasReceivedProfilesSnapshot
  const snapshot = {
    connected: state.connected,
    inventoryReady,
    attentionAvailable: state.sessionAttentionAvailable,
    attentions: Object.values(state.sessionAttentions),
    sessions,
    projects,
  }
  snapshotByState.set(state, snapshot)
  return snapshot
}

const sameItems = <T,>(left: readonly T[], right: readonly T[]) =>
  left.length === right.length && left.every((item, index) => item === right[index])

function equalInboxOriginSnapshot(left: InboxOriginSnapshot, right: InboxOriginSnapshot): boolean {
  return left === right || (
    left.connected === right.connected
    && left.inventoryReady === right.inventoryReady
    && left.attentionAvailable === right.attentionAvailable
    && sameItems(left.attentions ?? [], right.attentions ?? [])
    && sameItems(left.sessions, right.sessions)
    && sameItems(left.projects, right.projects)
  )
}

const originInputBySnapshot = new WeakMap<InboxOriginSnapshot, RoomsInboxOriginInput>()

function originInput(originId: string, value: InboxOriginSnapshot): RoomsInboxOriginInput {
  const cached = originInputBySnapshot.get(value)
  if (cached?.originId === originId) return cached
  const input = {
    originId,
    connected: value.connected,
    inventoryReady: value.inventoryReady,
    attentionAvailable: value.attentionAvailable,
    attentions: value.attentions,
    sessions: value.sessions.map((session) => ({ ...session, identity: { ...session.identity, originId } })),
    projects: value.projects.map((project) => ({ ...project, originId })),
  }
  originInputBySnapshot.set(value, input)
  return input
}

export function RoomsInboxLive({
  showInbox,
  selected,
  searchQuery,
  hideCliSessions,
  onSelectLocal,
  onSelectRemote,
  onNewProject,
  commandRow,
  projectTree,
  projectsAction,
  hasInlineProjectContent = false,
  mutedSessionIds,
  fallbackOrigins = [],
  localTreeRows = [],
  sessionMenuActions,
}: {
  /** False inside a project view: only that view's projects are shown, below the command row. */
  showInbox: boolean
  selected?: Pick<RoomsInboxIdentity, 'originId' | 'sessionAgentId'> | null
  searchQuery: string
  hideCliSessions: boolean
  onSelectLocal: (agentId: string) => void
  onSelectRemote?: (originId: string, agentId: string) => void
  onNewProject: () => void
  /** Kept inside the live surface so the search input and Inbox body stay ordered. */
  commandRow?: React.ReactNode
  /** The full project tree, shown in the Inbox's collapsible Projects section. */
  projectTree?: React.ReactNode
  /** Controls in the Projects section header, such as its sort order. */
  projectsAction?: React.ReactNode
  /** Whether the shared tree currently renders rows or remote status content. */
  hasInlineProjectContent?: boolean
  /** Local mute preference: hides Needs You rows and the Inbox badge for those rooms. */
  mutedSessionIds?: ReadonlySet<string>
  /** Direct component consumers may not have an origin store yet (tests/bootstrap). */
  fallbackOrigins?: readonly RoomsInboxOriginInput[]
  /** Local project tree used to bind Inbox rows to the same session-menu actions as Projects. */
  localTreeRows?: readonly ProfileTreeRow[]
  sessionMenuActions?: SessionContextMenuActionSource
}) {
  const originSnapshots = useAllOrigins(selectInboxOriginSnapshot, {
    selectorKey: 'sidebar.rooms-inbox',
    equalityFn: equalInboxOriginSnapshot,
  })
  const dismissalAttemptRef = useRef(0)
  const [dismissError, setDismissError] = useState<string | null>(null)
  const origins = useMemo<RoomsInboxOriginInput[]>(() => {
    const liveOrigins = originSnapshots.map(({ originId, value }) => originInput(originId, value))
    const liveOriginIds = new Set(liveOrigins.map((origin) => origin.originId))
    return [...liveOrigins, ...fallbackOrigins.filter((origin) => !liveOriginIds.has(origin.originId))]
  }, [fallbackOrigins, originSnapshots])
  const primaryOriginId = useOptionalEnvironmentContext()?.primaryEnvironmentId
  const sections = useMemo(() => selectRoomsInboxSections(origins, {
    selected,
    searchQuery,
    hideCliSessions,
    mutedSessionIds,
    primaryOriginId,
  }), [hideCliSessions, mutedSessionIds, origins, primaryOriginId, searchQuery, selected])

  const handleSelectSession = (identity: RoomsInboxIdentity) => {
    if (identity.originId === primaryOriginId) {
      onSelectLocal(identity.sessionAgentId)
    } else {
      onSelectRemote?.(identity.originId, identity.sessionAgentId)
    }
  }

  const localSessionById = useMemo(() => {
    const sessions = new Map<string, { session: ProfileTreeRow['sessions'][number]; sessionAgentIds: Set<string> }>()
    for (const row of localTreeRows) {
      const sessionAgentIds = new Set(row.sessions.map((session) => session.sessionAgent.agentId))
      for (const session of row.sessions) {
        sessions.set(session.sessionAgent.agentId, { session, sessionAgentIds })
      }
    }
    return sessions
  }, [localTreeRows])

  const resolveSessionMenu = useCallback((view: RoomsInboxSessionViewModel) => {
    if (view.identity.originId !== primaryOriginId || !sessionMenuActions) return null
    const local = localSessionById.get(view.identity.sessionAgentId)
    if (!local) return null
    const creatorSessionId = local.session.sessionAgent.projectAgent?.creatorSessionId
    return {
      session: local.session,
      actions: buildSessionContextMenuActions(local.session, sessionMenuActions, {
        onViewCreationHistory: creatorSessionId && local.sessionAgentIds.has(creatorSessionId)
          ? () => onSelectLocal(creatorSessionId)
          : undefined,
      }),
    }
  }, [localSessionById, onSelectLocal, primaryOriginId, sessionMenuActions])

  const dismissNeedsYou = (sessions: readonly RoomsInboxSessionViewModel[]) => {
    const attempt = ++dismissalAttemptRef.current
    setDismissError(null)
    const attentionIdsByOrigin = new Map<string, string[]>()
    for (const session of sessions) {
      if (!session.attentionId) continue
      const attentionIds = attentionIdsByOrigin.get(session.identity.originId) ?? []
      attentionIds.push(session.attentionId)
      attentionIdsByOrigin.set(session.identity.originId, attentionIds)
    }
    const batches = [...attentionIdsByOrigin].flatMap(([originId, attentionIds]) => {
      const originBatches: Array<{ originId: string; attentionIds: string[] }> = []
      for (let index = 0; index < attentionIds.length; index += SESSION_ATTENTION_MAX_DISMISS_IDS) {
        originBatches.push({
          originId,
          attentionIds: attentionIds.slice(index, index + SESSION_ATTENTION_MAX_DISMISS_IDS),
        })
      }
      return originBatches
    })
    void Promise.allSettled(batches.map(async ({ originId, attentionIds }) => {
      const store = originRegistry.getOrigin(originId)
      if (!store) throw new Error(`Origin ${originId} is unavailable.`)
      return store.getClient().dismissSessionAttention(attentionIds)
    })).then((results) => {
      if (attempt !== dismissalAttemptRef.current) return
      if (results.some((result) => result.status === 'rejected')) {
        setDismissError('Some Needs You items could not be cleared. Try again.')
      }
    })
  }

  return (
    <>
      {commandRow}
      {showInbox ? (
        <RoomsInbox
          sections={sections}
          selected={selected}
          onSelectSession={handleSelectSession}
          onNewProject={onNewProject}
          onAcknowledgeNeedsYou={(session) => dismissNeedsYou([session])}
          onClearNeedsYou={dismissNeedsYou}
          dismissError={dismissError}
          projectTree={projectTree}
          projectsAction={projectsAction}
          hasInlineProjectContent={hasInlineProjectContent}
          mutedSessionIds={mutedSessionIds}
          searchQuery={searchQuery}
          resolveSessionMenu={resolveSessionMenu}
        />
      ) : null}
    </>
  )
}
