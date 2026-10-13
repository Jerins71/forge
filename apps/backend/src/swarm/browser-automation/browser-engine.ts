import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Value } from '@sinclair/typebox/value'
import sharp from 'sharp'
import type { Page, CDPSession, Locator } from 'playwright-core'
import { BROWSER_AUTOMATION_OPERATIONS, BROWSER_HOST_PROTOCOL_VERSION, BROWSER_VIEWPORT_PRESETS, BrowserEngineSnapshotSchema,
  type BrowserEngineTab, type BrowserEngineSnapshot, type BrowserEngineInput, type BrowserScreencastItem, type BrowserAutomationOperation,
  type BrowserAutomationInputByOperation, type BrowserAutomationResultByOperation, type BrowserTabSnapshot, type BrowserSnapshotResult,
  type BrowserConsoleEntry, type BrowserNetworkEntry } from '@forge/protocol'
import type { BrowserAutomationInvocationResult } from './browser-automation-service.js'
import { writeJsonFileAtomic } from '../../utils/atomic-files.js'
import { getSessionBrowserStatePath } from '../storage/data-paths.js'
import { HeadlessBrowser, type BrowserSetupState } from './headless-browser.js'
import { DesktopBrowserChannel } from './desktop-browser-channel.js'
interface LiveTab {
  state: BrowserEngineTab; page: Page; cdp: CDPSession; dispose(): Promise<void>
  action?: AbortController; actionTail: Promise<unknown>; cursorSequence: number
  console: BrowserConsoleEntry[]; network: BrowserNetworkEntry[]; stream?: ScreencastHub
}
interface Session { snapshot: BrowserEngineSnapshot; tabs: Map<string, LiveTab>; write: Promise<void> }
interface Viewer { send(item: BrowserScreencastItem): void; pending?: number; last: number }
class ScreencastHub {
  private readonly viewers = new Set<Viewer>()
  private latest?: Extract<BrowserScreencastItem, { kind: 'frame' }>
  private sequence = 0
  private stopped = false
  private readonly onFrame: (frame: { data: string; metadata: { timestamp?: number }; sessionId: number }) => void
  constructor(private readonly tab: LiveTab) {
    this.onFrame = frame => {
      void this.frame(frame).catch(() => {})
      // Chrome has its own small producer budget. Viewers each have an independent
      // one-frame budget; a slow viewer never holds the browser or another viewer.
      const timer = setTimeout(() => { if (!this.stopped) void tab.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {}) }, 100); timer.unref()
    }
    tab.cdp.on('Page.screencastFrame', this.onFrame)
  }
  async start(options: { maxWidth?: number; maxHeight?: number; quality?: number }) {
    await this.tab.cdp.send('Page.startScreencast', { format: 'jpeg', quality: options.quality ?? 75, maxWidth: options.maxWidth ?? 1280, maxHeight: options.maxHeight ?? 1280, everyNthFrame: 1 })
  }
  private async frame(frame: { data: string; metadata: { timestamp?: number } }) {
    if (this.stopped || frame.data.length > 800000) return
    const metadata = await sharp(Buffer.from(frame.data, 'base64')).metadata()
    if (this.stopped || !metadata.width || !metadata.height || metadata.width < 240 || metadata.height < 240) return
    this.latest = { kind: 'frame', tabId: this.tab.state.tabId, frameId: ++this.sequence, data: frame.data, mimeType: 'image/jpeg', width: metadata.width, height: metadata.height, timestamp: frame.metadata.timestamp ?? Date.now() / 1000 }
    for (const viewer of this.viewers) this.deliver(viewer)
  }
  private deliver(viewer: Viewer) { if (!this.latest || viewer.pending !== undefined || this.latest.frameId <= viewer.last) return; viewer.pending = this.latest.frameId; viewer.last = this.latest.frameId; viewer.send(this.latest) }
  attach(send: Viewer['send']) {
    const viewer: Viewer = { send, last: 0 }; this.viewers.add(viewer)
    send({ kind: 'state', tabId: this.tab.state.tabId, state: 'ready' }); this.deliver(viewer)
    return { ack: async (frameId: number) => { if (viewer.pending !== frameId) return; viewer.pending = undefined; this.deliver(viewer) }, release: async () => { this.viewers.delete(viewer); if (!this.viewers.size) { await this.stop(); if (this.tab.stream === this) this.tab.stream = undefined } } }
  }
  async stop() { if (this.stopped) return; this.stopped = true; this.tab.cdp.off('Page.screencastFrame', this.onFrame); for (const viewer of this.viewers) viewer.send({ kind: 'state', tabId: this.tab.state.tabId, state: 'closed' }); this.viewers.clear(); await this.tab.cdp.send('Page.stopScreencast').catch(() => {}) }
}
/** Single owner for session tabs, project profiles, actions and viewer streams. */
export class BrowserEngine {
  private shuttingDown = false
  readonly desktop: DesktopBrowserChannel
  readonly headless: HeadlessBrowser
  private readonly sessions = new Map<string, Promise<Session>>()
  private readonly watchers = new Map<string, Set<(snapshot: BrowserEngineSnapshot) => void>>()
  private readonly options: { dataDir: string; resolveSession(sessionId: string): string | undefined; browserCacheDir?: string; desktop?: DesktopBrowserChannel }
  constructor(options: BrowserEngine['options']) {
    this.options = options; this.desktop = options.desktop ?? new DesktopBrowserChannel()
    this.headless = new HeadlessBrowser({ dataDir: options.dataDir, cacheDir: options.browserCacheDir ?? process.env.FORGE_BROWSER_CACHE_DIR, onSetup: () => { for (const work of this.sessions.values()) void work.then(session => this.publish(session)) } })
    this.desktop.onInput = tabId => { for (const work of this.sessions.values()) void work.then(session => { const tab = session.tabs.get(tabId); if (tab) this.humanInput(session, tab) }) }
    this.desktop.onClosed = tabId => { for (const work of this.sessions.values()) void work.then(session => { const tab = session.tabs.get(tabId); if (tab) { tab.state.errorCode = 'crashed'; tab.state.error = 'Desktop browser page closed.'; this.publish(session) } }) }
  }
  setupState(): BrowserSetupState { return this.desktop.available ? { browserEngineState: 'ready' } : this.headless.state() }
  async setup(): Promise<BrowserSetupState> { if (!this.desktop.available) await this.headless.ensureExecutable().catch(() => {}); return this.setupState() }
  private project(sessionId: string) { const project = this.options.resolveSession(sessionId); if (!project) throw new Error('Browser session is unavailable.'); return project }
  private session(sessionId: string): Promise<Session> {
    const projectId = this.project(sessionId); const current = this.sessions.get(sessionId); if (current) return current
    const work = this.load(sessionId, projectId).catch(error => { this.sessions.delete(sessionId); throw error }); this.sessions.set(sessionId, work); return work
  }
  private async load(sessionId: string, projectId: string): Promise<Session> {
    let restored: BrowserEngineSnapshot | undefined
    try { const stored = JSON.parse(await readFile(getSessionBrowserStatePath(this.options.dataDir, projectId, sessionId), 'utf8')); if (stored.schemaVersion === 3 && Value.Check(BrowserEngineSnapshotSchema, stored.snapshot) && stored.snapshot.sessionId === sessionId && stored.snapshot.projectId === projectId) restored = stored.snapshot }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    const session: Session = { snapshot: { sessionId, projectId, tabs: [], activeTabId: restored?.activeTabId ?? null, revision: restored?.revision ?? 0 }, tabs: new Map(), write: Promise.resolve() }
    for (const previous of restored?.tabs ?? []) {
      const tab = await this.create(session, previous.tabId, previous.viewport); session.tabs.set(previous.tabId, tab)
      try { if (previous.url && previous.url !== 'about:blank') await tab.page.goto(normalizeUrl(previous.url), { waitUntil: 'domcontentloaded', timeout: 15000 }) }
      catch { tab.state.error = 'Saved browser page could not be restored.'; tab.state.errorCode = 'navigation_failed' }
      await this.refresh(tab)
    }
    return session
  }
  private async create(session: Session, tabId: string, viewport: BrowserEngineTab['viewport']): Promise<LiveTab> {
    let page: Page; let dispose: () => Promise<void>
    if (this.desktop.available) { const native = await this.desktop.create(tabId, session.snapshot.projectId, viewport); page = native.page; dispose = native.close }
    else { page = await (await this.headless.context(session.snapshot.projectId)).newPage(); dispose = async () => { await page.close() } }
    await page.setViewportSize(viewport); page.setDefaultTimeout(15000)
    const cdp = await page.context().newCDPSession(page)
    const state: BrowserEngineTab = { tabId, sessionId: session.snapshot.sessionId, projectId: session.snapshot.projectId, host: this.desktop.available ? 'desktop' : 'headless', url: page.url(), title: '', loading: false, canGoBack: false, canGoForward: false, viewport, controller: 'none' }
    const tab: LiveTab = { state, page, cdp, dispose, actionTail: Promise.resolve(), cursorSequence: 0, console: [], network: [] }
    page.on('console', message => { tab.console.push({ level: message.type(), text: message.text().slice(0, 4096), timestamp: new Date().toISOString() }); if (tab.console.length > 200) tab.console.shift() })
    page.on('response', response => { tab.network.push({ url: response.url().slice(0, 2048), method: response.request().method(), status: response.status(), failed: false, timestamp: new Date().toISOString() }); if (tab.network.length > 200) tab.network.shift() })
    page.on('crash', () => { tab.action?.abort(); state.error = 'Browser page crashed. Reload or close this tab.'; state.errorCode = 'crashed'; this.publish(session) })
    page.on('close', () => { if (this.shuttingDown) return; tab.action?.abort(); void tab.stream?.stop(); if (session.tabs.delete(tabId)) { if (session.snapshot.activeTabId === tabId) session.snapshot.activeTabId = session.tabs.keys().next().value ?? null; this.publish(session); void this.persist(session) } })
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) void this.refresh(tab).then(() => { this.publish(session); return this.persist(session) }).catch(() => {}) })
    page.on('domcontentloaded', () => { void this.refresh(tab).then(() => this.publish(session)).catch(() => {}) })
    return tab
  }
  private async refresh(tab: LiveTab) {
    tab.state.url = tab.page.url().slice(0, 8192); tab.state.title = (await tab.page.title().catch(() => '')).slice(0, 4096)
    const history = await tab.cdp.send('Page.getNavigationHistory').catch(() => ({ currentIndex: 0, entries: [] }))
    tab.state.canGoBack = history.currentIndex > 0; tab.state.canGoForward = history.currentIndex < history.entries.length - 1
    const favicon = await tab.page.evaluate("document.querySelector('link[rel~=icon]')?.href || ''").catch(() => '')
    if (typeof favicon === 'string' && /^https?:\/\//i.test(favicon)) tab.state.faviconUrl = favicon.slice(0, 8192); else delete tab.state.faviconUrl
  }
  private snapshot(session: Session): BrowserEngineSnapshot { return { ...session.snapshot, ...this.setupState(), tabs: [...session.tabs.values()].map(tab => structuredClone(tab.state)) } }
  private publish(session: Session) { session.snapshot.revision++; const snapshot = this.snapshot(session); for (const send of this.watchers.get(snapshot.sessionId) ?? []) send(snapshot) }
  private persist(session: Session): Promise<void> {
    const snapshot = this.snapshot(session); snapshot.tabs = snapshot.tabs.map(({ agentAction: _action, agentCursor: _cursor, ...tab }) => ({ ...tab, controller: 'none' }))
    const path = getSessionBrowserStatePath(this.options.dataDir, snapshot.projectId, snapshot.sessionId)
    session.write = session.write.catch(() => {}).then(() => writeJsonFileAtomic(path, { schemaVersion: 3, snapshot }, { mode: 0o600 })); return session.write
  }
  async getSnapshot(sessionId: string) { return this.snapshot(await this.session(sessionId)) }
  watch(sessionId: string, send: (snapshot: BrowserEngineSnapshot) => void): () => void { this.project(sessionId); const watchers = this.watchers.get(sessionId) ?? new Set(); watchers.add(send); this.watchers.set(sessionId, watchers); return () => { watchers.delete(send); if (!watchers.size) this.watchers.delete(sessionId) } }
  async open(sessionId: string, input: { url?: string; activate?: boolean }) {
    const session = await this.session(sessionId); if (session.tabs.size >= 100) throw new Error('This browser session already has 100 tabs.')
    const tabId = randomUUID(); const tab = await this.create(session, tabId, { width: 1280, height: 800 }); session.tabs.set(tabId, tab)
    if (input.activate !== false || !session.snapshot.activeTabId) session.snapshot.activeTabId = tabId
    this.publish(session)
    if (input.url) await this.navigate(sessionId, tabId, { url: input.url }); else await this.persist(session)
    return this.snapshot(session)
  }
  private async tab(sessionId: string, tabId?: string): Promise<{ session: Session; tab: LiveTab }> { const session = await this.session(sessionId); const tab = session.tabs.get(tabId ?? session.snapshot.activeTabId ?? ''); if (!tab) throw new Error('Browser tab does not belong to this session.'); return { session, tab } }
  async activate(sessionId: string, tabId: string) { const { session } = await this.tab(sessionId, tabId); session.snapshot.activeTabId = tabId; this.publish(session); await this.persist(session); return this.snapshot(session) }
  async close(sessionId: string, tabId: string) { const { session, tab } = await this.tab(sessionId, tabId); tab.action?.abort(); await tab.stream?.stop(); session.tabs.delete(tabId); if (session.snapshot.activeTabId === tabId) session.snapshot.activeTabId = session.tabs.keys().next().value ?? null; await tab.dispose(); this.publish(session); await this.persist(session); return this.snapshot(session) }
  async navigate(sessionId: string, tabId: string, input: { url?: string; direction?: 'back' | 'forward' | 'reload' }, signal?: AbortSignal, readiness: 'load' | 'domcontentloaded' | 'commit' = 'domcontentloaded') {
    const { session, tab } = await this.tab(sessionId, tabId); tab.state.loading = true; delete tab.state.error; delete tab.state.errorCode; this.publish(session)
    try { const options = { waitUntil: readiness, timeout: 15000, signal }; if (input.url) await tab.page.goto(normalizeUrl(input.url), options); else if (input.direction === 'back') await tab.page.goBack(options); else if (input.direction === 'forward') await tab.page.goForward(options); else await tab.page.reload(options); await this.refresh(tab) }
    catch (error) { tab.state.error = error instanceof Error ? error.message.slice(0, 1024) : 'Navigation failed.'; tab.state.errorCode = /ERR_CONNECTION|ERR_NAME|ERR_ADDRESS/.test(tab.state.error) ? 'unreachable' : 'navigation_failed'; throw error }
    finally { tab.state.loading = false; this.publish(session); await this.persist(session) }
    return this.snapshot(session)
  }
  async resize(sessionId: string, tabId: string, viewport: BrowserEngineTab['viewport']) { if (viewport.width * viewport.height > 3840 * 2160) throw new Error('Browser viewport exceeds its area budget.'); const { session, tab } = await this.tab(sessionId, tabId); await tab.page.setViewportSize(viewport); if (tab.state.host === 'desktop') this.desktop.resize(tabId, viewport); tab.state.viewport = viewport; this.publish(session); await this.persist(session); return this.snapshot(session) }
  private humanInput(session: Session, tab: LiveTab) { tab.action?.abort(new Error('User input interrupted this browser action.')); tab.state.controller = 'human'; delete tab.state.agentAction; delete tab.state.agentCursor; this.publish(session) }
  async input(sessionId: string, tabId: string, input: BrowserEngineInput) {
    const { session, tab } = await this.tab(sessionId, tabId); this.humanInput(session, tab)
    if (input.kind === 'text') await tab.cdp.send('Input.insertText', { text: input.text })
    else if (input.kind === 'key') { const { kind: _kind, ...params } = input; await tab.cdp.send('Input.dispatchKeyEvent', params) }
    else if (input.kind === 'wheel') { const { kind: _kind, ...params } = input; await tab.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...params }) }
    else { const { kind: _kind, ...params } = input; await tab.cdp.send('Input.dispatchMouseEvent', params) }
  }
  async screencast(sessionId: string, tabId: string, options: { maxWidth?: number; maxHeight?: number; quality?: number }, send: (item: BrowserScreencastItem) => void) {
    const { tab } = await this.tab(sessionId, tabId)
    if (!tab.stream) { const stream = new ScreencastHub(tab); tab.stream = stream; try { await stream.start(options) } catch (error) { tab.stream = undefined; await stream.stop(); throw error } }
    return tab.stream.attach(send)
  }
  async invoke<O extends BrowserAutomationOperation>(sessionId: string, projectId: string, operation: O, input: BrowserAutomationInputByOperation[O]): Promise<BrowserAutomationInvocationResult<O>> {
    try {
      if (this.project(sessionId) !== projectId) throw new Error('Browser profile does not belong to this session.')
      const result = await this.perform(sessionId, operation, input)
      return { ok: true, operation, result: result as BrowserAutomationResultByOperation[O] }
    } catch (error) { return { ok: false, operation, error: { code: error instanceof Error && /interrupt|abort/i.test(error.message) ? 'request-cancelled' : 'execution-failed', message: error instanceof Error ? error.message.slice(0, 1024) : 'Browser operation failed.', retryable: false } } }
  }
  private async perform(sessionId: string, operation: BrowserAutomationOperation, input: BrowserAutomationInputByOperation[BrowserAutomationOperation]): Promise<unknown> {
    if (operation === 'status') { const snapshot = await this.getSnapshot(sessionId); return { available: true, host: { connected: true, hostId: 'playwright', hostGeneration: 1, focused: false, capabilities: { protocolVersions: { minimum: BROWSER_HOST_PROTOCOL_VERSION, maximum: BROWSER_HOST_PROTOCOL_VERSION }, supportedOperations: BROWSER_AUTOMATION_OPERATIONS, maxResponseBytes: 8388608 }, connectedAt: null }, panelVisible: false, panelRevealRequested: false, physicalTabVisible: false, selectedTab: snapshot.tabs.find(tab => tab.tabId === snapshot.activeTabId) ? legacyTab(snapshot.tabs.find(tab => tab.tabId === snapshot.activeTabId)!) : null, eligibleTabs: [], eligibleTabsTruncated: false } }
    if (operation === 'open') { const value = input as BrowserAutomationInputByOperation['open']; const current = await this.getSnapshot(sessionId); const existing = value.tabId ? current.tabs.find(tab => tab.tabId === value.tabId) : value.reuseExistingTab ? current.tabs.find(tab => tab.tabId === current.activeTabId) : undefined; const snapshot = existing ? await this.activate(sessionId, existing.tabId) : await this.open(sessionId, { url: value.url }); if (existing && value.url) await this.navigate(sessionId, existing.tabId, { url: value.url }); return { tab: legacyTab((await this.getSnapshot(sessionId)).tabs.find(tab => tab.tabId === snapshot.activeTabId)!), created: !existing, panelRevealRequested: value.show !== false } }
    const { session, tab } = await this.tab(sessionId, input.tabId)
    const run = async () => {
      const action = new AbortController(); tab.action = action; tab.state.controller = 'agent'; tab.state.agentAction = actionLabel(operation, input); this.publish(session)
      try { const result = await this.action(session, tab, operation, input, action.signal); action.signal.throwIfAborted(); await this.refresh(tab); return result }
      finally { if (tab.action === action) { tab.action = undefined; tab.state.controller = action.signal.aborted ? 'human' : 'none'; delete tab.state.agentAction; delete tab.state.agentCursor; this.publish(session) } }
    }
    const work = tab.actionTail.catch(() => {}).then(run); tab.actionTail = work; return work
  }
  private async point(session: Session, tab: LiveTab, locator: Locator, signal: AbortSignal, click = false) { await locator.waitFor({ state: 'visible', timeout: 15000, signal }); const bounds = await locator.boundingBox(); signal.throwIfAborted(); if (!bounds) throw new Error('The target has no visible bounding box.'); const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }; tab.state.agentCursor = { ...point, phase: click ? 'click' : 'move', sequence: ++tab.cursorSequence }; this.publish(session); return point }
  private async action(session: Session, tab: LiveTab, operation: BrowserAutomationOperation, raw: BrowserAutomationInputByOperation[BrowserAutomationOperation], signal: AbortSignal): Promise<unknown> {
    const tabId = tab.state.tabId; const page = tab.page
    switch (operation) {
      case 'navigate': { const input = raw as BrowserAutomationInputByOperation['navigate']; const url = input.url ?? `${input.environmentProtocol ?? 'http'}://127.0.0.1:${input.environmentPort}${input.path ?? '/'}`; await this.navigate(session.snapshot.sessionId, tabId, { url }, signal, input.readiness === 'none' ? 'commit' : input.readiness === 'domContentLoaded' ? 'domcontentloaded' : 'load'); return { tab: legacyTab(tab.state), readiness: input.readiness } }
      case 'resize': { const input = raw as BrowserAutomationInputByOperation['resize']; const viewport = input.mode === 'freeform' ? { width: input.width, height: input.height } : input.mode === 'preset' ? { ...BROWSER_VIEWPORT_PRESETS[input.presetId] } : { width: 1280, height: 800 }; if (input.mode === 'preset' && input.orientation === 'landscape') [viewport.width, viewport.height] = [viewport.height, viewport.width]; await this.resize(session.snapshot.sessionId, tabId, viewport); return { tabId, setting: { mode: 'freeform', ...viewport }, viewport: { ...viewport, deviceScaleFactor: 1 } } }
      case 'snapshot': return this.capture(tab, signal)
      case 'click': { const input = raw as BrowserAutomationInputByOperation['click']; let point: { x: number; y: number }; if ('x' in input && typeof input.x === 'number' && typeof input.y === 'number') { point = { x: input.x, y: input.y }; tab.state.agentCursor = { ...point, phase: 'click', sequence: ++tab.cursorSequence }; this.publish(session); await page.mouse.click(point.x, point.y) } else { const locator = locate(page, input as { locator?: string; selector?: string }); point = await this.point(session, tab, locator, signal, true); await locator.click({ timeout: input.timeoutMs, signal }) } return { tabId, point } }
      case 'type': { const input = raw as BrowserAutomationInputByOperation['type']; const locator = input.locator || input.selector ? locate(page, input) : page.locator(':focus'); await this.point(session, tab, locator, signal); if (input.clear) await locator.fill(input.text, { timeout: input.timeoutMs, signal }); else await locator.pressSequentially(input.text, { timeout: input.timeoutMs, signal }); return { tabId, characters: input.text.length, cleared: input.clear ?? false } }
      case 'press': { const input = raw as BrowserAutomationInputByOperation['press']; signal.throwIfAborted(); await page.keyboard.press([...(input.modifiers ?? []), input.key].join('+')); return { tabId, key: input.key, modifiers: input.modifiers ?? [] } }
      case 'scroll': { const input = raw as BrowserAutomationInputByOperation['scroll']; const deltaX = input.deltaX ?? 0, deltaY = input.deltaY ?? 0; if (input.locator || input.selector) { const locator = locate(page, input); await this.point(session, tab, locator, signal); await locator.evaluate(`(element) => element.scrollBy(${deltaX}, ${deltaY})`) } else { signal.throwIfAborted(); await page.mouse.wheel(deltaX, deltaY) } const positions = await page.evaluate<{ scrollX: number; scrollY: number }>('({ scrollX, scrollY })'); return { tabId, deltaX, deltaY, ...positions } }
      case 'evaluate': { const input = raw as BrowserAutomationInputByOperation['evaluate']; const terminate = () => { void tab.cdp.send('Runtime.terminateExecution').catch(() => {}) }; signal.addEventListener('abort', terminate, { once: true }); try { const result = await tab.cdp.send('Runtime.evaluate', { expression: input.expression, awaitPromise: input.awaitPromise, returnByValue: input.returnByValue }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); signal.throwIfAborted(); const value = result.result.value; const serializedBytes = Buffer.byteLength(JSON.stringify(value) ?? ''); if (serializedBytes > 65536) throw new Error('Evaluation result exceeds 64 KiB.'); return { tabId, ...(input.returnByValue ? { value } : { remoteObject: result.result }), serializedBytes } } finally { signal.removeEventListener('abort', terminate) } }
      case 'waitFor': { const input = raw as BrowserAutomationInputByOperation['waitFor']; const started = Date.now(); if (input.locator || input.selector) await locate(page, input).waitFor({ state: 'visible', timeout: input.timeoutMs, signal }); if (input.text) await page.getByText(input.text, { exact: false }).first().waitFor({ state: 'visible', timeout: input.timeoutMs, signal }); if (input.urlIncludes) await page.waitForURL(url => url.href.includes(input.urlIncludes!), { timeout: input.timeoutMs, signal }); return { tabId, matched: true, elapsedMs: Date.now() - started } }
      default: throw new Error(`Browser operation ${operation} is not implemented yet.`)
    }
  }
  private async capture(tab: LiveTab, signal: AbortSignal): Promise<BrowserSnapshotResult> {
    const image = await sharp(await tab.page.screenshot({ type: 'png', signal })).resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true })
    const visibleText = await tab.page.locator('body').innerText({ timeout: 15000, signal }).catch(() => '')
    const accessibility = await tab.page.locator('body').ariaSnapshot({ timeout: 15000, signal })
    return { tabId: tab.state.tabId, url: tab.page.url(), title: await tab.page.title(), loading: tab.state.loading, viewportSetting: { mode: 'freeform', ...tab.state.viewport }, viewport: { ...tab.state.viewport, deviceScaleFactor: 1 }, visibleText: visibleText.slice(0, 20000), interactiveElements: [], accessibility: accessibility.slice(0, 64000), consoleEntries: tab.console.slice(), networkEntries: tab.network.slice(), actionTimeline: [], screenshot: { mimeType: 'image/png', data: image.data.toString('base64'), width: image.info.width, height: image.info.height } }
  }
  async shutdown() { this.shuttingDown = true; for (const work of this.sessions.values()) { const session = await work.catch(() => undefined); if (!session) continue; await this.persist(session); for (const tab of session.tabs.values()) { tab.action?.abort(); await tab.stream?.stop(); await tab.dispose().catch(() => {}) } } this.sessions.clear(); await this.headless.shutdown(); await this.desktop.shutdown() }
}
function normalizeUrl(raw: string) { const url = new URL(raw); if (!['http:', 'https:', 'about:'].includes(url.protocol) || url.username || url.password || (url.protocol === 'about:' && url.href !== 'about:blank')) throw new Error('Browser navigation requires HTTP(S) or about:blank, without URL credentials.'); return url.href }
function locate(page: Page, input: { selector?: string; locator?: string }) { if (input.selector) return page.locator(input.selector); const locator = input.locator ?? ':focus'; if (locator.startsWith('label=')) return page.getByLabel(locator.slice(6), { exact: true }); if (locator.startsWith('text=')) return page.getByText(locator.slice(5), { exact: true }); const role = /^role=([\w-]+)(?:\[name=["'](.*)["']\])?$/.exec(locator); if (role) return page.getByRole(role[1] as Parameters<Page['getByRole']>[0], role[2] ? { name: role[2], exact: true } : {}); return page.locator(locator) }
function actionLabel(operation: string, input: object) { const value = input as { locator?: string; selector?: string }; const target = value.locator?.replace(/^(label|text)=/, '').replace(/^role=\w+\[name=["'](.*)["']\]$/, '$1') ?? value.selector; const verb = ({ click: 'Clicking', type: 'Typing into', navigate: 'Navigating', snapshot: 'Inspecting the page', waitFor: 'Waiting for', evaluate: 'Evaluating page JavaScript', scroll: 'Scrolling', press: 'Pressing a key', resize: 'Resizing' } as Record<string, string>)[operation] ?? operation; return `${verb}${target ? ` “${target}”` : ''}`.slice(0, 256) }
function legacyTab(tab: BrowserEngineTab): BrowserTabSnapshot { const now = new Date().toISOString(); return { targetAffinity: 'managed-electron', tabId: tab.tabId, sessionAgentId: tab.sessionId, profileId: tab.projectId, url: tab.url, title: tab.title, lifecycle: tab.error ? 'failed' : tab.loading ? 'loading' : 'ready', loading: tab.loading, live: true, canGoBack: tab.canGoBack, canGoForward: tab.canGoForward, zoomFactor: 1, controller: tab.controller, agentCursor: tab.agentCursor ? { ...tab.agentCursor, createdAt: now } : null, recording: null, viewportSetting: { mode: 'freeform', ...tab.viewport }, renderedViewport: { ...tab.viewport, deviceScaleFactor: 1 }, error: tab.error ? { code: tab.errorCode ?? 'execution-failed', message: tab.error } : null, createdAt: now, updatedAt: now } }
