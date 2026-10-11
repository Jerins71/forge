import type { SessionAttention } from '@forge/protocol'
import {
  ACTIVITY_SUMMARY_SCHEMA_VERSION,
  type AgentDescriptor,
  type ConversationAttachmentMetadata,
  type ConversationMessageEvent,
  type ManagerProfile,
} from '@forge/protocol'
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
export function projectItems(
  items: NonNullable<DetailState['projection']>['items'],
  sessionId: string,
): ConversationMessageEvent[] {
  return items
    .filter(
      (i) =>
        i.kind === 'user' ||
        i.kind === 'assistant' ||
        i.kind === 'worker_result',
    )
    .map((i) => ({
      type: 'conversation_message',
      id: i.itemId,
      agentId: sessionId,
      turnId: i.userTurnId,
      ...(i.kind === 'worker_result' ? { sourceWorkerId: i.actorId } : {}),
      role: i.kind === 'user' ? 'user' : 'assistant',
      text: i.text,
      timestamp: i.timestamp,
      pinned: i.pinned ?? false,
      source: i.kind === 'user' ? 'user_input' : 'assistant',
      ...(i.commandId ? { clientRequestId: i.commandId } : {}),
      ...(i.artifacts.length ? { attachments: i.artifacts.map(artifactAttachment) } : {}),
    })) as ConversationMessageEvent[]
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
