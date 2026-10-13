/** Real Playwright proof, with fresh owned profiles only. Failure modes:
 * foreign iframe blocks control; page input is lost; frames outrun ack; another
 * session can drive the tab; cancelled locator acts later; cookies do not survive
 * restart; headless install disables sandbox; native CDP opens a TCP port; presenting or hiding leaves a stale native view in a shown window. */
import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { launchFleet, controlEnvironment, sanitizedEnvironment, type BootstrapSession } from './launch.js'
import { seedUiEnvironment } from './fixtures/ui-fleet.js'
import { openFixtureRpc, until } from './fixtures/rpc-client.js'
import type { BrowserEngineSnapshot } from '@forge/protocol'
import { randomUUID, createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserEngine } from '../../apps/backend/src/swarm/browser-automation/browser-engine.js'

test('Stop fences agent open during context creation, page creation and publication', async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-browser-stop-open-'))
  let requests = 0
  const server = createServer((_request, response) => { requests++; response.end('<title>Must not navigate</title>') })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const report: string[] = []
  try {
    for (const phase of ['context', 'page', 'published'] as const) {
      const engine = new BrowserEngine({ dataDir: join(root, phase), browserCacheDir: join(process.cwd(), '.internal/browser-engine/runtime'), resolveSession: () => 'project' })
      let release!: () => void, entered!: () => void
      const pause = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
      const original = engine.headless.context.bind(engine.headless)
      engine.headless.context = async project => {
        if (phase === 'context') { entered(); await pause }
        const context = await original(project)
        if (phase === 'page') {
          const newPage = context.newPage.bind(context)
          context.newPage = async () => { entered(); await pause; return newPage() }
        }
        return context
      }
      const unwatch = engine.watch('session', snapshot => { if (phase === 'published' && snapshot.tabs.length) engine.cancelSession('session') })
      try {
        const opening = engine.invoke('session', 'project', 'open', { url, show: false, reuseExistingTab: false })
        if (phase !== 'published') { await ready; engine.cancelSession('session'); release() }
        const result = await opening
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.code).toBe('request-cancelled')
        expect((await engine.getSnapshot('session')).tabs).toHaveLength(0)
        expect((await original('project')).pages()).toHaveLength(0)
        expect(requests).toBe(0); report.push(phase)
      } finally { unwatch(); release(); await engine.shutdown() }
    }
  } finally { server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }) }
  await mkdir(info.outputDir, { recursive: true }); await writeFile(join(info.outputDir, 'stop-open-proof.json'), JSON.stringify({ passed: true, cancelled: report, abandonedPagesDisposed: true, navigationRequests: requests }, null, 2))
})

test('desktop smoke refuses real-home storage and escaping symlinks before launch', async ({}, info) => {
  const require = createRequire(import.meta.url)
  const { assertDesktopSmokeIsolation } = require('./fixtures/desktop-smoke-isolation.cjs') as { assertDesktopSmokeIsolation(input: { root: string; env: NodeJS.ProcessEnv; cacheRoot: string }, realHome?: string): void }
  const { homedir } = await import('node:os')
  const { symlink, readFile } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'forge-desktop-isolation-proof-'))
  const owned = join(root, 'fleet'), cacheRoot = join(root, 'cache'), fakeHome = join(root, 'real-home')
  await mkdir(owned); await mkdir(cacheRoot); await mkdir(join(fakeHome, '.forge', 'cli'), { recursive: true })
  const hint = join(fakeHome, '.forge', 'cli', 'install-hint'); await writeFile(hint, 'untouched synthetic hint')
  const env = { FORGE_E2E_DESKTOP_HOME: join(owned, 'home'), FORGE_ELECTRON_USER_DATA_DIR: join(owned, 'electron'), FORGE_DATA_DIR: join(owned, 'data'), FORGE_INSTALLATION_STATE_DIR: join(owned, 'installation'), FORGE_BROWSER_CACHE_DIR: cacheRoot }
  try {
    expect(() => assertDesktopSmokeIsolation({ root: owned, env, cacheRoot })).not.toThrow()
    for (const name of ['FORGE_DATA_DIR', 'FORGE_INSTALLATION_STATE_DIR', 'FORGE_ELECTRON_USER_DATA_DIR', 'FORGE_BROWSER_CACHE_DIR']) {
      expect(() => assertDesktopSmokeIsolation({ root: owned, env: { ...env, [name]: join(homedir(), '.forge', 'smoke') }, cacheRoot })).toThrow('real Forge data')
    }
    expect(() => assertDesktopSmokeIsolation({ root: owned, env: { ...env, FORGE_E2E_DESKTOP_HOME: homedir() }, cacheRoot })).toThrow('real Forge data')
    expect(() => assertDesktopSmokeIsolation({ root: owned, env: { ...env, FORGE_DATA_DIR: join(root, 'unowned') }, cacheRoot })).toThrow('owned')
    expect(() => assertDesktopSmokeIsolation({ root: owned, env: { ...env, FORGE_INSTALLATION_STATE_DIR: undefined }, cacheRoot })).toThrow('absolute')
    await symlink(fakeHome, join(owned, 'escape'), 'dir')
    expect(() => assertDesktopSmokeIsolation({ root: owned, env: { ...env, FORGE_E2E_DESKTOP_HOME: join(owned, 'escape') }, cacheRoot }, fakeHome)).toThrow('owned')
    expect(await readFile(hint, 'utf8')).toBe('untouched synthetic hint')
    await mkdir(info.outputDir, { recursive: true }); await writeFile(join(info.outputDir, 'desktop-isolation-proof.json'), JSON.stringify({ passed: true, prelaunch: true, realHomeRejectedWithoutReading: true, storagePathsChecked: true, escapingSymlinkRejected: true, missingPathsRejected: true, syntheticHintUntouched: true }, null, 2))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('headless engine drives fixtures, acknowledged screencast and persistent profile', async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-browser-proof-'))
  const server = createServer((_request, response) => response.end(`<!doctype html><title>Browser proof</title><h1>Real engine</h1><input aria-label="Email"><button onclick="document.querySelector('output').textContent='clicked'">Sign in</button><output>waiting</output><iframe title="foreign-extension-like" srcdoc="<input value='autofill'>"></iframe><style>body{height:2000px}</style>`))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}`
  const create = () => new BrowserEngine({ dataDir: root, resolveSession: id => ['session', 'other'].includes(id) ? 'project' : undefined, browserCacheDir: join(process.cwd(), '.internal/browser-engine/runtime') })
  let engine = create()
  const report: Record<string, unknown> = { platform: process.platform, passed: false }
  try {
    const createFrames: Array<{ frameId: number }> = []
    let earlyCast: Promise<Awaited<ReturnType<BrowserEngine['screencast']>>> | undefined
    const unwatch = engine.watch('session', snapshot => { const created = snapshot.tabs[0]; if (created && !earlyCast) earlyCast = engine.screencast('session', created.tabId, {}, item => { if (item.kind === 'frame') createFrames.push(item) }) })
    const opened = await engine.open('session', { url }); unwatch()
    const createdCast = await earlyCast!; await expect.poll(() => createFrames.length).toBeGreaterThan(0); await createdCast.release()
    const openedTab = opened.activeTabId!
    for (let iteration = 0; iteration < 3; iteration++) {
      const seen: number[] = []; const leaving = await engine.screencast('session', openedTab, {}, () => {})
      const releasing = leaving.release()
      const joining = await engine.screencast('session', openedTab, {}, item => { if (item.kind === 'frame') seen.push(item.frameId) })
      await releasing; await expect.poll(() => seen.length).toBeGreaterThan(0); await joining.release()
    }
 const tabId = opened.activeTabId!
    expect(opened.tabs[0]!.host).toBe('headless')
    expect((await engine.invoke('session', 'project', 'status', {})).ok).toBe(true)
    const missingTab = await engine.invoke('session', 'project', 'open', { tabId: 'missing-tab', reuseExistingTab: true, show: false }); expect(missingTab.ok).toBe(false); expect((await engine.getSnapshot('session')).tabs).toHaveLength(1)
    expect((await engine.invoke('session', 'project', 'navigate', { tabId, url, readiness: 'domContentLoaded', timeoutMs: 15000 })).ok).toBe(true)
    expect((await engine.invoke('session', 'project', 'resize', { tabId, mode: 'freeform', width: 800, height: 600, timeoutMs: 15000 })).ok).toBe(true)
    const type = await engine.invoke('session', 'project', 'type', { tabId, locator: 'label=Email', text: 'proof@example.test', clear: true, timeoutMs: 15000 }); expect(type.ok).toBe(true)
    const click = await engine.invoke('session', 'project', 'click', { tabId, locator: 'role=button[name="Sign in"]', timeoutMs: 15000 }); expect(click.ok).toBe(true)
    const evaluate = await engine.invoke('session', 'project', 'evaluate', { tabId, expression: '({ email: document.querySelector("input").value, output: document.querySelector("output").textContent, frames: document.querySelectorAll("iframe").length })', awaitPromise: true, returnByValue: true });
    expect(evaluate.ok && evaluate.result.value).toEqual({ email: 'proof@example.test', output: 'clicked', frames: 1 })
    expect((await engine.invoke('session', 'project', 'press', { tabId, key: 'Tab' })).ok).toBe(true)
    expect((await engine.invoke('session', 'project', 'scroll', { tabId, deltaY: 200 })).ok).toBe(true)
    expect((await engine.invoke('session', 'project', 'waitFor', { tabId, selector: 'output', text: 'clicked', urlIncludes: '127.0.0.1', timeoutMs: 15000 })).ok).toBe(true)
    const snapshot = await engine.invoke('session', 'project', 'snapshot', { tabId }); expect(snapshot.ok).toBe(true)
    if (snapshot.ok) { await info.attach('snapshot', { body: Buffer.from(snapshot.result.screenshot.data, 'base64'), contentType: 'image/png' }); expect(snapshot.result.visibleText).toContain('clicked'); expect(snapshot.result.interactiveElements.some(element => element.name === 'Sign in')).toBe(true) }
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
    const recording = await engine.invoke('session', 'project', 'recordingStart', { tabId }); expect(recording.ok).toBe(true)
    await engine.input('session', tabId, { kind: 'wheel', x: 40, y: 80, deltaX: 0, deltaY: -300 })
    await new Promise(resolve => setTimeout(resolve, 400))
    const saved = await engine.invoke('session', 'project', 'recordingStop', { tabId }); expect(saved.ok).toBe(true)
    if (saved.ok) { const video = await import('node:fs/promises').then(fs => fs.readFile(saved.result.path)); expect(video.subarray(0, 4).toString('hex')).toBe('1a45dfa3'); await info.attach('recording', { body: video, contentType: saved.result.mimeType }) }
    const pending = engine.invoke('session', 'project', 'click', { tabId, selector: '#late', timeoutMs: 10000 })
    await expect.poll(async () => (await engine.getSnapshot('session')).tabs[0]!.agentAction).toBeTruthy()
    await engine.input('session', tabId, { kind: 'text', text: 'human' }); const cancelled = await pending
    expect(cancelled.ok).toBe(false)
    const pendingEvaluation = engine.invoke('session', 'project', 'evaluate', { tabId, expression: 'new Promise(() => {})', awaitPromise: true, returnByValue: true })
    await expect.poll(async () => (await engine.getSnapshot('session')).tabs[0]!.agentAction).toBe('Evaluating page JavaScript')
    await engine.input('session', tabId, { kind: 'text', text: 'interrupt' })
    const evaluationCancelled = await Promise.race([pendingEvaluation, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Evaluation did not cancel.')), 5000); timer.unref() })]); expect(evaluationCancelled.ok).toBe(false)
    await engine.invoke('session', 'project', 'evaluate', { tabId, expression: 'document.cookie="fixture=persisted;Max-Age=3600;path=/"', awaitPromise: true, returnByValue: true })
    await engine.shutdown(); engine = create()
    const restored = await engine.getSnapshot('session'); expect(restored.tabs[0]!.tabId).toBe(tabId)
    const cookie = await engine.invoke('session', 'project', 'evaluate', { tabId, expression: 'document.cookie', awaitPromise: true, returnByValue: true }); expect(cookie.ok && cookie.result.value).toContain('fixture=persisted')
    expect(engine.setupState().browserEngineState).toBe('ready')
    await engine.archiveSession('project', 'session'); await engine.restoreSession('project', 'session')
    expect((await engine.getSnapshot('session')).tabs[0]!.tabId).toBe(tabId)
    report.passed = true; report.allThirteenTools = true; report.archiveRestore = true; report.foreignIframe = true; report.screencastInputRoundTrip = true; report.independentViewers = true; report.subscribeOnCreate = true; report.subscribeDuringRelease = true; report.cancelledAction = true; report.restartPersistence = true
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
    const existingPartition = `persist:forge-browser-${createHash('sha256').update('project').digest('hex').slice(0, 20)}`
    await application.evaluate(async ({ session }, partition) => { await session.fromPartition(partition).cookies.set({ url: 'https://native.example.test', name: 'legacy-fixture', value: 'synthetic-project-login', expirationDate: Date.now() / 1000 + 3600 }) }, existingPartition)
    const opened = await call('open', { url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }); const tabId = opened.activeTabId
    expect(opened.tabs[0].host).toBe('desktop'); expect(await call('cast-proof', { tabId })).toMatchObject({ width: 1280, height: 800 }); await application.evaluate((_electron, id) => (globalThis as any).forgeBrowserFixture.present(id), tabId)
    expect((await call('tool', { operation: 'type', input: { tabId, locator: 'label=Email', text: 'native@example.test', clear: true, timeoutMs: 15000 } })).ok).toBe(true)
    expect((await call('tool', { operation: 'click', input: { tabId, locator: 'role=button[name="Sign in"]', timeoutMs: 15000 } })).ok).toBe(true)
    const evaluated = await call('tool', { operation: 'evaluate', input: { tabId, expression: '({email:document.querySelector("input").value,output:document.querySelector("output").textContent,frames:document.querySelectorAll("iframe").length})', awaitPromise: true, returnByValue: true } })
    expect(evaluated.result.value).toEqual({ email: 'native@example.test', output: 'clicked', frames: 1 })
    const snapshot = await call('tool', { operation: 'snapshot', input: { tabId } }); expect(snapshot.ok).toBe(true)
    await info.attach('native-snapshot', { body: Buffer.from(snapshot.result.screenshot.data, 'base64'), contentType: 'image/png' })
    const bounds = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.map(view => view.getBounds()))
    const beforeResize = await bounds()
    expect(beforeResize).toEqual([{ x: 10, y: 70, width: 1280, height: 800 }])
    const windowPage = await application.firstWindow()
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.showInactive())
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true)
    await info.attach('shown-window-presented', { body: await windowPage.screenshot(), contentType: 'image/png' })
    await application.evaluate(() => (globalThis as any).forgeBrowserFixture.hide())
    expect(await bounds()).toEqual([])
    await info.attach('shown-window-hidden', { body: await windowPage.screenshot(), contentType: 'image/png' })
    await application.evaluate((_electron, id) => (globalThis as any).forgeBrowserFixture.present(id), tabId)
    expect(await bounds()).toEqual(beforeResize)
    expect((await call('tool', { operation: 'resize', input: { tabId, mode: 'freeform', width: 800, height: 600, timeoutMs: 15000 } })).ok).toBe(true)
    expect(await bounds()).toEqual(beforeResize)
    await (await application.firstWindow()).reload()
    expect((await bounds()).length).toBe(beforeResize.length - 1)
    const hiddenFrame = await call('cast-proof', { tabId }); expect(hiddenFrame.width / hiddenFrame.height).toBeCloseTo(800 / 600)
    const viewportProof = await call('tool', { operation: 'evaluate', input: { tabId, expression: '({width:innerWidth,height:innerHeight})', awaitPromise: true, returnByValue: true } }); expect(viewportProof.result.value).toEqual({ width: 800, height: 600 })
    const nativeCookies = await call('cookie-proof', {}); expect(nativeCookies).toContain('native-fixture'); expect(nativeCookies).toContain('legacy-fixture'); expect(await call('cookie-isolation-proof', {})).not.toContain('native-fixture')
    const mediaPermission = await call('tool', { operation: 'evaluate', input: { tabId, expression: 'navigator.permissions.query({name:"camera"}).then(permission => permission.state)', awaitPromise: true, returnByValue: true } }); expect(mediaPermission.result.value).toBe('denied')
    if (process.platform === 'darwin') {
      const pid = await application.evaluate(() => (globalThis as any).forgeBrowserFixture.backendPid)
      const listeners = await promisify(execFile)('lsof', ['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN']).then(value => value.stdout, error => { if (error.code === 1) return ''; throw error })
      expect(listeners).toBe('')
    }
    await call('shutdown', {})
    await mkdir(info.outputDir, { recursive: true }); await writeFile(join(info.outputDir, 'native-browser-proof.json'), JSON.stringify({ passed: true, platform: process.platform, host: 'WebContentsView', shownWindowPresentHide: true, presentBounds: beforeResize[0], existingProjectLoginPreserved: true, mediaPermissionDenied: true, keychain: 'mocked in isolated fixture', privateTransport: 'fork IPC and ws+unix', foreignIframe: true, operations: ['open', 'snapshot', 'click', 'type', 'evaluate'] }, null, 2))
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
      const latestA = await until<BrowserEngineSnapshot | undefined>(() => rpc.frames.filter(frame => frame.subscriptionId === listA.subscriptionId && frame.item?.snapshot?.tabs.length === 2).at(-1)?.item.snapshot, Boolean)
      const latestB = await until<BrowserEngineSnapshot | undefined>(() => second.frames.filter(frame => frame.subscriptionId === listB.subscriptionId && frame.item?.snapshot?.tabs.length === 2).at(-1)?.item.snapshot, Boolean)
      expect(latestA!.tabs.map((tab: { tabId: string }) => tab.tabId)).toEqual(latestB!.tabs.map((tab: { tabId: string }) => tab.tabId))
      report[environment.name] = { tools: true, independentAck: true, subscriberIsolation: true, consistentTabs: true }
    }
    report.passed = true
  } finally { for (const socket of sockets) socket.close(); server.closeAllConnections(); server.close(); await fleet.stop(!report.passed); await mkdir(info.outputDir, { recursive: true }); await writeFile(join(info.outputDir, 'fleet-browser-proof.json'), JSON.stringify(report, null, 2)) }
})


test('cookie imports stage site counts, read real CDP and decrypt only an owned fixture database', async ({}, info) => {
  const { DatabaseSync } = await import('node:sqlite')
  const { createCipheriv, createHash, pbkdf2Sync } = await import('node:crypto')
  const { readFile } = await import('node:fs/promises')
  const { spawn } = await import('node:child_process')
  const { chromium } = await import('@playwright/test')
  const { readChromeDatabase, readRunningChrome, ChromeCookieReadError } = await import('../../apps/backend/src/swarm/browser-automation/chrome-cookies.js')
  const { BrowserCookieImport } = await import('../../apps/backend/src/swarm/browser-automation/browser-cookie-import.js')
  const { getBrowserCookieAuditPath } = await import('../../apps/backend/src/swarm/storage/data-paths.js')
  const root = await mkdtemp(join(tmpdir(), 'forge-cookie-proof-'))
  const engine = new BrowserEngine({ dataDir: join(root, 'target'), resolveSession: id => id === 'session' ? 'project' : undefined, browserCacheDir: join(process.cwd(), '.internal/browser-engine/runtime') })
  const chromeRoot = join(root, 'source-chrome'); await mkdir(join(chromeRoot, 'Default'), { recursive: true })
  const database = new DatabaseSync(join(chromeRoot, 'Default', 'Cookies'))
  database.exec("CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('version','24'); CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,expires_utc REAL,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,last_access_utc REAL,creation_utc REAL,top_frame_site_key TEXT,has_cross_site_ancestor INTEGER)")
  const createdAt = Date.now() / 1000 - 100, lastUsed = Date.now() / 1000 - 10
  const key = pbkdf2Sync('synthetic-cookie-proof', 'saltysalt', 1003, 16, 'sha1')
  for (const [domain, name, value] of [['.alpha.example.test', 'fixture-a', 'synthetic-a'], ['.beta.example.test', 'fixture-b', 'synthetic-b'], ['.other.test', 'fixture-c', 'synthetic-c']]) {
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20)); const encrypted = Buffer.concat([Buffer.from('v10'), cipher.update(Buffer.concat([createHash('sha256').update(domain!).digest(), Buffer.from(value!)])), cipher.final()])
    database.prepare('INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(domain!, name!, '', encrypted, '/', (Date.now() / 1000 + 3600 + 11644473600) * 1000000, name === 'fixture-b' ? 1 : 0, 1, 1, (lastUsed + 11644473600) * 1000000, (createdAt + 11644473600) * 1000000, name === 'fixture-b' ? 'https://partition.test' : '', 1)
  }
  database.close()
  let shell: ReturnType<typeof spawn> | undefined
  try {
    // A worker can outlive a fleet whose teardown removed its environment markers.
    // Cookie isolation must be a process invariant, including when no E2E config ran.
    const markerNames = ['FORGE_E2E', 'FORGE_E2E_CHECKOUT', 'FORGE_E2E_MANIFEST', 'FORGE_E2E_RUN_ID', 'FORGE_BROWSER_FIXTURE_REPO', 'VITEST', 'FORGE_BROWSER_TEST_CHROME_PROFILE']
    const savedMarkers = markerNames.map(name => [name, process.env[name]] as const)
    for (const name of markerNames) delete process.env[name]
    try {
      await expect(readRunningChrome()).rejects.toThrow('explicit isolated test profile')
      await expect(readChromeDatabase()).rejects.toThrow('explicit isolated test profile')
      await expect(readChromeDatabase({ userDataDir: chromeRoot, platform: 'darwin' })).rejects.toThrow('Native Keychain and secret-service reads are disabled')
    } finally {
      for (const [name, value] of savedMarkers) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    }
    const decoded = await readChromeDatabase({ userDataDir: chromeRoot, platform: 'darwin', passphrase: async () => 'synthetic-cookie-proof' }); expect(decoded).toHaveLength(3)
    expect(decoded[0]!.lastUsedAt).toBeTruthy(); expect(decoded.find(cookie => cookie.name === 'fixture-b')!.partitionKey).toBe('https://partition.test')
    await expect(readChromeDatabase({ userDataDir: chromeRoot, platform: 'win32' })).rejects.toBeInstanceOf(ChromeCookieReadError)
    const importer = new BrowserCookieImport({ engine, dataDir: join(root, 'target'), database: async () => decoded })
    const preview = await importer.preview('device-a', 'session', 'chrome-database'); expect(preview.ok).toBe(true)
    if (!preview.ok) throw new Error('Fixture preview failed')
    expect(preview.domains).toHaveLength(2); expect(JSON.stringify(preview)).not.toContain('synthetic-a'); expect(preview.domains.every(domain => !!domain.lastUsedAt)).toBe(true)
    await expect(importer.apply('device-b', 'session', preview.importId, ['example.test'])).rejects.toThrow('another device')
    const applied = await importer.apply('device-a', 'session', preview.importId, ['example.test']); expect(applied.domains[0]?.count).toBe(2)
    await engine.withCookieContext('session', async context => { const cookies = await context.cookies(); expect(cookies.map(cookie => cookie.name).sort()).toEqual(['fixture-a', 'fixture-b']); expect(cookies.find(cookie => cookie.name === 'fixture-b')!.partitionKey).toBe('https://partition.test') })
    expect(await readFile(getBrowserCookieAuditPath(join(root, 'target'), 'project'), 'utf8')).not.toContain('synthetic-a')
    const prepared = await importer.preview('device-a', 'session', 'chrome-database'); if (!prepared.ok) throw new Error('Fixture preview failed')
    const transfer = importer.prepareSend('device-a', 'session', prepared.importId, ['other.test']); expect(transfer.cookies).toHaveLength(1)
    await importer.receive('session', transfer); await expect(importer.receive('session', transfer)).rejects.toThrow('already received')
    await importer.forget('session', 'example.test'); await engine.withCookieContext('session', async context => expect((await context.cookies()).map(cookie => cookie.name)).toEqual(['fixture-c']))
    const executable = await engine.headless.ensureExecutable(), sourceRoot = join(root, 'running-source')
    shell = spawn(executable, ['--headless', '--use-mock-keychain', '--password-store=basic', '--remote-debugging-port=0', `--user-data-dir=${sourceRoot}`, 'about:blank'], { stdio: 'ignore', env: sanitizedEnvironment() })
    const portFile = await until(() => readFile(join(sourceRoot, 'DevToolsActivePort'), 'utf8').catch(() => ''), Boolean)
    const [port, path] = portFile.trim().split(/\r?\n/); const source = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${path}`)
    await (await source.newBrowserCDPSession()).send('Storage.setCookies', { cookies: [{ name: 'running-fixture', value: 'synthetic-source', domain: 'running.example.test', path: '/', secure: true, httpOnly: true, partitionKey: { topLevelSite: 'https://partition.test', hasCrossSiteAncestor: true }, expires: Date.now() / 1000 + 3600 }] }); await source.close()
    const running = await readRunningChrome(sourceRoot); expect(running.map(cookie => cookie.name)).toContain('running-fixture'); expect(running.find(cookie => cookie.name === 'running-fixture')!.partitionKey).toBe('https://partition.test')
    await expect(readRunningChrome(join(root, 'missing-source'))).rejects.toBeInstanceOf(ChromeCookieReadError)
    await mkdir(info.outputDir, { recursive: true }); await writeFile(join(info.outputDir, 'cookie-proof.json'), JSON.stringify({ passed: true, sourceA: 'real Chrome headless-shell CDP using DevToolsActivePort', sourceB: 'real encrypted throwaway SQLite database with fixture key provider', domainSelection: true, noValuesInPreviewOrAudit: true, oneTimeTransfer: true, forgetSite: true, windowsFallbackRejected: true, guardSurvivesFleetTeardown: true, nativeKeysDisabledWithoutEnvMarkers: true, keychainPrompt: 'not exercised; no user keychain access' }, null, 2))
  } finally { shell?.kill(); await engine.shutdown(); await rm(root, { recursive: true, force: true }) }
})
