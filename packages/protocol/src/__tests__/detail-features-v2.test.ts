import { describe, expect, it } from 'vitest'
import { Value } from '@sinclair/typebox/value'
import { rpcRegistry, ShellStreamItemSchema, DetailStreamItemSchema } from '../environment-v2.js'

// Failure cases: fake selected-session authority, secret/body-bearing recovery
// records, unbounded inventories, and incompatible live/replay projections.
const recovery = {
  recoveryId: 'boot', bootId: 'boot', createdAt: '2026-10-09T00:00:00.000Z',
  interruptedManagers: ['manager'], interruptedWorkers: ['worker'],
  undeliveredReports: [{ deliveryId: 'report', fromAgentId: 'worker', toAgentId: 'manager' }],
}
describe('typed detail features', () => {
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
