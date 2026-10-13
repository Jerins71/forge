import { expect, it } from 'vitest'
import { splitApply, runConfigSync } from '../config-sync.js'
// Real-store schedules, CAS, partial reads and batch recovery are in the backend acceptance suite.
it.each([undefined, 2])('does not send requests to environments without the current sync capability (%s)', async capability => {
  let called = false
  const report = await runConfigSync([{ environmentId: 'old', capability, label: 'Old', projects: new Map(), fetchJson: async <T>() => { called = true; return {} as T } }])
  expect(called).toBe(false); expect(report.environments[0]!.error).toBe('Update required')
})
it('rejects duplicate logical targets before splitting batches', () => {
  const write = { key: 'global/worker-presets.json', expectedVersionId: null, expectHash: null, heads: [] }
  expect(() => splitApply({ version: 3, writes: [write, write] })).toThrow(/duplicate/i)
})
