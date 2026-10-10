import type { AgentStatus, SessionAttention, SessionAttentionReason } from '@forge/protocol'
import type { OriginId } from '@/lib/origin-store'
import { isSessionActivelyWorking } from './utils'
import type { StatusMap } from './types'

export type RoomsInboxReason =
  | SessionAttentionReason
  | 'compacting'
  | 'manager_working'
  | 'recently_updated'

export interface RoomsInboxIdentity {
  originId: OriginId
  profileId: string
  sessionAgentId: string
}

/** A deliberately compact, origin-scoped summary for Inbox classification. */
export interface RoomsInboxSessionInput {
  identity: RoomsInboxIdentity
  label: string
  profileName: string
  agentStatus: AgentStatus
  activeWorkerCount: number
  pendingChoiceCount: number
  unreadCount: number
  contextRecoveryInProgress: boolean
  streamingStartedAt?: number
  updatedAt?: string
  lastUserMessageAt?: string
  createdAt: string
  /** Presentation-only Inbox marker; it does not affect section membership. */
  pinnedAt?: string
  cli?: boolean
  archived?: boolean
  agentCreatorResult?: boolean
}

export interface RoomsInboxProjectInput {
  originId: OriginId
  profileId: string
  profileName: string
  updatedAt?: string
  createdAt: string
  archived?: boolean
}

export interface RoomsInboxOriginInput {
  originId: OriginId
  /** Offline environments stay visible with their cached rows. */
  connected: boolean
  /** False while this origin is still receiving its agent/profile bootstrap snapshots. */
  inventoryReady?: boolean
  /** Unsupported origins keep Active/Recent but never synthesize Needs You. */
  attentionAvailable?: boolean
  attentions?: readonly SessionAttention[]
  sessions: readonly RoomsInboxSessionInput[]
  projects: readonly RoomsInboxProjectInput[]
}

export interface RoomsInboxSessionViewModel extends RoomsInboxSessionInput {
  reason: RoomsInboxReason
  timestamp: string
  /** Exact server occurrence identifier, present only for Needs You rows. */
  attentionId?: string
  /** Present only for Needs You rows, which are ordered by this value. */
  raisedAt?: number
}

export interface RoomsInboxProjectViewModel extends RoomsInboxProjectInput {
  timestamp: string
}

export interface RoomsInboxSections {
  needsYou: RoomsInboxSessionViewModel[]
  active: RoomsInboxSessionViewModel[]
  activeOverflowCount: number
  activeWorkerCount: number
  recent: RoomsInboxSessionViewModel[]
  recentOverflowCount: number
  projects: RoomsInboxProjectViewModel[]
  projectCount: number
}

export interface SelectRoomsInboxOptions {
  selected?: Pick<RoomsInboxIdentity, 'originId' | 'sessionAgentId'> | null
  now?: Date | number
  searchQuery?: string
  hideCliSessions?: boolean
  /** Local mute preference: hides Needs You only; Active/Recent still list the room. */
  mutedSessionIds?: ReadonlySet<string>
  /** Mute preferences are stored per primary-environment session ID. */
  primaryOriginId?: string
}

export const MAX_SECTION_ITEMS = 5
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// Sorting thousands of sessions re-reads the same ISO strings many times; parse each once.
const parsedTimestamps = new Map<string, number>()
function timestampMs(value: string | undefined): number {
  if (!value) return 0
  let parsed = parsedTimestamps.get(value)
  if (parsed === undefined) {
    parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) parsed = 0
    if (parsedTimestamps.size >= 50_000) parsedTimestamps.clear()
    parsedTimestamps.set(value, parsed)
  }
  return parsed
}

function sessionTimestamp(session: RoomsInboxSessionInput): string {
  return session.updatedAt || session.createdAt
}

function isSelected(
  session: RoomsInboxSessionInput,
  selected: SelectRoomsInboxOptions['selected'],
): boolean {
  return selected?.originId === session.identity.originId
    && selected.sessionAgentId === session.identity.sessionAgentId
}

function compareIdentity(left: RoomsInboxSessionInput, right: RoomsInboxSessionInput): number {
  return left.identity.sessionAgentId.localeCompare(right.identity.sessionAgentId)
    || left.identity.originId.localeCompare(right.identity.originId)
    || left.identity.profileId.localeCompare(right.identity.profileId)
}

function compareNeedsYou(
  left: { session: RoomsInboxSessionInput; attention: SessionAttention; raisedAt: number },
  right: { session: RoomsInboxSessionInput; attention: SessionAttention; raisedAt: number },
): number {
  const raisedOrder = right.raisedAt - left.raisedAt
  return raisedOrder || compareIdentity(left.session, right.session)
}

function compareActive(
  selected: SelectRoomsInboxOptions['selected'],
): (left: RoomsInboxSessionInput, right: RoomsInboxSessionInput) => number {
  return (left, right) => {
    const selectedOrder = Number(isSelected(right, selected)) - Number(isSelected(left, selected))
    if (selectedOrder !== 0) return selectedOrder
    const compactionOrder = Number(right.contextRecoveryInProgress) - Number(left.contextRecoveryInProgress)
    if (compactionOrder !== 0) return compactionOrder
    const workersOrder = right.activeWorkerCount - left.activeWorkerCount
    if (workersOrder !== 0) return workersOrder
    const activityOrder = (right.streamingStartedAt ?? timestampMs(sessionTimestamp(right)))
      - (left.streamingStartedAt ?? timestampMs(sessionTimestamp(left)))
    if (activityOrder !== 0) return activityOrder
    return compareIdentity(left, right)
  }
}

function matchesSearch(
  value: Pick<RoomsInboxSessionInput, 'identity' | 'label' | 'profileName'>,
  searchQuery: string,
): boolean {
  const term = searchQuery.trim().toLocaleLowerCase()
  if (!term) return true
  return value.label.toLocaleLowerCase().includes(term)
    || value.profileName.toLocaleLowerCase().includes(term)
    || value.identity.sessionAgentId.toLocaleLowerCase().includes(term)
}

function activeStatusMap(session: RoomsInboxSessionInput): StatusMap {
  return {
    [session.identity.sessionAgentId]: {
      status: session.agentStatus,
      pendingCount: 0,
      contextRecoveryInProgress: session.contextRecoveryInProgress,
    },
  }
}

export function isRoomsInboxSessionActive(session: RoomsInboxSessionInput): boolean {
  return isSessionActivelyWorking({
    sessionAgent: {
      agentId: session.identity.sessionAgentId,
      status: session.agentStatus,
      activeWorkerCount: session.activeWorkerCount,
    },
  }, activeStatusMap(session))
}

function reasonForActive(session: RoomsInboxSessionInput): RoomsInboxReason {
  return session.contextRecoveryInProgress ? 'compacting' : 'manager_working'
}

interface NeedsYouCandidate {
  session: RoomsInboxSessionInput
  attention: SessionAttention
  raisedAt: number
}

/** One origin's sessions classified once; search, the Recent window, and section limits apply when origins are combined. */
interface OriginSelection {
  hideCliSessions: boolean
  selectedSessionId: string | undefined
  mutedSessionIds: ReadonlySet<string> | undefined
  needsYou: NeedsYouCandidate[]
  active: RoomsInboxSessionViewModel[]
  /** Sessions neither needing the user nor working, newest first. */
  idle: Array<{ session: RoomsInboxSessionViewModel; at: number }>
  projects: RoomsInboxProjectViewModel[]
}

// A streamed update replaces one origin's input. Keeping each origin's classification means the
// other origins' sessions are not classified again for it.
const selectionByOrigin = new WeakMap<RoomsInboxOriginInput, OriginSelection>()

function selectOrigin(origin: RoomsInboxOriginInput, options: SelectRoomsInboxOptions): OriginSelection {
  const hideCliSessions = options.hideCliSessions === true
  // A hidden CLI session stays listed while it is the selected one.
  const selectedSessionId = hideCliSessions && options.selected?.originId === origin.originId
    ? options.selected.sessionAgentId
    : undefined
  // Mute is a local display preference. It must not dismiss server attention,
  // but it also must not claim the user's attention.
  const mutedSessionIds = origin.originId === options.primaryOriginId ? options.mutedSessionIds : undefined
  const cached = selectionByOrigin.get(origin)
  if (
    cached
    && cached.hideCliSessions === hideCliSessions
    && cached.selectedSessionId === selectedSessionId
    && cached.mutedSessionIds === mutedSessionIds
  ) return cached

  const attentionBySession = new Map<string, SessionAttention>()
  if (origin.attentionAvailable) {
    for (const attention of origin.attentions ?? []) {
      if (!attentionBySession.has(attention.sessionAgentId)) attentionBySession.set(attention.sessionAgentId, attention)
    }
  }
  const needsYou: NeedsYouCandidate[] = []
  const active: RoomsInboxSessionViewModel[] = []
  const idle: OriginSelection['idle'] = []
  const latestByProject = new Map<string, string>()
  for (const session of origin.sessions) {
    if (session.archived || session.agentCreatorResult) continue
    const sessionId = session.identity.sessionAgentId
    if (hideCliSessions && session.cli && sessionId !== selectedSessionId) continue
    const latest = session.updatedAt || session.lastUserMessageAt || session.createdAt
    if (timestampMs(latest) > timestampMs(latestByProject.get(session.identity.profileId))) {
      latestByProject.set(session.identity.profileId, latest)
    }
    const attention = attentionBySession.get(sessionId)
    const timestamp = sessionTimestamp(session)
    if (attention && !mutedSessionIds?.has(sessionId)) {
      needsYou.push({ session, attention, raisedAt: timestampMs(attention.raisedAt) })
    } else if (isRoomsInboxSessionActive(session)) {
      // Active sessions never also appear as recent.
      active.push({ ...session, reason: reasonForActive(session), timestamp })
    } else {
      idle.push({ session: { ...session, reason: 'recently_updated', timestamp }, at: timestampMs(timestamp) })
    }
  }
  idle.sort(compareRecent)

  const selection: OriginSelection = {
    hideCliSessions,
    selectedSessionId,
    mutedSessionIds,
    needsYou,
    active,
    idle,
    projects: origin.projects
      .filter((project) => !project.archived)
      .map((project) => ({
        ...project,
        timestamp: latestByProject.get(project.profileId) || project.updatedAt || project.createdAt,
      })),
  }
  selectionByOrigin.set(origin, selection)
  return selection
}

function compareRecent(
  left: OriginSelection['idle'][number],
  right: OriginSelection['idle'][number],
): number {
  return right.at - left.at || compareIdentity(left.session, right.session)
}

/**
 * Derive Needs You only from server attention. Active/Recent remain descriptor-derived
 * and unread/choice/status fields never manufacture or clear an attention occurrence.
 */
export function selectRoomsInboxSections(
  origins: readonly RoomsInboxOriginInput[],
  options: SelectRoomsInboxOptions = {},
): RoomsInboxSections {
  const nowMs = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now()
  const searchQuery = options.searchQuery ?? ''
  const recentSince = nowMs - RECENT_WINDOW_MS
  const needsYouCandidates: NeedsYouCandidate[] = []
  const activeCandidates: RoomsInboxSessionViewModel[] = []
  const recentCandidates: OriginSelection['idle'] = []
  const projectCandidates: RoomsInboxProjectViewModel[] = []
  const originIds = new Set<string>()

  for (const origin of origins) {
    // An origin listed twice contributes its first entry only.
    if (originIds.has(origin.originId)) continue
    originIds.add(origin.originId)
    const selection = selectOrigin(origin, options)
    for (const candidate of selection.needsYou) {
      if (matchesSearch(candidate.session, searchQuery)) needsYouCandidates.push(candidate)
    }
    for (const session of selection.active) {
      if (matchesSearch(session, searchQuery)) activeCandidates.push(session)
    }
    for (const entry of selection.idle) {
      if (entry.at < recentSince) break
      if (matchesSearch(entry.session, searchQuery)) recentCandidates.push(entry)
    }
    for (const project of selection.projects) projectCandidates.push(project)
  }

  const needsYou = needsYouCandidates
    .sort(compareNeedsYou)
    .map(({ session, attention, raisedAt }) => ({
      ...session,
      reason: attention.reason,
      timestamp: attention.raisedAt,
      attentionId: attention.attentionId,
      raisedAt,
    }))

  activeCandidates.sort(compareActive(options.selected))
  const activeWorkerCount = activeCandidates.reduce((total, session) => total + session.activeWorkerCount, 0)
  const active = activeCandidates.slice(0, MAX_SECTION_ITEMS)
  const recent = recentCandidates.sort(compareRecent).map(({ session }) => session)

  const projects = projectCandidates
    .filter((project) => matchesSearch({
      identity: { originId: project.originId, profileId: project.profileId, sessionAgentId: project.profileId },
      label: project.profileName,
      profileName: project.profileName,
    }, searchQuery))
    .sort((left, right) => timestampMs(right.timestamp) - timestampMs(left.timestamp)
      || left.profileName.localeCompare(right.profileName)
      || left.originId.localeCompare(right.originId)
      || left.profileId.localeCompare(right.profileId))

  return {
    needsYou,
    active,
    activeOverflowCount: Math.max(0, activeCandidates.length - active.length),
    activeWorkerCount,
    recent,
    recentOverflowCount: Math.max(0, recent.length - MAX_SECTION_ITEMS),
    projects: projects.slice(0, MAX_SECTION_ITEMS),
    projectCount: projects.length,
  }
}
