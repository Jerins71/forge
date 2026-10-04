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
  return {
    ...previous,
    agentId: session.sessionId,
    managerId: session.sessionId,
    profileId: session.projectId,
    displayName: session.title,
    sessionLabel: session.title,
    role: 'manager',
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
    createdAt: previous?.createdAt ?? session.updatedAt,
    updatedAt: session.updatedAt,
    cwd:
      session.workspace.cwd ?? shell.projects.get(session.projectId)?.cwd ?? '',
    model: previous?.model ?? pendingModel,
    sessionFile: previous?.sessionFile ?? '',
    workerCount: session.workerCount,
    ...(session.archived
      ? { archivedAt: session.updatedAt }
      : { archivedAt: undefined }),
  }
}
export function projectShell(shell: ShellState, previous: AgentDescriptor[]) {
  const byId = new Map(previous.map((a) => [a.agentId, a]))
  const agents = [...shell.sessions.values()].map((s) =>
    projectSession(s, shell, byId.get(s.sessionId)),
  )
  const profiles: ManagerProfile[] = [...shell.projects.values()].map((p) => ({
    profileId: p.projectId,
    displayName: p.title,
    defaultSessionAgentId:
      shell.sessionIdsByProject.get(p.projectId)?.[0] ?? '',
    defaultModel: pendingModel,
    createdAt: p.updatedAt,
    updatedAt: p.updatedAt,
    ...(p.archived ? { archivedAt: p.updatedAt } : {}),
  }))
  const unreadCounts: Record<string, number> = {}
  for (const s of shell.sessions.values()) unreadCounts[s.sessionId] = s.unread
  return { agents, profiles, unreadCounts }
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
      itemId: i.itemId,
      agentId: sessionId,
      actorAgentId: i.actorId,
      turnId: i.userTurnId,
      timestamp: i.timestamp,
      kind: 'tool_activity',
      status: 'completed',
      displaySummary: i.text,
      contentRef: i.contentRef,
    }))
}

export function projectDetailActivity(state: DetailState): EnvironmentActivityEntry[] {
  return projectActivityItems(
    state.projection?.items ?? [],
    state.projection?.session.sessionId ?? '',
  )
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

export function projectDetailMessages(
  state: DetailState,
): ConversationMessageEvent[] {
  return projectItems(
    state.projection?.items ?? [],
    state.projection?.session.sessionId ?? '',
  )
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
