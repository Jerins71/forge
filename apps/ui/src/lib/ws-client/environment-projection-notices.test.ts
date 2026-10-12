// Failure cases: Forge's own notices from a remote environment (a stalled turn, any other system text)
// arrive as `assistant` items and render as the model's reply under its name.
import { describe, expect, it } from 'vitest'
import { projectItems } from './environment-projection'

const item = (source: string, text: string) => ({
  itemId: `item-${source}`, userTurnId: 'turn', actorId: 'manager', kind: 'assistant', pinned: false,
  timestamp: '2026-10-12T10:00:00.000Z', source, text, contentRef: null, artifacts: [], commandId: null,
}) as unknown as Parameters<typeof projectItems>[0][number]

describe('Forge notices from an environment', () => {
  it('draws a stalled turn as Forge\'s notice', () => {
    expect(projectItems([item('system:manager_stalled', 'No activity from the agent for 5 minutes.')], 'manager')[0])
      .toMatchObject({ role: 'system', source: 'system', systemNoticeKind: 'manager_stalled' })
  })
  it('never draws system text as the assistant\'s reply, including stall text already in history', () => {
    expect(projectItems([item('system', 'The manager still has not produced a runtime update for this turn.')], 'manager')[0])
      .toMatchObject({ role: 'system', source: 'system' })
    expect(projectItems([item('assistant', 'Hello')], 'manager')[0]).toMatchObject({ role: 'assistant' })
  })
})
