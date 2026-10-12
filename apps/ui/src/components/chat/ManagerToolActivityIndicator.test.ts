// Failure cases: the old "Using tools · N tools · name" bar is drawn under the activity timeline, which
// already lists each tool; removing it also drops what the timeline does not show (background commands,
// scheduled follow-ups, messages waiting for the agent).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ManagerToolActivityEvent } from '@forge/protocol'
import { ManagerToolActivityIndicator } from './ManagerToolActivityIndicator'

const activity = (overrides: Partial<ManagerToolActivityEvent>): ManagerToolActivityEvent => ({
  type: 'manager_tool_activity', sessionAgentId: 'session', revision: 1, toolCount: 0, ...overrides,
})
const render = (props: Parameters<typeof ManagerToolActivityIndicator>[0]) => renderToStaticMarkup(createElement(ManagerToolActivityIndicator, props))

describe('ManagerToolActivityIndicator', () => {
  it('draws nothing for tools in use: the timeline lists them', () => {
    expect(render({ activity: activity({ toolCount: 2, currentToolName: 'spawn_agent' }) })).toBe('')
  })
  it('still reports what the timeline does not show', () => {
    expect(render({ activity: activity({ toolCount: 2, backgroundCount: 1 }) })).toContain('1 command running in background')
    expect(render({ activity: activity({ scheduledWakeupCount: 1 }) })).toContain('Waiting for scheduled follow-up')
    expect(render({ activity: null, pendingCount: 2 })).toContain('2 messages waiting for agent')
  })
  it('counts down to the scheduled wake-up, and drops the time once it has fired', () => {
    const wakeAt = new Date(Date.now() + 12 * 60_000 - 1_000).toISOString()
    expect(render({ activity: activity({ scheduledWakeupCount: 1 }), wakeAt })).toMatch(/Waiting for scheduled follow-up · .+ \(in 12 min\)/)
    expect(render({ activity: activity({ scheduledWakeupCount: 0 }), wakeAt })).not.toContain('scheduled follow-up')
  })
})
