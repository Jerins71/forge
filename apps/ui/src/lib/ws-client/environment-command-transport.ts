import type { ClientCommand, ServerEvent } from '@forge/protocol'
import type { CommandReceipt } from '@forge/protocol/environment-v2'
import { isInterruptedReceipt, type EnvironmentClient } from '@forge/client-runtime'
import { projectSession, projectShell } from './environment-projection'

/**
 * The user intent a durable command carries. Repeating the same intent before the server returns a
 * receipt is a retry and reuses the command ID; null means the command is not receipt-backed.
 */
export function environmentCommandIntentKey(command: ClientCommand): string | null {
  if (command.type === 'create_session')
    return JSON.stringify(['session.launch', command.profileId, command.name ?? null, command.label ?? null])
  if (command.type === 'stop_session' || command.type === 'kill_agent')
    return JSON.stringify(['session.stop', command.agentId])
  if (command.type === 'choice_response')
    return JSON.stringify(['session.choose', command.agentId, command.choiceId, command.answers])
  return null
}

export async function sendEnvironmentCommand(
  client: EnvironmentClient,
  command: ClientCommand,
  commandId: string,
  defaultSessionId?: string,
): Promise<{ events: readonly unknown[]; receipt: CommandReceipt | null }> {
  if (command.type === 'create_session') {
    const receipt = await client.request('session.launch', {
      commandId,
      projectId: command.profileId,
      title: command.label ?? command.name ?? 'New session',
      workspaceStrategy: { kind: 'current_checkout' },
    })
    if (isInterruptedReceipt(receipt))
      throw new Error('Session launch was interrupted; delivery is unknown. Start it again to retry.')
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
    return { receipt, events: [
      {
        type: 'session_created',
        sessionAgent: projectSession(summary, client.shell.getSnapshot()),
        profile: projectShell(client.shell.getSnapshot(), []).profiles.find(
          (p) => p.profileId === command.profileId,
        ),
        requestId: command.requestId,
      },
    ] }
  }
  if (command.type === 'stop_session' || command.type === 'kill_agent') {
    const receipt = await client.request('session.stop', {
      commandId,
      sessionId: command.agentId,
    })
    return { receipt, events: [
      {
        type: 'session_stopped',
        agentId: command.agentId,
        ...('requestId' in command ? { requestId: command.requestId } : {}),
      },
    ] }
  }
  if (command.type === 'choice_response') {
    const receipt = await client.request('session.choose', {
      commandId,
      sessionId: command.agentId,
      choiceId: command.choiceId,
      answers: command.answers,
    })
    return { receipt, events: [] }
  }
  if (command.type === 'user_message') {
    if (!command.agentId) throw new Error('Session is required')
    if (command.attachments?.length)
      throw new Error(
        'Upload attachments on the target environment before sending',
      )
    const receipt = await client.request('session.send', {
      commandId,
      sessionId: command.agentId,
      message: { text: command.text, artifactIds: [] },
    })
    return { receipt, events: [] }
  }
  if (command.type === 'subscribe') return { receipt: null, events: [] } // V2 detail lease owns bootstrap
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
  return { receipt: null, events: events as unknown as ServerEvent[] }
}
