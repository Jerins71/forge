import { describe, expect, it } from 'vitest'
import { createInitialManagerWsState } from '@/lib/ws-state'
import type {
  ActivitySummaryEvent,
  ConversationMessageEvent,
} from '@forge/protocol'
import { handleConversationEvent } from './conversation-event-handlers'
import type { ManagerWsState } from '@/lib/ws-state'

function makeMessage(id: string, text: string): ConversationMessageEvent {
  return {
    type: 'conversation_message',
    agentId: 'manager',
    id,
    role: 'assistant',
    text,
    timestamp: '2026-06-02T12:00:00.000Z',
    source: 'assistant_output',
  }
}

function makeActivitySummary(overrides: Partial<ActivitySummaryEvent> = {}): ActivitySummaryEvent {
  return {
    type: 'activity_summary',
    schemaVersion: 1,
    itemId: 'tool:manager:tool-1',
    agentId: 'manager',
    actorAgentId: 'manager',
    timestamp: '2026-07-13T01:00:00.000Z',
    kind: 'tool_activity',
    status: 'completed',
    toolName: 'bash',
    correlationId: 'tool-1',
    displaySummary: 'Ran command',
    ...overrides,
  }
}

function runHandler(
  state: ManagerWsState,
  event: Parameters<typeof handleConversationEvent>[0],
): ManagerWsState {
  let next = state
  handleConversationEvent(event, {
    state,
    updateState: (patch) => {
      next = { ...next, ...patch }
    },
  })
  return next
}

describe('handleConversationEvent conversation history merge', () => {
  it('merges bootstrap history by id without overwriting live entries', () => {
    const liveMessage = makeMessage('msg-1', 'live text')
    const state = {
      ...createInitialManagerWsState('manager'),
      messages: [liveMessage, makeMessage('msg-live-only', 'arrived during bootstrap')],
    }

    const next = runHandler(state, {
      type: 'conversation_history',
      agentId: 'manager',
      messages: [
        makeMessage('msg-1', 'stale bootstrap text'),
        makeMessage('msg-bootstrap-only', 'from bootstrap'),
      ],
    })

    expect(next.messages.map((entry) => entry.type === 'conversation_message' ? [entry.id, entry.text] : null)).toEqual([
      ['msg-1', 'live text'],
      ['msg-bootstrap-only', 'from bootstrap'],
      ['msg-live-only', 'arrived during bootstrap'],
    ])
  })

  it('converges live and replayed activity by stable item id', () => {
    const liveSummary = makeActivitySummary({ status: 'failed', isError: true })
    const liveState = runHandler(createInitialManagerWsState('manager'), liveSummary)

    const next = runHandler(liveState, {
      type: 'conversation_history',
      agentId: 'manager',
      mode: 'replace',
      messages: [makeActivitySummary()],
      page: {
        hasOlder: false,
        completeness: 'complete',
        source: 'canonical',
      },
    })

    expect(next.activityMessages).toEqual([liveSummary])
    expect(next.conversationPage?.hasOlder).toBe(false)
  })

})
