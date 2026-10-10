import { Type } from '@sinclair/typebox'
import { BrowserSnapshotV2Schema, decodeEnvironmentValue, type BrowserHostMessageV2, type RpcStreamItem } from '@forge/protocol/environment-v2'
import type { BrowserAutomationRequest, BrowserAutomationResponse, BrowserHostLifecycleRequest, BrowserHostLifecycleResponse, BrowserHostRegistration, BrowserSessionSnapshot, BrowserHostConnectionSnapshot, BrowserHostSessionStateReport, BrowserHostStateReportResult } from '@forge/protocol'
import { EnvironmentRuntimeError } from '../errors.js'
import type { RpcFeatureTransport } from './index.js'
export interface BrowserHostObserver {
  host(host: BrowserHostConnectionSnapshot): void
  hydrated(sessions: BrowserSessionSnapshot[]): void
  snapshot(snapshot: BrowserSessionSnapshot): void
  error(error: unknown): void
  disconnected(): void
}
/** The single local-host consumer owns reconnect hydration. Automation callbacks
 * and physical replies are never recovered/replayed by the durable command owner. */
export function createBrowserHostClient(rpc: RpcFeatureTransport) {
  let epoch = 0
  let host: BrowserHostConnectionSnapshot | null = null
  let release = () => {}
  const reports = new Map<string, { resolve(value: BrowserHostStateReportResult): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>()
  const seen = new Map<string, number>()
  const reset = () => { epoch++; host = null; for (const report of reports.values()) { clearTimeout(report.timer); report.reject(new EnvironmentRuntimeError('UNAVAILABLE', 'Browser host disconnected; report outcome is unknown')) }; reports.clear() }
  async function send(message: BrowserHostMessageV2, expectedEpoch: number) {
    const text = JSON.stringify(message); const partChars = 262144; const count = Math.ceil(text.length / partChars)
    if (count > 128) throw new EnvironmentRuntimeError('PAYLOAD_TOO_LARGE', 'Browser response exceeds its transfer budget')
    const transferId = crypto.randomUUID()
    for (let index = 0; index < count; index++) {
      if (epoch !== expectedEpoch) throw new EnvironmentRuntimeError('UNAVAILABLE', 'Stale browser response generation')
      await rpc.request('browser.host.send', { transferId, index, count, data: text.slice(index * partChars, (index + 1) * partChars) })
    }
  }
  function register(registration: BrowserHostRegistration, observer: BrowserHostObserver, handleRequest: (request: BrowserAutomationRequest) => Promise<BrowserAutomationResponse>, handleLifecycle?: (request: BrowserHostLifecycleRequest) => Promise<BrowserHostLifecycleResponse>): () => void {
    release(); reset()
    let live = true
    let hydrationId = ''
    let hydrating = true
    const hydrationUpdates = new Map<string, BrowserSessionSnapshot>()
    let chunks: Uint8Array[] = []
    let hydrationBytes = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    const disconnected = () => { reset(); seen.clear(); hydrating = true; hydrationUpdates.clear(); chunks = []; hydrationBytes = 0; hydrationId = ''; observer.disconnected() }
    async function handshake(expectedEpoch: number) {
      try {
        const registered = await rpc.request('browser.host.register', { registration: { ...registration, registeredAt: new Date().toISOString() } })
        if (!live || epoch !== expectedEpoch) return
        host = registered; observer.host(registered)
        if (host.hostId !== registration.hostId || host.hostGeneration === null) throw new EnvironmentRuntimeError('CONFLICT', 'Browser host registration changed')
        hydrationId = crypto.randomUUID(); chunks = []; hydrationBytes = 0
        await rpc.request('browser.host.hydrate', { requestId: hydrationId, hostId: host.hostId, hostGeneration: host.hostGeneration })
      } catch (error) {
        if (!live || epoch !== expectedEpoch) return
        observer.error(error)
        if (error instanceof EnvironmentRuntimeError && error.retryable) retry = setTimeout(() => { retry = undefined; if (live && epoch === expectedEpoch) void handshake(expectedEpoch) }, 1000)
      }
    }
    const matches = (request: { hostId: string; hostGeneration: number }) => host?.hostId === request.hostId && host.hostGeneration === request.hostGeneration
    function handle(item: RpcStreamItem<'browser.host.attach'>) {
      if (item.kind === 'attached') { disconnected(); void handshake(epoch); return }
      if (item.kind === 'host') { if (item.host.hostId === registration.hostId || !item.host.connected) { host = item.host; observer.host(item.host) }; return }
      if (item.kind === 'session') {
        if (hydrating && (hydrationUpdates.get(item.snapshot.sessionAgentId)?.revision ?? -1) < item.snapshot.revision) hydrationUpdates.set(item.snapshot.sessionAgentId, item.snapshot)
        observer.snapshot(item.snapshot); return
      }
      if (item.kind === 'report.result') { const pending = reports.get(item.requestId); if (pending) { reports.delete(item.requestId); clearTimeout(pending.timer); pending.resolve(item.result) }; return }
      if (item.kind === 'hydration') {
        if (!matches(item) || item.requestId !== hydrationId || item.chunkIndex !== chunks.length || item.chunkCount < 1 || item.chunkCount > 4096) return
        try {
          const binary = atob(item.payloadBase64); const bytes = Uint8Array.from(binary, char => char.charCodeAt(0)); hydrationBytes += bytes.length
          if (hydrationBytes > 32 * 1024 * 1024) throw new Error('Browser hydration exceeds budget')
          chunks.push(bytes); if (chunks.length !== item.chunkCount) return
          const joined = new Uint8Array(hydrationBytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length }
          const decoded = decodeEnvironmentValue(Type.Array(BrowserSnapshotV2Schema, { maxItems: 500 }), JSON.parse(new TextDecoder().decode(joined)))
          if (!decoded) throw new Error('Invalid Browser hydration')
          const sessions = new Map(decoded.map(snapshot => [snapshot.sessionAgentId, snapshot]))
          for (const [id, snapshot] of hydrationUpdates) if (snapshot.revision > (sessions.get(id)?.revision ?? -1)) sessions.set(id, snapshot)
          hydrationId = ''; chunks = []; hydrationBytes = 0; hydrating = false; hydrationUpdates.clear()
          observer.hydrated([...sessions.values()].filter(snapshot => snapshot.hostingState !== 'removed'))
        } catch (error) { observer.error(error) }
        return
      }
      const request = item.request
      if (!matches(request)) return
      const key = `${request.hostId}:${request.hostGeneration}:${request.requestId}`
      const now = Date.now()
      // A deadline is the safe eviction boundary: an expired operation is never
      // executed, even if its deduplication entry has left this bounded cache.
      for (const [id, deadline] of seen) if (deadline <= now) seen.delete(id)
      if (seen.has(key)) return
      const deadline = item.kind === 'automation' ? Date.parse((request as BrowserAutomationRequest).deadlineAt) : Number.POSITIVE_INFINITY
      if (!Number.isFinite(deadline) && item.kind === 'automation' || deadline <= now || seen.size >= 256) {
        const error = new Error('Browser request expired or host request budget is exhausted; inspect before retrying')
        const response = item.kind === 'automation' ? { kind: 'respond' as const, response: automationFailure(request as BrowserAutomationRequest, error) }
          : { kind: 'lifecycle.respond' as const, response: lifecycleFailure(request as BrowserHostLifecycleRequest, error) }
        void send(response, epoch).catch(observer.error)
        return
      }
      seen.set(key, deadline)
      const expectedEpoch = epoch
      const work = item.kind === 'automation' ? handleRequest(request as BrowserAutomationRequest).catch(error => automationFailure(request as BrowserAutomationRequest, error))
        : handleLifecycle ? handleLifecycle(request as BrowserHostLifecycleRequest).catch(error => lifecycleFailure(request as BrowserHostLifecycleRequest, error)) : Promise.resolve(lifecycleFailure(request as BrowserHostLifecycleRequest, new Error('Lifecycle host is unavailable')))
      void work.then(response => {
        if (!live || epoch !== expectedEpoch || !matches(request)) return
        return send(item.kind === 'automation' ? { kind: 'respond', response: response as BrowserAutomationResponse } : { kind: 'lifecycle.respond', response: response as BrowserHostLifecycleResponse }, expectedEpoch)
      }).catch(observer.error)
    }
    const detach = rpc.subscribe('browser.host.attach', {}, { next: handle, error: error => { if (retry) clearTimeout(retry); disconnected(); observer.error(error) } })
    const dispose = () => { if (!live) return; live = false; if (retry) clearTimeout(retry); detach(); disconnected() }
    release = dispose
    return dispose
  }
  function lease() { if (!host?.connected || !host.hostId || host.hostGeneration === null) throw new EnvironmentRuntimeError('UNAVAILABLE', 'Local browser host is unavailable'); return { hostId: host.hostId, hostGeneration: host.hostGeneration } }
  return { register,
    focus: async (focused: boolean) => { await rpc.request('browser.host.focus', { ...lease(), focused }) },
    reveal: (input: { sessionId: string; tabId: string; sequence: number }) => rpc.request('browser.host.reveal', { ...lease(), ...input }),
    report: (sessions: BrowserHostSessionStateReport[]): Promise<BrowserHostStateReportResult> => {
      const requestId = crypto.randomUUID(); const message = { kind: 'report' as const, requestId, ...lease(), sessions }; const expectedEpoch = epoch
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reports.delete(requestId); reject(new EnvironmentRuntimeError('UNAVAILABLE', 'Browser report result is unknown; hydrate before another report')) }, 15000)
        reports.set(requestId, { resolve, reject, timer }); void send(message, expectedEpoch).catch(error => { const pending = reports.get(requestId); if (!pending) return; reports.delete(requestId); clearTimeout(timer); reject(error) })
      })
    },
  }
}
function automationFailure(request: BrowserAutomationRequest, error: unknown): BrowserAutomationResponse { return { requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, tabId: request.tabId, hostId: request.hostId, hostGeneration: request.hostGeneration, operation: request.operation, ok: false, elapsedMs: 0, error: { code: 'execution-failed', message: error instanceof Error ? error.message : String(error), retryable: false } } }
function lifecycleFailure(request: BrowserHostLifecycleRequest, error: unknown): BrowserHostLifecycleResponse { return { requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, hostId: request.hostId, hostGeneration: request.hostGeneration, kind: request.kind, ok: false, error: { code: 'execution-failed', message: error instanceof Error ? error.message : String(error), retryable: false } } }
