import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserCookieImport } from '../browser-automation/browser-cookie-import.js'
import type { BrowserEngine } from '../browser-automation/browser-engine.js'
import type { ImportCookie } from '../browser-automation/chrome-cookies.js'
const stores: BrowserCookieImport[] = []
afterEach(() => { for (const store of stores.splice(0)) store.shutdown(); vi.useRealTimers() })
function fixture() {
  vi.useFakeTimers()
  const cookies: ImportCookie[] = [{ name: 'session', value: 'synthetic-only', domain: '.example.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }]
  const engine = { projectForSession: () => 'project', desktop: { available: false } } as unknown as BrowserEngine
  const store = new BrowserCookieImport({ engine, dataDir: '/unused', running: async () => cookies })
  stores.push(store)
  const previews = (store as unknown as { previews: Map<string, { cookies: ImportCookie[] }> }).previews
  return { store, previews, engine }
}
async function preview(store: BrowserCookieImport) {
  const result = await store.preview('owner', 'session', 'chrome-running')
  if (!result.ok) throw new Error('Synthetic preview failed')
  return result
}
describe('cookie staging owns real memory expiry', () => {
  it('drops staged plaintext at five minutes without any subsequent cookie operation', async () => {
    const f = fixture(), p = await preview(f.store)
    expect(f.previews.size).toBe(1)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1); expect(f.previews.size).toBe(1)
    await vi.advanceTimersByTimeAsync(1); expect(f.previews.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(() => f.store.prepareSend('owner', 'session', p.importId, ['example.test'])).toThrow(/expired/)
  })
  it('releases timer and plaintext references on cancel, successful export, archive and shutdown', async () => {
    const f = fixture(), p = await preview(f.store)
    f.store.cancel('owner', 'session', p.importId)
    expect(f.previews.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
    const sent = await preview(f.store); f.store.prepareSend('owner', 'session', sent.importId, ['example.test'])
    expect(f.previews.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
    await preview(f.store); f.store.releaseSession('session')
    expect(f.previews.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
    await preview(f.store); f.store.shutdown()
    expect(f.previews.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })
  it('does not stage a source read that finishes after session admission closes or shutdown', async () => {
    const f = fixture()
    let finish!: (cookies: ImportCookie[]) => void
    const read = new Promise<ImportCookie[]>(resolve => { finish = resolve })
    const store = new BrowserCookieImport({ engine: f.engine, dataDir: '/unused', running: () => read }); stores.push(store)
    const pending = store.preview('owner', 'session', 'chrome-running')
    store.shutdown(); finish([])
    expect((await pending).ok).toBe(false)
    const archived = new BrowserCookieImport({ engine: f.engine, dataDir: '/unused', running: async () => { vi.spyOn(f.engine, 'projectForSession').mockImplementation(() => { throw new Error('Archived') }); return [] } }); stores.push(archived)
    expect((await archived.preview('owner', 'session', 'chrome-running')).ok).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
