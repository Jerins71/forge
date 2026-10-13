import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Method, RpcInput, Scope } from '@forge/protocol/environment-v2'
import type { Principal } from '../../environment/control/control-types.js'
import { BrowserEngine } from '../../swarm/browser-automation/browser-engine.js'
import { BrowserCookieImport } from '../../swarm/browser-automation/browser-cookie-import.js'
import { createBrowserEngineRpc } from './browser-engine-rpc.js'
import { socketFixture, principal } from './__tests__/fixtures.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const synthetic = () => [{ name: 'session', value: 'synthetic-only', domain: '.example.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }]
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'forge-cookie-authz-'))
  const engine = new BrowserEngine({ dataDir, resolveSession: id => id === 'session' ? 'project' : undefined })
  const running = vi.fn(async () => synthetic()), database = vi.fn(async () => synthetic())
  const cookies = new BrowserCookieImport({ engine, dataDir, running, database })
  const addCookies = vi.fn(async () => {}), clearCookies = vi.fn(async () => {})
  vi.spyOn(engine, 'withCookieContext').mockImplementation(async (_id, work) => work({ addCookies, cookies: async () => synthetic(), clearCookies } as never))
  const transport = await socketFixture({ browserEngine: createBrowserEngineRpc(engine, cookies) })
  cleanups.push(async () => { await transport.close(); cookies.shutdown(); await engine.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  async function connect(scopes: Scope[]) {
    const client = await transport.connect({ ...principal, scopes: new Set(scopes) })
    return async <M extends Method>(method: M, input: RpcInput<M>) => {
      const requestId = randomUUID(); client.send({ type: 'request', requestId, method, input })
      return client.next(frame => 'requestId' in frame && frame.requestId === requestId)
    }
  }
  return { cookies, engine, running, database, addCookies, clearCookies, connect }
}

describe('cookie import through the real browser RPC/socket handler', () => {
  it('denies every source/staging/export/import operation to Run sessions and allows admin', async () => {
    const f = await fixture(), operator = await f.connect(['session:operate']), admin = await f.connect(['settings:admin'])
    for (const source of ['chrome-running', 'chrome-database'] as const)
      expect(await operator('browser.cookies.preview', { sessionId: 'session', source })).toMatchObject({ type: 'error', error: { code: 'FORBIDDEN' } })
    expect(f.running).not.toHaveBeenCalled(); expect(f.database).not.toHaveBeenCalled()
    const preview = await f.cookies.preview(principal.deviceSessionId, 'session', 'chrome-running')
    expect(preview.ok).toBe(true); if (!preview.ok) throw new Error('Synthetic preview failed')
    const selected = { sessionId: 'session', importId: preview.importId, domains: ['example.test'] }
    for (const method of ['browser.cookies.apply', 'browser.cookies.prepareSend'] as const)
      expect(await operator(method, selected)).toMatchObject({ type: 'error', error: { code: 'FORBIDDEN' } })
    expect(f.addCookies).not.toHaveBeenCalled()
    const sent = await admin('browser.cookies.prepareSend', selected)
    expect(sent).toMatchObject({ type: 'result', output: { cookies: [{ httpOnly: true, value: 'synthetic-only' }] } })
    if (sent.type !== 'result') throw new Error('Admin export failed')
    const transfer = sent.output as RpcInput<'browser.cookies.receive'>['transfer']
    expect(await operator('browser.cookies.receive', { sessionId: 'session', transfer })).toMatchObject({ type: 'error', error: { code: 'FORBIDDEN' } })
    expect(await admin('browser.cookies.receive', { sessionId: 'session', transfer })).toMatchObject({ type: 'result', output: { domains: [{ domain: 'example.test', count: 1 }] } })
    expect(f.addCookies).toHaveBeenCalledTimes(1)
    for (const source of ['chrome-running', 'chrome-database'] as const) {
      const read = await admin('browser.cookies.preview', { sessionId: 'session', source })
      expect(read).toMatchObject({ type: 'result', output: { ok: true, domains: [{ domain: 'example.test' }] } })
      if (read.type !== 'result') throw new Error('Admin preview failed')
      const importId = (read.output as { importId: string }).importId
      expect(await admin('browser.cookies.apply', { ...selected, importId })).toMatchObject({ type: 'result', output: { domains: [{ domain: 'example.test' }] } })
    }
    const read = await f.connect(['session:read'])
    expect(await read('browser.cookies.audit', { sessionId: 'session' })).toMatchObject({ type: 'result', output: { domains: [{ domain: 'example.test' }] } })
    expect(await operator('browser.cookies.forget', { sessionId: 'session', domain: 'example.test' })).toMatchObject({ type: 'result', output: { domains: [] } })
    expect(f.clearCookies).toHaveBeenCalledTimes(1)
  })
  it('releases only the device/session owned preview and cancels idempotently', async () => {
    const f = await fixture(), admin = await f.connect(['settings:admin']), operator = await f.connect(['session:operate'])
    const preview = await f.cookies.preview(principal.deviceSessionId, 'session', 'chrome-running')
    if (!preview.ok) throw new Error('Synthetic preview failed')
    const input = { sessionId: 'session', importId: preview.importId }
    const other: Principal = { ...principal, deviceSessionId: 'other-device' }
    const rpc = createBrowserEngineRpc(f.engine, f.cookies)
    await expect(rpc.execute(other, 'browser.cookies.cancel', input)).rejects.toMatchObject({ detail: { code: 'import-expired' } })
    expect(await operator('browser.cookies.cancel', input)).toMatchObject({ type: 'error', error: { code: 'FORBIDDEN' } })
    expect(await admin('browser.cookies.cancel', input)).toMatchObject({ type: 'result', output: {} })
    expect(await admin('browser.cookies.cancel', input)).toMatchObject({ type: 'result', output: {} })
    expect(() => f.cookies.prepareSend(principal.deviceSessionId, 'session', preview.importId, ['example.test'])).toThrow(/expired/)
  })
})
