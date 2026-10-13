import { describe, expect, it } from 'vitest'
import type { ConfigSyncVersion } from '@forge/protocol'
import { planConfigSyncKey } from '../config-sync.js'
// Failure modes: timestamp precedence, absent versus tombstone, stale heads, and lost concurrent versions.
const head = (id: string, vector: Record<string, number>, hash: string | null, at: string): ConfigSyncVersion => ({ id, vector, hash, at, author: Object.keys(vector)[0]!, size: 0, mode: 0o644 })
describe('causal planner', () => {
  it('compares vectors regardless of timestamps and retains incomparable heads', () => {
    const old = head('old', { a: 1 }, 'old', '2099-01-01'), fresh = head('fresh', { a: 2 }, 'new', '1900-01-01'), concurrent = head('c', { a: 1, c: 1 }, 'c', '3000-01-01')
    expect(planConfigSyncKey([{ environmentId: 'a', heads: [fresh] }, { environmentId: 'b', heads: [old] }]).heads).toEqual([fresh])
    expect(planConfigSyncKey([{ environmentId: 'a', heads: [fresh] }, { environmentId: 'c', heads: [concurrent] }]).kind).toBe('conflict')
  })
  it('a tombstone is a version and uninitialized absence is not', () => {
    const deleted = head('delete', { a: 2 }, null, 't')
    expect(planConfigSyncKey([{ environmentId: 'a', heads: [deleted] }, { environmentId: 'b', heads: [] }]).heads).toEqual([deleted])
  })
  it('unavailable participants block the whole key', () => {
    expect(planConfigSyncKey([{ environmentId: 'a', heads: [], unavailable: true }, { environmentId: 'b', heads: [head('b', { b: 1 }, 'x', 't')] }]).kind).toBe('blocked')
  })
})
