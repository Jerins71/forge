import { expect, it, vi } from 'vitest'
import { createBrowserEngineClient } from '../feature-clients/browser-engine.js'
import type { RpcFeatureTransport } from '../feature-clients/index.js'
// Failure modes: no subscription identity, stale ack after reconnect, ack after
// release, swallowing frame errors, accidentally persisting ephemeral payloads.
it('acks only the current live screencast subscription and releases it', async () => {
  let subscribed: (id: string) => void = () => {}
  let observed: { next(item: unknown): void; error(error: unknown): void } = { next() {}, error() {} }
  const request = vi.fn(async () => ({})); const release = vi.fn()
  const rpc = { request, subscribe: (_method: string, _input: unknown, observer: typeof observed, onSubscribed: typeof subscribed) => { observed = observer; subscribed = onSubscribed; return release } } as unknown as RpcFeatureTransport
  const observer = { next: vi.fn(), error: vi.fn() }
  const cast = createBrowserEngineClient(rpc).screencast({ sessionId: 's', tabId: 't' }, observer)
  await cast.ack(1); expect(request).not.toHaveBeenCalled()
  subscribed('first'); observed.next({ kind: 'state', tabId: 't', state: 'ready' }); expect(observer.next).toHaveBeenCalled()
  await cast.ack(1); expect(request).toHaveBeenLastCalledWith('browser.screencast.ack', { subscriptionId: 'first', frameId: 1 })
  const error = new Error('reconnect'); observed.error(error); expect(observer.error).toHaveBeenCalledWith(error)
  request.mockClear(); await cast.ack(2); expect(request).not.toHaveBeenCalled()
  subscribed('second'); await cast.ack(3); expect(request).toHaveBeenLastCalledWith('browser.screencast.ack', { subscriptionId: 'second', frameId: 3 })
  cast.release(); expect(release).toHaveBeenCalledOnce()
  request.mockClear(); subscribed('late'); await cast.ack(4); expect(request).not.toHaveBeenCalled()
})
