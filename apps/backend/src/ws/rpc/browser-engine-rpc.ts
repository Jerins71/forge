import { Value } from '@sinclair/typebox/value'
import { rpcSchemas, rpcScopes, type Method, type RpcInput, type RpcOutput, type BrowserEngineSnapshot, type BrowserScreencastItem } from '@forge/protocol/environment-v2'
import type { Principal } from '../../environment/control/control-types.js'
import type { BrowserEngine } from '../../swarm/browser-automation/browser-engine.js'
import { StreamFault, StreamQueue } from '../../environment/streams/stream-budget.js'
export type BrowserEngineMethod = Extract<Method, `browser.tabs.${string}` | `browser.cookies.${string}` | `browser.screencast.${string}` | `browser.engine.${string}`>
export function createBrowserEngineRpc(engine: BrowserEngine, cookies?: import("../../swarm/browser-automation/browser-cookie-import.js").BrowserCookieImport) {
  const casts = new Map<string, { principal: Principal; ack(frameId: number): Promise<void> }>()
  function authorize(principal: Principal, scope: string) { if (!principal.scopes.has(scope as 'session:read')) throw new StreamFault('FORBIDDEN', 'Missing browser scope.') }
  async function execute<M extends BrowserEngineMethod>(principal: Principal, method: M, raw: RpcInput<M>): Promise<RpcOutput<M>> {
    authorize(principal, rpcScopes[method]); if (!Value.Check(rpcSchemas[method].input, raw)) throw new StreamFault('INVALID_INPUT', 'Invalid browser input.')
    let output: unknown
    if (method.startsWith('browser.cookies.')) {
      if (!cookies) throw new StreamFault('UNAVAILABLE', 'Cookie import is unavailable.')
      const owner = principal.deviceSessionId
      switch (method) {
        case 'browser.cookies.preview': { const input = raw as RpcInput<'browser.cookies.preview'>; return await cookies.preview(owner, input.sessionId, input.source) as RpcOutput<M> }
        case 'browser.cookies.apply': { const input = raw as RpcInput<'browser.cookies.apply'>; return await cookies.apply(owner, input.sessionId, input.importId, input.domains) as RpcOutput<M> }
        case 'browser.cookies.prepareSend': { const input = raw as RpcInput<'browser.cookies.prepareSend'>; return cookies.prepareSend(owner, input.sessionId, input.importId, input.domains) as RpcOutput<M> }
        case 'browser.cookies.receive': { const input = raw as RpcInput<'browser.cookies.receive'>; return await cookies.receive(input.sessionId, input.transfer) as RpcOutput<M> }
        case 'browser.cookies.audit': return await cookies.audit((raw as RpcInput<'browser.cookies.audit'>).sessionId) as RpcOutput<M>
        case 'browser.cookies.forget': { const input = raw as RpcInput<'browser.cookies.forget'>; return await cookies.forget(input.sessionId, input.domain) as RpcOutput<M> }
      }
    }
    switch (method) {
      case 'browser.engine.status': { const state = engine.setupState(); output = { state: state.browserEngineState, ...(state.browserEngineMessage ? { message: state.browserEngineMessage } : {}), version: engine.version }; break }
      case 'browser.engine.setup': output = await engine.setup(); break
      case 'browser.tabs.get': output = await engine.getSnapshot((raw as RpcInput<'browser.tabs.get'>).sessionId); break
      case 'browser.tabs.open': { const input = raw as RpcInput<'browser.tabs.open'>; output = await engine.open(input.sessionId, input); break }
      case 'browser.tabs.activate': { const input = raw as RpcInput<'browser.tabs.activate'>; output = await engine.activate(input.sessionId, input.tabId); break }
      case 'browser.tabs.close': { const input = raw as RpcInput<'browser.tabs.close'>; output = await engine.close(input.sessionId, input.tabId); break }
      case 'browser.tabs.navigate': { const input = raw as RpcInput<'browser.tabs.navigate'>; output = await engine.navigate(input.sessionId, input.tabId, input); break }
      case 'browser.tabs.resize': { const input = raw as RpcInput<'browser.tabs.resize'>; output = await engine.resize(input.sessionId, input.tabId, input.viewport); break }
      case 'browser.tabs.input': { const input = raw as RpcInput<'browser.tabs.input'>; await engine.input(input.sessionId, input.tabId, input.input); output = {}; break }
      case 'browser.tabs.recording.start': { const input = raw as RpcInput<'browser.tabs.recording.start'>; output = await engine.recordingStart(input.sessionId, input.tabId); break }
      case 'browser.tabs.recording.stop': { const input = raw as RpcInput<'browser.tabs.recording.stop'>; output = await engine.recordingStop(input.sessionId, input.tabId); break }
      case 'browser.screencast.ack': { const input = raw as RpcInput<'browser.screencast.ack'>; const cast = casts.get(input.subscriptionId); if (!cast || cast.principal !== principal) throw new StreamFault('NOT_FOUND', 'Screencast subscription is unavailable.'); await cast.ack(input.frameId); output = {}; break }
      default: throw new StreamFault('UNAVAILABLE', 'This browser operation is still being installed.')
    }
    return output as RpcOutput<M>
  }
  async function* tabs(principal: Principal, input: RpcInput<'browser.tabs.subscribe'>, signal: AbortSignal) {
    authorize(principal, 'session:read'); const queue = new StreamQueue<{ kind: 'snapshot'; snapshot: BrowserEngineSnapshot }>(); const stop = () => queue.end(); signal.addEventListener('abort', stop, { once: true })
    // Register before loading: a concurrent mutation cannot fall between bootstrap
    // and the stream. Revisions suppress a duplicate/inverted initial snapshot.
    const release = engine.watch(input.sessionId, snapshot => queue.push({ kind: 'snapshot', snapshot }))
    try { if (signal.aborted) return; const snapshot = await engine.getSnapshot(input.sessionId); let revision = snapshot.revision; yield { kind: 'snapshot' as const, snapshot }; for await (const item of queue) { if (item.snapshot.revision <= revision) continue; revision = item.snapshot.revision; yield item } }
    finally { release(); signal.removeEventListener('abort', stop) }
  }
  async function* screencast(principal: Principal, input: RpcInput<'browser.screencast.subscribe'>, signal: AbortSignal, subscriptionId: string) {
    authorize(principal, 'session:read'); const queue = new StreamQueue<BrowserScreencastItem>(); const stop = () => queue.end(); signal.addEventListener('abort', stop, { once: true })
    const cast = await engine.screencast(input.sessionId, input.tabId, input, item => queue.push(item)); casts.set(subscriptionId, { principal, ack: cast.ack })
    try { if (!signal.aborted) yield* queue }
    finally { casts.delete(subscriptionId); signal.removeEventListener('abort', stop); await cast.release() }
  }
  return { execute, tabs, screencast }
}
