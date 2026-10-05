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

export function getRoomsInboxIdentityKey(originId: string, sessionAgentId: string): string {
  return `${originId}::${sessionAgentId}`
}

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

/** Latest session activity per project, indexed in one pass over the visible sessions. */
function latestSessionTimestampByProject(sessions: readonly RoomsInboxSessionInput[]): Map<string, string> {
  const latest = new Map<string, string>()
  for (const session of sessions) {
    const key = getRoomsInboxIdentityKey(session.identity.originId, session.identity.profileId)
    const candidate = session.updatedAt || session.lastUserMessageAt || session.createdAt
    if (timestampMs(candidate) > timestampMs(latest.get(key))) latest.set(key, candidate)
  }
  return latest
}

function projectTimestamp(project: RoomsInboxProjectInput, latestByProject: ReadonlyMap<string, string>): string {
  return latestByProject.get(getRoomsInboxIdentityKey(project.originId, project.profileId)) || project.updatedAt || project.createdAt
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

function compareRecent(left: RoomsInboxSessionInput, right: RoomsInboxSessionInput): number {
  const timestampOrder = timestampMs(sessionTimestamp(right)) - timestampMs(sessionTimestamp(left))
  return timestampOrder || compareIdentity(left, right)
}

function isLocallyMuted(
  session: RoomsInboxSessionInput,
  mutedSessionIds: ReadonlySet<string> | undefined,
  primaryOriginId: string | undefined,
): boolean {
  return session.identity.originId === primaryOriginId
    && mutedSessionIds?.has(session.identity.sessionAgentId) === true
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

/** Returns all sessions to which the origin-global Inbox rules can apply. */
export function getRoomsInboxVisibleSessions(
  origins: readonly RoomsInboxOriginInput[],
  options: Pick<SelectRoomsInboxOptions, 'selected' | 'hideCliSessions'> = {},
): RoomsInboxSessionInput[] {
  const sessionByIdentity = new Map<string, RoomsInboxSessionInput>()
  for (const session of origins.flatMap((origin) => origin.sessions)) {
    const key = getRoomsInboxIdentityKey(session.identity.originId, session.identity.sessionAgentId)
    if (!sessionByIdentity.has(key)) sessionByIdentity.set(key, session)
  }
  return [...sessionByIdentity.values()]
    .filter((session) => !session.archived && !session.agentCreatorResult)
    .filter((session) => !options.hideCliSessions || !session.cli || isSelected(session, options.selected))
}

function getVisibleAttentionBySession(origins: readonly RoomsInboxOriginInput[]): Map<string, SessionAttention> {
  const attentions = new Map<string, SessionAttention>()
  for (const origin of origins) {
    if (!origin.attentionAvailable) continue
    for (const attention of origin.attentions ?? []) {
      if (!attentions.has(getRoomsInboxIdentityKey(origin.originId, attention.sessionAgentId))) {
        attentions.set(getRoomsInboxIdentityKey(origin.originId, attention.sessionAgentId), attention)
      }
    }
  }
  return attentions
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
  const sessions = getRoomsInboxVisibleSessions(origins, options)
  const attentionBySession = getVisibleAttentionBySession(origins)
  const attentionSessions = new Set<RoomsInboxSessionInput>()
  const needsYouCandidates: Array<{
    session: RoomsInboxSessionInput
    attention: SessionAttention
    raisedAt: number
  }> = []

  for (const session of sessions) {
    const key = getRoomsInboxIdentityKey(session.identity.originId, session.identity.sessionAgentId)
    const attention = attentionBySession.get(key)
    if (!attention) continue
    // Mute is a local display preference. It must not dismiss server attention,
    // but it also must not claim the user's attention.
    if (isLocallyMuted(session, options.mutedSessionIds, options.primaryOriginId)) continue
    attentionSessions.add(session)
    needsYouCandidates.push({
      session,
      attention,
      raisedAt: timestampMs(attention.raisedAt),
    })
  }

  const needsYou = needsYouCandidates
    .filter(({ session }) => matchesSearch(session, searchQuery))
    .sort(compareNeedsYou)
    .map(({ session, attention, raisedAt }) => ({
      ...session,
      reason: attention.reason,
      timestamp: attention.raisedAt,
      attentionId: attention.attentionId,
      raisedAt,
    }))

  // One pass partitions the remaining sessions: active ones never also appear as recent.
  const activeCandidates: RoomsInboxSessionInput[] = []
  const recentCandidates: RoomsInboxSessionInput[] = []
  const recentSince = nowMs - RECENT_WINDOW_MS
  for (const session of sessions) {
    if (attentionSessions.has(session) || !matchesSearch(session, searchQuery)) continue
    if (isRoomsInboxSessionActive(session)) activeCandidates.push(session)
    else if (timestampMs(sessionTimestamp(session)) >= recentSince) recentCandidates.push(session)
  }
  activeCandidates.sort(compareActive(options.selected))
  const activeWorkerCount = activeCandidates.reduce((total, session) => total + session.activeWorkerCount, 0)
  const active = activeCandidates.slice(0, MAX_SECTION_ITEMS).map((session) => ({
    ...session,
    reason: reasonForActive(session),
    timestamp: sessionTimestamp(session),
  }))

  const recent = recentCandidates
    .sort(compareRecent)
    .map((session) => ({
      ...session,
      reason: 'recently_updated' as const,
      timestamp: sessionTimestamp(session),
    }))

  const latestByProject = latestSessionTimestampByProject(sessions)
  const projects = origins
    .flatMap((origin) => origin.projects)
    .filter((project) => !project.archived)
    .map((project) => ({
      ...project,
      timestamp: projectTimestamp(project, latestByProject),
    }))
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
