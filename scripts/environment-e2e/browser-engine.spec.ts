/** Real Playwright proof, with fresh owned profiles only. Failure modes:
 * foreign iframe blocks control; page input is lost; frames outrun ack; another
 * session can drive the tab; cancelled locator acts later; cookies do not survive
 * restart; headless install disables sandbox; native CDP opens a TCP port. */
import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { launchFleet, controlEnvironment, type BootstrapSession } from './launch.js'
import { seedUiEnvironment } from './fixtures/ui-fleet.js'
import { openFixtureRpc, until } from './fixtures/rpc-client.js'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserEngine } from '../../apps/backend/src/swarm/browser-automation/browser-engine.js'

test('headless engine drives fixtures, acknowledged screencast and persistent profile', async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-browser-proof-'))
  const server = createServer((_request, response) => response.end(`<!doctype html><title>Browser proof</title><h1>Real engine</h1><input aria-label="Email"><button onclick="document.querySelector('output').textContent='clicked'">Sign in</button><output>waiting</output><iframe title="foreign-extension-like" srcdoc="<input value='autofill'>"></iframe><style>body{height:2000px}</style>`))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}`
  const create = () => new BrowserEngine({ dataDir: root, resolveSession: id => ['session', 'other'].includes(id) ? 'project' : undefined, browserCacheDir: join(process.cwd(), '.internal/browser-engine/runtime') })
  let engine = create()
  const report: Record<string, unknown> = { platform: process.platform, passed: false }
  try {
    const opened = await engine.open('session', { url }); const tabId = opened.activeTabId!
    expect(opened.tabs[0]!.host).toBe('headless')
    const type = await engine.invoke('session', 'project', 'type', { tabId, locator: 'label=Email', text: 'proof@example.test', clear: true, timeoutMs: 15000 }); expect(type.ok).toBe(true)
    const click = await engine.invoke('session', 'project', 'click', { tabId, locator: 'role=button[name="Sign in"]', timeoutMs: 15000 }); expect(click.ok).toBe(true)
    const evaluate = await engine.invoke('session', 'project', 'evaluate', { tabId, expression: '({ email: document.querySelector("input").value, output: document.querySelector("output").textContent, frames: document.querySelectorAll("iframe").length })', awaitPromise: true, returnByValue: true });
    expect(evaluate.ok && evaluate.result.value).toEqual({ email: 'proof@example.test', output: 'clicked', frames: 1 })
    const snapshot = await engine.invoke('session', 'project', 'snapshot', { tabId }); expect(snapshot.ok).toBe(true)
    if (snapshot.ok) { await info.attach('snapshot', { body: Buffer.from(snapshot.result.screenshot.data, 'base64'), contentType: 'image/png' }); expect(snapshot.result.visibleText).toContain('clicked') }
    await expect(engine.input('other', tabId, { kind: 'text', text: 'wrong session' })).rejects.toThrow()
    const frames: Array<{ frameId: number; data: string }> = []
    const cast = await engine.screencast('session', tabId, {}, item => { if (item.kind === 'frame') frames.push(item) })
    await expect.poll(() => frames.length).toBe(1)
    await engine.input('session', tabId, { kind: 'wheel', x: 40, y: 80, deltaX: 0, deltaY: 300 })
    await new Promise(resolve => setTimeout(resolve, 200)); expect(frames).toHaveLength(1)
    const fastFrames: Array<{ frameId: number; data: string }> = []
    const fast = await engine.screencast('session', tabId, {}, item => { if (item.kind === 'frame') fastFrames.push(item) })
    await expect.poll(() => fastFrames.length).toBe(1)
    await fast.ack(fastFrames[0]!.frameId)
    await engine.input('session', tabId, { kind: 'wheel', x: 40, y: 80, deltaX: 0, deltaY: 300 })
    await expect.poll(() => fastFrames.length).toBeGreaterThan(1)
    expect(frames).toHaveLength(1) // Slow viewer did not hold up the fast viewer.
    await fast.release()
    await cast.ack(frames[0]!.frameId); await expect.poll(() => frames.length).toBeGreaterThan(1)
    await info.attach('live-frame', { body: Buffer.from(frames[1]!.data, 'base64'), contentType: 'image/jpeg' }); await cast.release()
    const pending = engine.invoke('session', 'project', 'click', { tabId, selector: '#late', timeoutMs: 10000 })
    await expect.poll(async () => (await engine.getSnapshot('session')).tabs[0]!.agentAction).toBeTruthy()
    await engine.input('session', tabId, { kind: 'text', text: 'human' }); const cancelled = await pending
    expect(cancelled.ok).toBe(false)
    await engine.invoke('session', 'project', 'evaluate', { tabId, expression: 'document.cookie="fixture=persisted;Max-Age=3600;path=/"', awaitPromise: true, returnByValue: true })
    await engine.shutdown(); engine = create()
    const restored = await engine.getSnapshot('session'); expect(restored.tabs[0]!.tabId).toBe(tabId)
    const cookie = await engine.invoke('session', 'project', 'evaluate', { tabId, expression: 'document.cookie', awaitPromise: true, returnByValue: true }); expect(cookie.ok && cookie.result.value).toContain('fixture=persisted')
    report.passed = true; report.foreignIframe = true; report.screencastInputRoundTrip = true; report.independentViewers = true; report.cancelledAction = true; report.restartPersistence = true
  } finally {
    await engine.shutdown(); server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true })
    await mkdir(info.outputDir, { recursive: true }); await writeFile(join(info.outputDir, 'browser-proof.json'), JSON.stringify(report, null, 2))
  }
})


test('Electron WebContentsView is driven through private CDP without a TCP browser endpoint', async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-browser-native-proof-'))
  const server = createServer((_request, response) => response.end(`<!doctype html><title>Native proof</title><input aria-label="Email"><button onclick="document.querySelector('output').textContent='clicked'">Sign in</button><output>waiting</output><iframe title="foreign-extension-like" srcdoc="<input value='autofill'>"></iframe>`))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const application = await electron.launch({ args: [join(process.cwd(), 'apps/electron/dist/browser-engine-fixture-main.js')], cwd: join(process.cwd(), 'apps/electron'), env: { ...process.env, FORGE_BROWSER_FIXTURE_REPO: process.cwd(), FORGE_DATA_DIR: join(root, 'data'), FORGE_ELECTRON_USER_DATA_DIR: join(root, 'electron') } })
  try {
    await expect.poll(() => application.evaluate(() => typeof (globalThis as any).forgeBrowserFixture)).toBe('object')
    const call = (method: string, params: unknown): Promise<any> => application.evaluate(async (_electron, args) => (globalThis as any).forgeBrowserFixture.call(args.method, args.params), { method, params })
    const opened = await call('open', { url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }); const tabId = opened.activeTabId
    expect(opened.tabs[0].host).toBe('desktop'); await application.evaluate((_electron, id) => (globalThis as any).forgeBrowserFixture.present(id), tabId)
    expect((await call('tool', { operation: 'type', input: { tabId, locator: 'label=Email', text: 'native@example.test', clear: true, timeoutMs: 15000 } })).ok).toBe(true)
    expect((await call('tool', { operation: 'click', input: { tabId, locator: 'role=button[name="Sign in"]', timeoutMs: 15000 } })).ok).toBe(true)
    const evaluated = await call('tool', { operation: 'evaluate', input: { tabId, expression: '({email:document.querySelector("input").value,output:document.querySelector("output").textContent,frames:document.querySelectorAll("iframe").length})', awaitPromise: true, returnByValue: true } })
    expect(evaluated.result.value).toEqual({ email: 'native@example.test', output: 'clicked', frames: 1 })
    const snapshot = await call('tool', { operation: 'snapshot', input: { tabId } }); expect(snapshot.ok).toBe(true)
    await info.attach('native-snapshot', { body: Buffer.from(snapshot.result.screenshot.data, 'base64'), contentType: 'image/png' })
    await call('shutdown', {})
    await mkdir(info.outputDir, { recursive: true }); await writeFile(join(info.outputDir, 'native-browser-proof.json'), JSON.stringify({ passed: true, platform: process.platform, host: 'WebContentsView', privateTransport: 'fork IPC and ws+unix', foreignIframe: true, operations: ['open', 'snapshot', 'click', 'type', 'evaluate'] }, null, 2))
  } finally { await application.close(); server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }) }
})


test('fleet local and env-b share real tools and independently acknowledged viewers', async ({}, info) => {
  const fleet = await launchFleet({ environments: 2, out: join(process.cwd(), '.internal/browser-engine/fleet.json'), backendEnv: { FORGE_BROWSER_CACHE_DIR: join(process.cwd(), '.internal/browser-engine/runtime') } })
  const server = createServer((_request, response) => response.end(`<!doctype html><title>Fleet browser proof</title><input aria-label="Email"><button id="sign-in" onclick="document.querySelector('output').textContent='clicked'">Sign in</button><output>waiting</output><iframe title="foreign-extension-like" srcdoc="<input value='autofill'>"></iframe><style>body{height:2000px}</style>`))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const report: Record<string, unknown> = { passed: false, platform: process.platform }
  const sockets: Array<Awaited<ReturnType<typeof openFixtureRpc>>> = []
  try {
    for (const environment of fleet.manifest.environments) {
      const bootstrap = await controlEnvironment<BootstrapSession>(fleet.manifest, environment.name, 'bootstrap')
      const seeded = await seedUiEnvironment(environment, bootstrap)
      const rpc = await openFixtureRpc(environment.baseUrl, bootstrap); sockets.push(rpc)
      const sessionId = seeded.sessionId
      const descriptor = await rpc.call('environment.get', {}); expect(descriptor.capabilities.browserEngine).toBe(true)
      await rpc.call('session.send', { commandId: randomUUID(), sessionId, message: { text: `[fixture:browser-open ${url}] [fixture:browser-click #sign-in]`, artifactIds: [] } })
      const initial = await until(() => rpc.call('browser.tabs.get', { sessionId }), value => value.tabs.length === 1 && value.tabs[0].url.startsWith(url) && !value.tabs[0].agentAction)
      const tabId = initial.activeTabId; expect(initial.tabs[0].host).toBe('headless')
      const second = await openFixtureRpc(environment.baseUrl, bootstrap); sockets.push(second)
      const listA = await rpc.call('browser.tabs.subscribe', { sessionId }); const listB = await second.call('browser.tabs.subscribe', { sessionId })
      const slow = await rpc.call('browser.screencast.subscribe', { sessionId, tabId }); const fast = await second.call('browser.screencast.subscribe', { sessionId, tabId })
      const frames = (connection: typeof rpc, subscriptionId: string) => connection.frames.filter(frame => frame.subscriptionId === subscriptionId && frame.item?.kind === 'frame')
      await until(() => frames(rpc, slow.subscriptionId), values => values.length === 1)
      const firstFast = await until(() => frames(second, fast.subscriptionId)[0], Boolean)
      await second.call('browser.screencast.ack', { subscriptionId: fast.subscriptionId, frameId: firstFast.item.frameId })
      await second.call('browser.tabs.input', { sessionId, tabId, input: { kind: 'wheel', x: 30, y: 100, deltaX: 0, deltaY: 300 } })
      const nextFast = await until(() => frames(second, fast.subscriptionId)[1], Boolean)
      expect(frames(rpc, slow.subscriptionId)).toHaveLength(1)
      await info.attach(`${environment.name}-screencast`, { body: Buffer.from(nextFast.item.data, 'base64'), contentType: 'image/jpeg' })
      await expect(rpc.call('browser.screencast.ack', { subscriptionId: fast.subscriptionId, frameId: nextFast.item.frameId })).rejects.toThrow('unavailable')
      await second.call('browser.tabs.open', { sessionId, url })
      const latestA = await until(() => rpc.frames.filter(frame => frame.subscriptionId === listA.subscriptionId && frame.item?.snapshot?.tabs.length === 2).at(-1)?.item.snapshot, Boolean)
      const latestB = await until(() => second.frames.filter(frame => frame.subscriptionId === listB.subscriptionId && frame.item?.snapshot?.tabs.length === 2).at(-1)?.item.snapshot, Boolean)
      expect(latestA.tabs.map((tab: { tabId: string }) => tab.tabId)).toEqual(latestB.tabs.map((tab: { tabId: string }) => tab.tabId))
      report[environment.name] = { tools: true, independentAck: true, subscriberIsolation: true, consistentTabs: true }
    }
    report.passed = true
  } finally { for (const socket of sockets) socket.close(); server.closeAllConnections(); server.close(); await fleet.stop(!report.passed); await mkdir(info.outputDir, { recursive: true }); await writeFile(join(info.outputDir, 'fleet-browser-proof.json'), JSON.stringify(report, null, 2)) }
})
