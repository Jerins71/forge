import { describe, expect, it, vi } from 'vitest'
import { handleConversationCommand } from '../ws/commands/conversation-command-handler.js'

const pendingChoice = {
  agentId: 'manager',
  sessionAgentId: 'manager',
  questions: [
    {
      id: 'q1',
      question: 'Pick one',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    },
  ],
}

describe('choice answer ingress validation', () => {
  it('accepts valid web choice responses with optional option notes', async () => {
    const send = vi.fn()
    const swarmManager = {
      getPendingChoice: vi.fn(() => pendingChoice),
      resolveChoiceRequest: vi.fn(),
      cancelChoiceRequest: vi.fn(),
    }
    const answers = [{ questionId: 'q1', selectedOptionIds: ['yes'], text: 'extra context' }]

    const handled = await handleConversationCommand({
      command: {
        type: 'choice_response',
        agentId: 'manager',
        choiceId: 'choice-1',
        answers,
      } as never,
      socket: {} as never,
      subscribedAgentId: 'manager',
      swarmManager: swarmManager as never,
      allowNonManagerSubscriptions: true,
      send,
      logDebug: vi.fn(),
      resolveConfiguredManagerId: vi.fn(() => 'manager'),
    })

    expect(handled).toBe(true)
    expect(swarmManager.resolveChoiceRequest).toHaveBeenCalledWith('choice-1', answers)
    expect(send).not.toHaveBeenCalled()
  })
})
