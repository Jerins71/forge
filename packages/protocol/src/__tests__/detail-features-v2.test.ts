import { describe, expect, it } from 'vitest'
import { Value } from '@sinclair/typebox/value'
import { decodeEnvironmentValue, RecoverySnapshotSchema, rpcRegistry, ShellStreamItemSchema, DetailStreamItemSchema } from '../environment-v2.js'

// Failure cases: fake selected-session authority, secret/body-bearing recovery
// records, unbounded inventories, and incompatible live/replay projections.
const recovery = {
  recoveryId: 'boot', bootId: 'boot', createdAt: '2026-10-09T00:00:00.000Z',
  interruptedManagers: ['manager'], interruptedWorkers: ['worker'],
  undeliveredReports: [{ deliveryId: 'report', fromAgentId: 'worker', toAgentId: 'manager' }],
}
describe('typed detail features', () => {
  it('decodes verbatim composed recovery IDs for long valid worker IDs', () => {
    const workerId = 'w'.repeat(120)
    const uuid = '00000000-0000-4000-8000-000000000001'
    const deliveryId = `worker-result:${workerId}:${uuid}:${uuid}`
    const assignmentId = `assignment:${workerId}:${uuid}`
    const snapshot = { ...recovery, interruptedWorkers: [workerId], undeliveredReports: [{ deliveryId, assignmentId, fromAgentId: workerId, toAgentId: 'manager' }] }
    expect(decodeEnvironmentValue(RecoverySnapshotSchema, snapshot)).toEqual(snapshot)
    expect(decodeEnvironmentValue(RecoverySnapshotSchema, { ...snapshot, undeliveredReports: [{ ...snapshot.undeliveredReports[0], deliveryId: 'x'.repeat(257) }] })).toBeUndefined()
  })
  it.each(['session.goal.control', 'session.compact', 'session.elicitation.respond', 'session.features.subscribe'])(
    'declares the migrated %s family', method => {
      expect(rpcRegistry[method as keyof typeof rpcRegistry]).toBeDefined()
    },
  )
  it.each(['plan.upsert', 'goal.upsert'])('admits typed persisted %s events', type => {
    const snapshot = type === 'plan.upsert'
      ? { revision: 1, updatedAt: null, plan: [] }
      : { revision: 1, measuredAt: '2026-10-09T00:00:00.000Z', goal: null }
    expect(Value.Check(DetailStreamItemSchema, { kind: 'event', streamEpoch: '00000000-0000-4000-8000-000000000001',
      sequence: 1, event: { type, snapshot } })).toBe(true)
  })
  it('rejects invalid goal budgets before admission', () => {
    const input = { commandId: '00000000-0000-4000-8000-000000000001', sessionId: 'session', action: 'edit', objective: 'Verify' }
    for (const tokenBudget of [0, -1, 1.5, 100000001]) expect(Value.Check(rpcRegistry['session.goal.control'].input, { ...input, tokenBudget })).toBe(false)
  })
  it('addresses recovery without a selected session and declares durable decision receipts', () => {
    const get = rpcRegistry['recovery.get' as keyof typeof rpcRegistry]
    const decide = rpcRegistry['recovery.decide' as keyof typeof rpcRegistry]
    expect(get).toBeDefined()
    expect(decide).toBeDefined()
    expect(get.scope).toBe('session:read')
    expect(decide.scope).toBe('session:operate')
    expect(decide.receipt).toBe(true)
    expect(Value.Check(get.input, {})).toBe(true)
    expect(Value.Check(get.output, { recovery })).toBe(true)
    expect(Value.Check(get.output, { recovery: { ...recovery, secret: 'forbidden' } })).toBe(false)
    const input = { commandId: '00000000-0000-4000-8000-000000000001', recoveryId: 'boot', action: 'resume' }
    expect(Value.Check(decide.input, input)).toBe(true)
    expect(Value.Check(decide.input, { ...input, sessionId: 'manager' })).toBe(false)
    expect(Value.Check(decide.input, { ...input, action: 'replay' })).toBe(false)
  })
  it('uses the same bounded recovery event on shell and detail live/replay streams', () => {
    const item = { kind: 'event', streamEpoch: '00000000-0000-4000-8000-000000000001', sequence: 1,
      event: { type: 'recovery.upsert', recovery } }
    expect(Value.Check(ShellStreamItemSchema, item)).toBe(true)
    expect(Value.Check(DetailStreamItemSchema, item)).toBe(true)
    expect(Value.Check(ShellStreamItemSchema, { ...item, event: { ...item.event,
      recovery: { ...recovery, interruptedManagers: Array(1001).fill('manager') } } })).toBe(false)
  })
})
