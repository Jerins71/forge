import type { ConversationEntry } from '@forge/protocol'
export function deriveMissingPendingChoiceIds(
  pendingChoiceIds: Set<string>,
  messages: ConversationEntry[],
  activeAgentId: string | null | undefined,
): string[] {
  if (!activeAgentId || pendingChoiceIds.size === 0) {
    return []
  }

  const renderablePendingChoiceIds = new Set<string>()
  for (const message of messages) {
    if (
      message.type === 'choice_request' &&
      message.status === 'pending' &&
      pendingChoiceIds.has(message.choiceId) &&
      (message.agentId === activeAgentId || message.sessionAgentId === activeAgentId)
    ) {
      renderablePendingChoiceIds.add(message.choiceId)
    }
  }

  return Array.from(pendingChoiceIds).filter(
    (choiceId) => !renderablePendingChoiceIds.has(choiceId),
  )
}

export function normalizeAgentId(agentId: string | null | undefined): string | null {
  const trimmed = agentId?.trim()
  return trimmed ? trimmed : null
}
