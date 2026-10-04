import type {
  AgentDescriptor,
  ConversationMessageEvent,
  ManagerProfile,
} from '@forge/protocol'
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
    })) as ConversationMessageEvent[]
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
