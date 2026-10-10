import { describe, expect, it } from 'vitest'
import { DetailCache } from '../stores/detail-cache.js'
import { ShellStore } from '../stores/shell-store.js'
import { decodeStreamItem } from '../decode.js'
import type { EnvironmentSupervisor } from '../connection/supervisor.js'
import type { RuntimePorts } from '../ports.js'
const epoch = '00000000-0000-4000-8000-000000000001'
const recovery = { recoveryId: 'boot', bootId: 'boot', createdAt: '2026-10-09T00:00:00.000Z', interruptedManagers: ['s'], interruptedWorkers: [], undeliveredReports: [] }
// Failure cases: decoder silently drops known features, replay misses reducer
// fields, ephemeral metadata outlives detail release, shell recovery needs selection.
describe('typed feature consumers', () => {
  it.each(['plan.upsert','goal.upsert','recovery.upsert'])('decodes %s as a known live/replay event', type => {
    const snapshot = type === 'plan.upsert' ? { revision: 1, updatedAt: null, plan: [] } : { revision: 1, measuredAt: '2026-10-09T00:00:00.000Z', goal: null }
    const event = type === 'recovery.upsert' ? { type, recovery } : { type, snapshot }
    expect(decodeStreamItem('session.subscribe', { kind: 'event', streamEpoch: epoch, sequence: 2, event })).toHaveProperty('kind', 'event')
  })
  it('retains shell recovery through fresh snapshot and replay without detail selection', () => {
    const store = new ShellStore({} as RuntimePorts, () => {}, () => {}, () => {}, () => {})
    store.ingest({ kind: 'snapshot', streamEpoch: epoch, sequence: 1, snapshot: { projects: [], sessions: [], nextPage: null, recovery } })
    store.ingest({ kind: 'synchronized', streamEpoch: epoch, sequence: 1 })
    expect(store.getSnapshot()).toHaveProperty('recovery', recovery)
    store.ingest({ kind: 'event', streamEpoch: epoch, sequence: 2, event: { type: 'recovery.upsert', recovery: null } })
    store.flush(); expect(store.getSnapshot()).toHaveProperty('recovery', null)
  })
  it('receives typed ephemeral activity and releases all feature traffic with the lease', () => {
    const observers = new Map<string, { next(item: unknown): void }>()
    const releases: string[] = []; const batches: (() => void)[] = []
    const supervisor = { subscribe: (method: string, _input: unknown, observer: { next(item: unknown): void }) => { observers.set(method, observer); return () => { releases.push(method); observers.delete(method) } } } as unknown as EnvironmentSupervisor
    const cache = new DetailCache(supervisor, { scheduleBatch: (fn: () => void) => { batches.push(fn); return () => {} } } as RuntimePorts, () => {}, () => {})
    const lease = cache.acquire('s')
    expect(observers.has('session.features.subscribe')).toBe(true)
    const event = { type: 'tool.activity', activity: { sessionAgentId: 's', revision: 1, toolCount: 1 } }
    observers.get('session.features.subscribe')!.next({ event }); for (const flush of batches.splice(0)) flush()
    expect([...lease.store.getSnapshot().transient.values()]).toContainEqual(event)
    lease.release(); expect(releases).toContain('session.features.subscribe'); expect(lease.store.getSnapshot().transient.size).toBe(0)
  })
})

// Failure mode: separately bounded live conversation and Browser projections
// exceed the existing cache quota together when Browser bytes are not counted.
it('counts canonical Browser state in the mounted detail cache quota', async () => {
  const { defaultFixtureSeeds } = await import('../fixture.js')
  const seed = defaultFixtureSeeds()[0]!.details!['session-1']!
  const observers = new Map<string, { next(item: unknown): void }>()
  const batches: (() => void)[] = []
  const supervisor = { subscribe: (method: string, input: () => { sessionId: string }, observer: { next(item: unknown): void }) => {
    const key = `${method}:${input().sessionId}`; observers.set(key, observer); return () => observers.delete(key)
  } } as unknown as EnvironmentSupervisor
  const cache = new DetailCache(supervisor, { scheduleBatch: (fn: () => void) => { batches.push(fn); return () => {} } } as RuntimePorts, () => {}, () => {})
  const leases = []
  try {
    for (let index = 0; index < 20; index++) {
      const id = `session-${index}`; leases.push(cache.acquire(id))
      const detail = observers.get(`session.subscribe:${id}`)!
      detail.next({ kind: 'snapshot', streamEpoch: epoch, sequence: 1, snapshot: { ...seed, session: { ...seed.session, sessionId: id }, items: [] } })
      for (let itemIndex = 0; itemIndex < 190; itemIndex++) detail.next({ kind: 'event', streamEpoch: epoch, sequence: itemIndex + 2, event: { type: 'item.upsert', item: { ...seed.items[0]!, itemId: `item-${itemIndex}`, actorId: id, text: 't'.repeat(8192) } } })
      for (const flush of batches.splice(0)) flush()
      const now = '2026-10-10T00:00:00.000Z'
      observers.get(`browser.subscribe:${id}`)!.next({ snapshot: { schemaVersion: 2, sessionAgentId: id, profileId: 'forge', hostingState: 'hosted', activeTabId: null, defaultTabId: null, panelVisible: false, recentActions: [], revision: 1, createdAt: now, updatedAt: now,
        tabs: Array.from({ length: 100 }, (_, tabIndex) => ({ targetAffinity: 'managed-electron', tabId: `tab-${tabIndex}`, sessionAgentId: id, profileId: 'forge', url: 'about:blank', title: 't'.repeat(4096), lifecycle: 'ready', loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'none', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null, error: null, createdAt: now, updatedAt: now })) } })
    }
    expect(leases.some(lease => lease.store.getSnapshot().freshness === 'unavailable')).toBe(true)
  } finally { cache.dispose() }
})
