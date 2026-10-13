import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CONFIG_SYNC_MAX_REQUEST_BYTES,
  type ConfigSyncApplyRequest,
  type ConfigSyncBase,
  type ConfigSyncConflict,
  type ConfigSyncLeaseRequest,
  type ConfigSyncSkipped,
} from '@forge/protocol'
import { runConfigSync, type ConfigSyncParticipant } from '../config-sync.js'

// Ways a pass can go wrong at the request level: one oversized apply failing a whole first sync,
// a failed batch recording a base for a write that never happened (so the next pass would treat the
// old file as an edit), a file the backend cannot sync disappearing from the report, and two hubs
// both writing.
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const b64 = (text: string) => Buffer.from(text).toString('base64')

function fakeEnvironment(environmentId: string, files: Record<string, string>, options: { skipped?: ConfigSyncSkipped[]; failApplyOver?: number; leases?: { holder: string | null } } = {}) {
  const state = { base: {} as Record<string, ConfigSyncBase>, conflicts: {} as Record<string, ConfigSyncConflict>, joined: false }
  const applies: ConfigSyncApplyRequest[] = []
  const lease = options.leases ?? { holder: null as string | null }
  const participant: ConfigSyncParticipant = {
    environmentId, label: environmentId, projects: new Map(),
    async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
      if (path === '/api/settings/sync/manifest') {
        return { files: Object.entries(files).map(([key, text]) => ({ key, hash: hash(text), size: text.length, mtimeMs: 0 })), base: state.base, conflicts: state.conflicts, joining: !state.joined, skipped: options.skipped ?? [] } as T
      }
      if (path.startsWith('/api/settings/sync/file?key=')) {
        const key = decodeURIComponent(path.slice('/api/settings/sync/file?key='.length))
        return { key, hash: hash(files[key]!), path: `/data/${key}`, contentBase64: b64(files[key]!) } as T
      }
      if (path === '/api/settings/sync/lease') {
        const request = JSON.parse(String(init!.body)) as ConfigSyncLeaseRequest
        const granted = !lease.holder || lease.holder === request.holder || request.takeover === true
        if (granted) lease.holder = request.holder
        return { granted, holder: lease.holder, until: null } as T
      }
      if (path === '/api/settings/sync/apply') {
        const body = String(init!.body)
        const request = JSON.parse(body) as ConfigSyncApplyRequest
        if (options.failApplyOver !== undefined && (request.writes?.length ?? 0) > 0 && body.length > options.failApplyOver) throw new Error('Request body too large')
        applies.push(request)
        const applied: string[] = []
        for (const write of request.writes ?? []) {
          if (write.contentBase64 === null) delete files[write.key]
          else files[write.key] = Buffer.from(write.contentBase64, 'base64').toString()
          applied.push(write.key)
        }
        for (const [key, base] of Object.entries(request.base ?? {})) if (base) state.base[key] = base
        if (request.joined) state.joined = true
        return { applied, stale: [] } as T
      }
      throw new Error(`unexpected ${path}`)
    },
  }
  return { participant, files, state, applies }
}

describe('runConfigSync requests', () => {
  it('splits a large first sync into several apply requests and applies every file', async () => {
    const chunk = 'x'.repeat(1024 * 1024)
    const source: Record<string, string> = {}
    for (let i = 0; i < 20; i++) source[`global/skills/big/part-${i}.txt`] = `${i}${chunk}`
    const a = fakeEnvironment('a', source)
    const b = fakeEnvironment('b', {})
    const report = await runConfigSync([a.participant, b.participant])
    expect(Object.keys(b.files).sort()).toEqual(Object.keys(source).sort())
    const writeRequests = b.applies.filter((r) => r.writes?.length)
    expect(writeRequests.length).toBeGreaterThan(1)
    for (const request of writeRequests) {
      expect(request.writes!.reduce((n, w) => n + (w.contentBase64?.length ?? 0), 0)).toBeLessThanOrEqual(Math.ceil(CONFIG_SYNC_MAX_REQUEST_BYTES * 4 / 3))
    }
    expect(report.skipped).toEqual([])
    expect(b.state.joined).toBe(true)
  })

  it('reports files the backend cannot sync and writes whose request failed, without recording their base', async () => {
    const a = fakeEnvironment('a', { 'global/worker-presets.json': 'presets', 'global/skills/s/SKILL.md': 'skill' }, { skipped: [{ key: 'global/skills/s/model.bin', size: 3_000_000, reason: 'too-large' }] })
    const b = fakeEnvironment('b', {}, { failApplyOver: 10 })
    const report = await runConfigSync([a.participant, b.participant])
    expect(report.skipped).toEqual(expect.arrayContaining([
      { key: 'global/skills/s/model.bin', environmentId: 'a', label: 'a', reason: 'too-large', size: 3_000_000 },
      expect.objectContaining({ key: 'global/worker-presets.json', environmentId: 'b', reason: 'failed', detail: 'Request body too large' }),
      expect.objectContaining({ key: 'global/skills/s/SKILL.md', environmentId: 'b', reason: 'failed' }),
    ]))
    expect(b.files).toEqual({})
    expect(b.state.base).toEqual({})
    expect(b.state.joined).toBe(false)
  })

  it('runs only while holding the hub lease, and an explicit sync takes it over', async () => {
    const leases = { holder: 'other-window' as string | null }
    const a = fakeEnvironment('a', { 'global/worker-presets.json': 'presets' }, { leases })
    const b = fakeEnvironment('b', {})
    const deferred = await runConfigSync([a.participant, b.participant], { holder: 'this-window' })
    expect(deferred.activeHub).toBe('other-window')
    expect(b.files).toEqual({})
    expect(a.applies).toEqual([])

    const taken = await runConfigSync([a.participant, b.participant], { holder: 'this-window', takeover: true })
    expect(taken.activeHub).toBeUndefined()
    expect(leases.holder).toBe('this-window')
    expect(b.files).toEqual({ 'global/worker-presets.json': 'presets' })
  })
})
