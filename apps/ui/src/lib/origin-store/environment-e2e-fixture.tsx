/* eslint-disable react-refresh/only-export-components -- opt-in browser acceptance instrumentation */
import { Profiler, useEffect, useState, useSyncExternalStore, type ReactNode, type ProfilerOnRenderCallback } from 'react'
import { createRoot } from 'react-dom/client'
import type { EnvironmentRegistry, DetailState } from '@forge/client-runtime'
import type { SessionRef } from '@forge/protocol/environment-v2'

export interface E2EPerformance {
  commits: Array<{ id: string; phase: string; duration: number; start: number; commit: number }>
  rows: Record<string, number>
  selectors: Record<string, number>
}
declare global {
  interface Window {
    __forgeE2EPerformance?: E2EPerformance
    __forgeE2ERuntime?: {
      snapshot(): Array<{ environmentId: string; phase: string; fresh: boolean; complete: boolean; sessions: number; cursor: unknown }>
      mountDetails(refs: SessionRef[]): void
      setEnabled(id: string, enabled: boolean): Promise<void>
      retryNow(id: string): void
      flush(): Promise<void>
      freshnessHistory(): Array<{ environmentId: string; phase: string; fresh: boolean; complete: boolean; sessions: number }>
      detailEvidence(ref: SessionRef): unknown
    }
  }
}
const enabled = import.meta.env.VITE_FORGE_E2E_PROFILE === '1' || import.meta.env.VITE_FORGE_E2E_PLATFORM === '1'
const onRender: ProfilerOnRenderCallback = (id, phase, duration, _base, start, commit) => {
  window.__forgeE2EPerformance?.commits.push({ id, phase, duration, start, commit })
}
export function profileSidebar(children: ReactNode) {
  return enabled ? <Profiler id="AgentSidebar" onRender={onRender}>{children}</Profiler> : children
}
export function recordEnvironmentRow(environmentId: string, sessionId: string) {
  if (!enabled || typeof window === 'undefined' || !window.__forgeE2EPerformance) return
  const key = `${environmentId}:${sessionId}`
  const metrics = window.__forgeE2EPerformance
  metrics.rows[key] = (metrics.rows[key] ?? 0) + 1
}
export function recordEnvironmentSelector(environmentId: string) {
  if (!enabled || typeof window === 'undefined' || !window.__forgeE2EPerformance) return
  const metrics = window.__forgeE2EPerformance
  metrics.selectors[environmentId] = (metrics.selectors[environmentId] ?? 0) + 1
}
function DetailCard({ registry, target }: { registry: EnvironmentRegistry; target: SessionRef }) {
  const [lease, setLease] = useState<ReturnType<ReturnType<EnvironmentRegistry['get']>['acquireDetail']> | null>(null)
  useEffect(() => {
    const value = registry.get(target.environmentId).acquireDetail(target.sessionId)
    setLease(value)
    return value.release
  }, [registry, target.environmentId, target.sessionId])
  return lease ? <DetailProjection target={target} store={lease.store} /> : <div>Mounting detail</div>
}
function DetailProjection({ target, store }: { target: SessionRef; store: { getSnapshot(): DetailState; subscribe(selector: (state: DetailState) => DetailState, listener: () => void): () => void } }) {
  const state = useSyncExternalStore(listener => store.subscribe(s => s, listener), () => store.getSnapshot())
  return <article data-e2e-detail={`${target.environmentId}:${target.sessionId}`} data-freshness={state.freshness} style={{ border: '1px solid #888', padding: 8, maxHeight: 150, overflow: 'auto' }}>
    <strong>{target.sessionId}</strong>
    <p>{state.projection?.items.at(-1)?.text ?? 'Waiting for synthetic provider'}</p>
  </article>
}
/** Browser acceptance mounts real React consumers of the application's one registry; it never mutates stores or creates sockets. */
export function installEnvironmentE2EFixture(registry: EnvironmentRegistry) {
  if (import.meta.env.VITE_FORGE_E2E_PLATFORM !== '1') return
  window.__forgeE2EPerformance ??= { commits: [], rows: {}, selectors: {} }
  const host = document.createElement('section')
  host.setAttribute('aria-label', 'Mounted acceptance detail views')
  Object.assign(host.style, { position: 'fixed', right: '8px', bottom: '8px', width: '460px', zIndex: '50', background: '#111', color: '#fff' })
  document.body.append(host)
  const root = createRoot(host)
  const history: Array<{ environmentId: string; phase: string; fresh: boolean; complete: boolean; sessions: number }> = []
  const observed = new Set<string>()
  const previous = new Map<string, string>()
  const attach = () => {
    for (const environmentId of registry.catalog.getSnapshot().keys()) {
      if (observed.has(environmentId)) continue
      observed.add(environmentId)
      const client = registry.get(environmentId)
      const record = () => {
        const shell = client.shell.getSnapshot(), connection = client.connection.getSnapshot()
        const value = { environmentId, phase: connection.phase, fresh: connection.shellFresh, complete: shell.complete, sessions: shell.sessions.size }
        const serialized = JSON.stringify(value)
        if (previous.get(environmentId) === serialized) return
        previous.set(environmentId, serialized); history.push(value)
      }
      client.shell.subscribe(state => state, record)
      client.connection.subscribe(state => state, record)
      record()
    }
  }
  registry.catalog.subscribe(state => state, attach)
  attach()
  window.__forgeE2ERuntime = {
    detailEvidence: ref => {
      const lease = registry.get(ref.environmentId).acquireDetail(ref.sessionId)
      try {
        const state = lease.store.getSnapshot()
        return { freshness: state.freshness, sessionId: state.projection?.session.sessionId, transient: [...state.transient.values()].map(value => { const event = value as any; return { type: event.type, sessionAgentId: event.sessionAgentId, terminalCount: event.terminals?.length, terminalId: event.terminal?.terminalId } }) }
      } finally { lease.release() }
    },
    freshnessHistory: () => [...history],
    snapshot: () => [...registry.catalog.getSnapshot().keys()].map(environmentId => {
      const client = registry.get(environmentId), shell = client.shell.getSnapshot(), connection = client.connection.getSnapshot()
      return { environmentId, phase: connection.phase, fresh: connection.shellFresh, complete: shell.complete, sessions: shell.sessions.size, cursor: shell.cursor }
    }),
    mountDetails: refs => root.render(<>{refs.map(target => <DetailCard key={`${target.environmentId}:${target.sessionId}`} registry={registry} target={target} />)}</>),
    setEnabled: (id, value) => registry.setEnabled(id, value),
    retryNow: id => registry.retryNow(id),
    flush: () => Promise.all([...registry.catalog.getSnapshot().keys()].map(id => (registry.get(id) as unknown as { flushCache(): Promise<void> }).flushCache())).then(() => undefined),
  }
}
