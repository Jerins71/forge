import type { SessionAttention } from '@forge/protocol'
import {
  ACTIVITY_SUMMARY_SCHEMA_VERSION,
  isUserStoppedWorkerResult,
  type AgentDescriptor,
  type ConversationAttachmentMetadata,
  type ConversationMessageEvent,
  type ManagerProfile,
} from '@forge/protocol'
import type { ChoiceRequestEvent } from '@forge/protocol'
import type { ArtifactRef } from '@forge/protocol/environment-v2'
import type { EnvironmentActivityEntry } from '../ws-state'
import type { SessionSummary } from '@forge/protocol/environment-v2'
import type { ShellState, DetailState } from '@forge/client-runtime'
const pendingModel = { provider: '', modelId: '', thinkingLevel: '' }
export function projectSession(
  session: SessionSummary,
  shell: ShellState,
  previous?: AgentDescriptor,
): AgentDescriptor {
  const next: AgentDescriptor = {
    ...previous,
    agentId: session.sessionId,
    managerId: session.sessionId,
    profileId: session.projectId,
    displayName: session.title,
    sessionLabel: session.title,
    role: 'manager',
    projectAgent: session.projectAgent === undefined ? previous?.projectAgent : session.projectAgent ?? undefined,
    status:
      session.status === 'running'
        ? 'streaming'
        : session.status === 'waiting'
          ? 'idle'
          : session.status === 'preparing' || session.status === 'stopping'
            ? 'idle'
            : session.status === 'interrupted'
              ? 'stopped'
              : session.status,
    createdAt: session.createdAt ?? previous?.createdAt ?? session.updatedAt,
    pinnedAt: session.pinnedAt ?? undefined,
    lastUserMessageAt: session.lastUsedAt ?? undefined,
    updatedAt: session.updatedAt,
    cwd:
      session.workspace.cwd ?? shell.projects.get(session.projectId)?.cwd ?? '',
    model: session.model
      ? (previous?.model.provider === session.model.provider && previous.model.modelId === session.model.modelId
          && previous.model.thinkingLevel === session.model.thinkingLevel
          ? previous.model
          : { provider: session.model.provider, modelId: session.model.modelId, thinkingLevel: session.model.thinkingLevel })
      : previous?.model ?? pendingModel,
    modelOrigin: session.model?.origin ?? previous?.modelOrigin,
    managerPosture: session.delegation?.managerPosture,
    managerPostureOrigin: session.delegation?.managerPostureOrigin,
    delegationRosterId: session.delegation?.rosterId,
    delegationRosterOrigin: session.delegation?.rosterOrigin,
    contextModeOverride: session.contextMode?.override,
    sessionFile: previous?.sessionFile ?? '',
    workerCount: session.workerCount,
    activeWorkerCount: session.activeWorkerCount ?? previous?.activeWorkerCount,
    ...(session.archived
      ? { archivedAt: session.updatedAt }
      : { archivedAt: undefined }),
  }
  return previous && Object.keys(next).every(key => next[key as keyof AgentDescriptor] === previous[key as keyof AgentDescriptor]) ? previous : next
}
export function projectShell(shell: ShellState, previous: AgentDescriptor[], previousProfiles: ManagerProfile[] = [], previousUnread: Record<string, number> = {}, previousAttentions: Record<string, SessionAttention> = {}) {
  const byId = new Map(previous.map((a) => [a.agentId, a]))
  // The shell lists sessions only; the mounted detail's workers are kept across shell updates.
  const agents = [
    ...[...shell.sessions.values()].map((s) => projectSession(s, shell, byId.get(s.sessionId))),
    ...previous.filter((a) => a.role === 'worker' && shell.sessions.has(a.managerId)),
  ]
  const profilesById = new Map(previousProfiles.map(profile => [profile.profileId, profile]))
  const profiles: ManagerProfile[] = [...shell.projects.values()].map((p) => {
    const next: ManagerProfile = {
    profileId: p.projectId,
    displayName: p.title,
    defaultSessionAgentId:
      p.defaultSessionId ?? shell.sessionIdsByProject.get(p.projectId)?.[0] ?? '',
    defaultModel: p.defaultModel ?? pendingModel,
    defaultManagerPosture: p.delegationDefaults?.managerPosture,
    defaultDelegationRosterId: p.delegationDefaults?.rosterId,
    defaultContextMode: p.contextMode,
    ...(Number.isFinite(Number(p.sortKey)) ? { sortOrder: Number(p.sortKey) } : {}),
    createdAt: p.updatedAt,
    updatedAt: p.updatedAt,
    ...(p.archived ? { archivedAt: p.updatedAt } : {}),
    }
    const previousProfile = profilesById.get(p.projectId)
    return previousProfile && Object.keys(next).every(key => next[key as keyof ManagerProfile] === previousProfile[key as keyof ManagerProfile]) ? previousProfile : next
  })
  const sessionCount = shell.sessions.size
  const unreadCounts: Record<string, number> = {}
  for (const s of shell.sessions.values()) unreadCounts[s.sessionId] = s.unread
  // Needs You lists server attention occurrences; the shell carries the current one per session.
  const sessionAttentions: Record<string, SessionAttention> = {}
  for (const s of shell.sessions.values()) {
    const occurrence = s.attentionOccurrence
    if (!occurrence || s.archived) continue
    const previousAttention = previousAttentions[s.sessionId]
    sessionAttentions[s.sessionId] = previousAttention?.attentionId === occurrence.attentionId && previousAttention.profileId === s.projectId
      ? previousAttention
      : { ...occurrence, sessionAgentId: s.sessionId, profileId: s.projectId }
  }
  const attentionKeys = Object.keys(sessionAttentions)
  return {
    agents: sameItems(agents, previous) ? previous : agents,
    profiles: sameItems(profiles, previousProfiles) ? previousProfiles : profiles,
    unreadCounts: Object.keys(previousUnread).length === sessionCount && Object.keys(unreadCounts).every(key => unreadCounts[key] === previousUnread[key]) ? previousUnread : unreadCounts,
    sessionAttentionAvailable: true,
    // A complete shell is the whole session and project inventory; no other event reports it here.
    hasReceivedAgentsSnapshot: shell.complete,
    hasReceivedProfilesSnapshot: shell.complete,
    sessionAttentions: attentionKeys.length === Object.keys(previousAttentions).length && attentionKeys.every(key => sessionAttentions[key] === previousAttentions[key]) ? previousAttentions : sessionAttentions,
  }
}
function sameItems<T>(next: readonly T[], previous: readonly T[]): boolean {
  return next.length === previous.length && next.every((item, index) => item === previous[index])
}
type DetailItem = NonNullable<DetailState['projection']>['items'][number]

/**
 * A result the environment delivered to the manager as input. The delivering command is what marks
 * it: earlier environments also sent each worker message and manager-to-worker assignment as
 * `worker_result`, and those carry none.
 */
function isDeliveredWorkerResult(item: DetailItem): boolean {
  return item.kind === 'worker_result' && item.source === 'worker_report' && item.commandId !== null
}

/** Item sources the environment uses for timeline markers, and the notice each one is. */
const MARKER_SOURCES = { 'system:model_change': 'model_change', 'system:worker_stopped': 'worker_stopped', 'system:turn_stopped': 'turn_stopped' } as const

/** What the core delivered to an agent as its turn input (a worker's assignment); not something the user typed. */
function isInternalInput(item: DetailItem): boolean {
  return item.kind === 'user' && item.source === 'system'
}

/**
 * The chat of one agent. A session's detail also carries its workers' own messages, under the worker
 * as actor, and a worker is read through its session's detail. So only `agentId`'s messages are
 * projected: the manager's chat adds the results delivered to it, a worker's chat is the worker alone.
 */
export function projectItems(
  items: NonNullable<DetailState['projection']>['items'],
  agentId: string,
  sessionId: string = agentId,
): ConversationMessageEvent[] {
  return items
    .filter((i) => i.kind === 'worker_result'
      ? agentId === sessionId && isDeliveredWorkerResult(i)
      : (i.kind === 'user' || i.kind === 'assistant') && i.actorId === agentId && !(isInternalInput(i) && agentId === sessionId))
    .map((i) => ({
      type: 'conversation_message',
      id: i.itemId,
      agentId,
      turnId: i.userTurnId,
      ...(i.kind === 'worker_result' && !isUserStoppedWorkerResult(i.text) ? { sourceWorkerId: i.actorId } : {}),
      // An internal input is never the user's bubble: in a worker's view it is the assignment card.
      // The result that told the manager its worker was stopped is the quiet marker, not a result card.
      ...(i.kind === 'worker_result' && isUserStoppedWorkerResult(i.text) ? { role: 'system', source: 'system', systemNoticeKind: 'worker_stopped' }
        : isInternalInput(i) ? { role: 'system', source: 'system', systemNoticeKind: 'assignment' }
        // A model switch, or a turn or worker the user stopped, is a marker in the timeline, not something the assistant said.
        : i.kind === 'assistant' && i.source && i.source in MARKER_SOURCES
          ? { role: 'system', source: 'system', systemNoticeKind: MARKER_SOURCES[i.source as keyof typeof MARKER_SOURCES] } : {
        role: i.kind === 'user' ? 'user' : i.kind === 'worker_result' ? 'system' : 'assistant',
        source: i.kind === 'user' ? 'user_input' : i.kind === 'worker_result' ? 'worker_report' : 'assistant',
      }),
      text: i.kind === 'worker_result' && isUserStoppedWorkerResult(i.text) ? `${i.actorId} · Stopped by you` : i.text,
      timestamp: i.timestamp,
      pinned: i.pinned ?? false,
      ...(i.commandId && !isInternalInput(i) ? { clientRequestId: i.commandId } : {}),
      ...(i.artifacts.length ? { attachments: i.artifacts.map(artifactAttachment) } : {}),
    })) as ConversationMessageEvent[]
}

/**
 * Choices sit where they were asked and keep that time, whatever happens to them later. One with no
 * recorded time (from an older environment) follows the messages, as it always did, and shows no time.
 */
export function withChoicesInTimelineOrder(
  messages: ConversationMessageEvent[],
  choices: NonNullable<DetailState['projection']>['choices'],
  hasOlder = false,
): Array<ConversationMessageEvent | ChoiceRequestEvent> {
  const rows: Array<ConversationMessageEvent | ChoiceRequestEvent> = [...messages]
  const untimed: ChoiceRequestEvent[] = []
  const timed = choices
    .filter((choice) => choice.requestedAt || choice.status !== 'answered')
    .map((choice): ChoiceRequestEvent => ({
      type: 'choice_request',
      agentId: choice.agentId,
      choiceId: choice.choiceId,
      status: choice.status === 'interrupted' ? 'expired' : choice.status,
      questions: choice.questions,
      ...(choice.answers ? { answers: choice.answers } : {}),
      timestamp: choice.requestedAt ?? '',
    }))
    .filter((row) => row.timestamp ? true : (untimed.push(row), false))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  for (const row of timed) {
    const asked = Date.parse(row.timestamp)
    let at = rows.length
    while (at > 0 && Date.parse(rows[at - 1]!.timestamp) > asked) at--
    // Asked before the loaded page begins: it belongs with the older history, not above this page.
    if (at === 0 && hasOlder && row.status !== 'pending') continue
    rows.splice(at, 0, row)
  }
  return [...rows, ...untimed]
}

/** Tool and activity items render collapsed; their full content is fetched by `contentRef` on expansion. */
export function projectActivityItems(
  items: NonNullable<DetailState['projection']>['items'],
  sessionId: string,
): EnvironmentActivityEntry[] {
  return items
    .filter((i) => i.kind === 'tool' || i.kind === 'activity')
    .map((i) => ({
      type: 'activity_summary',
      schemaVersion: ACTIVITY_SUMMARY_SCHEMA_VERSION,
      // The activity's stable ID matches its live row; the detail item ID orders and keys the durable row.
      itemId: i.activity?.itemId ?? i.itemId,
      timelineEntryId: i.itemId,
      agentId: sessionId,
      actorAgentId: i.actorId,
      turnId: i.userTurnId,
      timestamp: i.timestamp,
      kind: 'tool_activity',
      status: i.activity?.status === 'failed' ? 'failed' : 'completed',
      ...(i.activity?.toolName ? { toolName: i.activity.toolName } : {}),
      displaySummary: i.text,
      contentRef: i.contentRef,
      ...(i.activity ? { activity: {
        kind: i.activity.kind, startedAt: i.activity.startedAt,
        ...(i.activity.truncated ? { truncated: true } : {}), ...(i.activity.hidden ? { hidden: true } : {}),
        ...(i.activity.exitCode !== undefined ? { exitCode: i.activity.exitCode } : {}),
      } } : {}),
    }))
}

const ARTIFACT_FILE_REF_PREFIX = 'artifact:'

/** V2 artifacts travel as attachment metadata whose file reference names the environment artifact. */
function artifactAttachment(artifact: ArtifactRef): ConversationAttachmentMetadata {
  return {
    type: artifact.mimeType.startsWith('image/') ? 'image' : artifact.mimeType.startsWith('text/') ? 'text' : 'binary',
    mimeType: artifact.mimeType,
    fileName: artifact.fileName,
    fileRef: `${ARTIFACT_FILE_REF_PREFIX}${artifact.artifactId}`,
    sizeBytes: artifact.sizeBytes,
  }
}

/** The environment artifact ID behind an attachment file reference, or null for stored attachments. */
export function artifactIdFromFileRef(fileRef: string): string | null {
  return fileRef.startsWith(ARTIFACT_FILE_REF_PREFIX) ? fileRef.slice(ARTIFACT_FILE_REF_PREFIX.length) : null
}

/** Replaces one session's workers with its detail projection, reusing unchanged descriptors and the list itself. */
export function projectSessionWorkers(
  agents: AgentDescriptor[],
  workers: NonNullable<DetailState['projection']>['workers'],
  sessionId: string,
  shell: ShellState,
): AgentDescriptor[] {
  const byId = new Map(agents.map((agent) => [agent.agentId, agent]))
  const next = [
    ...agents.filter((agent) => agent.role !== 'worker' || agent.managerId !== sessionId),
    ...workers.map((worker) => {
      const projected = projectWorker(worker, sessionId, shell)
      const previous = byId.get(worker.agentId)
      return previous?.role === 'worker' && previous.managerId === sessionId
        && previous.status === projected.status && previous.displayName === projected.displayName
        ? previous
        : projected
    }),
  ]
  return sameItems(next, agents) ? agents : next
}
export function projectWorker(
  worker: NonNullable<DetailState['projection']>['workers'][number],
  sessionId: string,
  shell: ShellState,
): AgentDescriptor {
  const manager = shell.sessions.get(sessionId)
  return {
    agentId: worker.agentId,
    managerId: sessionId,
    profileId: manager?.projectId ?? '',
    displayName: worker.title,
    role: 'worker',
    status: worker.status,
    createdAt: manager?.updatedAt ?? '',
    updatedAt: manager?.updatedAt ?? '',
    cwd: manager?.workspace.cwd ?? '',
    model: pendingModel,
    sessionFile: '',
  }
}
