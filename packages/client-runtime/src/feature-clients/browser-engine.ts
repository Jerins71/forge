import type { Method, RpcInput, RpcOutput, RpcStreamItem } from '@forge/protocol/environment-v2'
import type { StreamObserver } from '../types.js'
import type { RpcFeatureTransport } from './index.js'
export type BrowserEngineMethod = Extract<Method, `browser.engine.${string}` | `browser.tabs.${string}` | `browser.cookies.${string}` | `browser.screencast.${string}`>
/** Browser state, frames and cookie transfers stay transient. Actions are never
 * put in the durable command queue or replayed after a reconnect. */
export function createBrowserEngineClient(rpc: RpcFeatureTransport) {
  return {
    request: <M extends BrowserEngineMethod>(method: M, input: RpcInput<M>): Promise<RpcOutput<M>> => rpc.request(method, input),
    tabs: (sessionId: string, observer: StreamObserver<RpcStreamItem<'browser.tabs.subscribe'>>) => rpc.subscribe('browser.tabs.subscribe', { sessionId }, observer),
    screencast: (input: RpcInput<'browser.screencast.subscribe'>, observer: StreamObserver<RpcStreamItem<'browser.screencast.subscribe'>>) => rpc.subscribe('browser.screencast.subscribe', input, observer),
  }
}
