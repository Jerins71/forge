import type { ClientCommand, ServerEvent } from '@forge/protocol'
import type { EnvironmentClient } from '@forge/client-runtime'
import { projectSession, projectShell } from './environment-projection'
export async function sendEnvironmentCommand(
  client: EnvironmentClient,
  command: ClientCommand,
  defaultSessionId?: string,
): Promise<readonly unknown[]> {
  const commandId = crypto.randomUUID()
  if (command.type === 'create_session') {
    const receipt = await client.request('session.launch', {
      commandId,
      projectId: command.profileId,
      title: command.label ?? command.name ?? 'New session',
      workspaceStrategy: { kind: 'current_checkout' },
    })
    if (!receipt.sessionId)
      throw new Error(
        'Session preparation is pending; track its command receipt',
      )
    const existing = client.shell.getSnapshot().sessions.get(receipt.sessionId)
    const summary = existing ?? {
      sessionId: receipt.sessionId,
      projectId: command.profileId,
      title: command.label ?? command.name ?? 'New session',
      status: 'preparing' as const,
      attention: 'none' as const,
      unread: 0,
      workerCount: 0,
      updatedAt: receipt.updatedAt,
      sortKey: receipt.sessionId,
      archived: false,
      workspace: { kind: 'current_checkout' as const, cwd: null, branch: null },
    }
    return [
      {
        type: 'session_created',
        sessionAgent: projectSession(summary, client.shell.getSnapshot()),
        profile: projectShell(client.shell.getSnapshot(), []).profiles.find(
          (p) => p.profileId === command.profileId,
        ),
        requestId: command.requestId,
      },
    ]
  }
  if (command.type === 'stop_session' || command.type === 'kill_agent') {
    await client.request('session.stop', {
      commandId,
      sessionId: command.agentId,
    })
    return [
      {
        type: 'session_stopped',
        agentId: command.agentId,
        ...('requestId' in command ? { requestId: command.requestId } : {}),
      },
    ]
  }
  if (command.type === 'choice_response') {
    await client.request('session.choose', {
      commandId,
      sessionId: command.agentId,
      choiceId: command.choiceId,
      answers: command.answers,
    })
    return []
  }
  if (command.type === 'user_message') {
    if (!command.agentId) throw new Error('Session is required')
    if (command.attachments?.length)
      throw new Error(
        'Upload attachments on the target environment before sending',
      )
    await client.request('session.send', {
      commandId,
      sessionId: command.agentId,
      message: { text: command.text, artifactIds: [] },
    })
    return []
  }
  if (command.type === 'subscribe') return [] // V2 detail lease owns bootstrap
  const events = await client.features.legacy.request(
    command,
    'agentId' in command
      ? String(command.agentId)
      : 'sessionAgentId' in command
        ? String(command.sessionAgentId)
        : 'managerId' in command
          ? String(command.managerId)
          : defaultSessionId,
  )
  return events as unknown as ServerEvent[]
}
