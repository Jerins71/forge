// Failure cases: a worker whose provider failed without leaving a reply is reported to its manager as
// "settled without returning a final result", hiding the real error; a generic error message is preferred
// over the row that names the provider and model; another run's failure is used; a worker that did reply
// has its reply replaced by an earlier failure.
import { describe, expect, it } from 'vitest'
import { buildWorkerFailureResult, buildWorkerResult, selectWorkerRunFailure, selectWorkerRunFinal } from '../swarm/worker-result-extraction.js'
import type { ConversationEntryEvent } from '../swarm/types.js'

const at = '2026-01-01T00:00:00.000Z'
const input = (id: string, runId: string): ConversationEntryEvent => ({ type: 'conversation_message', id, agentId: 'worker', role: 'user', source: 'system', text: 'assignment', turnId: runId, timestamp: at })
const message = (id: string, runId: string, role: 'assistant' | 'system', text: string): ConversationEntryEvent => ({ type: 'conversation_message', id, agentId: 'worker', role, source: role === 'system' ? 'system' : 'speak_to_user', text, turnId: runId, timestamp: at } as ConversationEntryEvent)
const failedRow = (entryId: string, runId: string, summary: string): ConversationEntryEvent => ({ type: 'activity_summary', schemaVersion: 1, itemId: `status:worker:${runId}`, timelineEntryId: entryId, agentId: 'worker', actorAgentId: 'worker', turnId: runId, timestamp: at,
  kind: 'tool_activity', status: 'failed', isError: true, displaySummary: summary, activity: { kind: 'status', startedAt: at } } as ConversationEntryEvent)

describe('worker run failure as its result', () => {
  it('uses the failed status row of the run when the provider left no reply', () => {
    const history = [input('in-1', 'run-1'), failedRow('row-1', 'run-1', 'Failed: codex-native/gpt-6-sol: upstream closed the stream.')]
    expect(selectWorkerRunFinal(history, 'run-1', 'in-1')).toBeUndefined()
    const failure = selectWorkerRunFailure(history, 'run-1', 'in-1')
    expect(failure?.timelineEntryId).toBe('row-1')
    expect(buildWorkerFailureResult('sleeper', failure!)).toBe('status: blocked\nsummary: Worker sleeper failed: codex-native/gpt-6-sol: upstream closed the stream.\nfollow-up: Check the worker or retry the assignment.')
  })
  it('ignores a failure that belongs to another run', () => {
    const history = [input('in-0', 'run-0'), failedRow('row-0', 'run-0', 'Failed: earlier.'), input('in-1', 'run-1')]
    expect(selectWorkerRunFailure(history, 'run-1', 'in-1')).toBeUndefined()
    expect(buildWorkerResult('sleeper', undefined)).toContain('settled without returning a final result')
  })
  it('finds no failure for a run that only has ordinary activity', () => {
    const ok = { ...failedRow('row-1', 'run-1', 'Ran ls'), status: 'completed', isError: undefined } as ConversationEntryEvent
    expect(selectWorkerRunFailure([input('in-1', 'run-1'), ok, message('m-1', 'run-1', 'assistant', 'done')], 'run-1', 'in-1')).toBeUndefined()
  })
})
