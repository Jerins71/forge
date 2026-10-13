import { join } from 'node:path'
import { BrowserCookieImport } from './browser-cookie-import.js'
import { BrowserRecording } from './browser-recording.js'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { Value } from '@sinclair/typebox/value'
import sharp from 'sharp'
import type { Page, CDPSession, Locator, BrowserContext } from 'playwright-core'
import { BROWSER_VIEWPORT_PRESETS, BrowserEngineSnapshotSchema,
  type BrowserEngineTab, type BrowserEngineSnapshot, type BrowserEngineInput, type BrowserScreencastItem, type BrowserAutomationOperation,
  type BrowserAutomationInputByOperation, type BrowserAutomationResultByOperation, type BrowserSnapshotResult,
  type BrowserConsoleEntry, type BrowserNetworkEntry } from '@forge/protocol'
import type { BrowserAutomationInvocationResult } from './browser-automation-manager-adapter.js'
import { writeJsonFileAtomic } from '../../utils/atomic-files.js'
import { getSessionBrowserStatePath, getSessionBrowserArtifactsDir } from '../storage/data-paths.js'
import { HeadlessBrowser, HEADLESS_CHROME_VERSION, type BrowserSetupState } from './headless-browser.js'
import { DesktopBrowserChannel } from './desktop-browser-channel.js'
interface LiveTab {
  state: BrowserEngineTab; page: Page; cdp: CDPSession; dispose(): Promise<void>
  closing?: boolean; actionEpoch: number; action?: AbortController; actionTail: Promise<unknown>; cursorSequence: number
  recording?: { recordingId: string; startedAt: string; encoder: BrowserRecording; cast: { release(): Promise<void> }; work: Promise<void>; error?: Error }
  console: BrowserConsoleEntry[]; network: BrowserNetworkEntry[]; stream?: ScreencastHub
}
interface Session { closed?: boolean; snapshot: BrowserEngineSnapshot; tabs: Map<string, LiveTab>; popups: Set<Promise<void>>; write: Promise<void> }
interface Viewer { send(item: BrowserScreencastItem): void; pending?: number; last: number }
class ScreencastHub {
  private readonly viewers = new Set<Viewer>()
  private latest?: Extract<BrowserScreencastItem, { kind: 'frame' }>
  private sequence = 0
  private stopped = false
  private invalidFrame = false
  readonly ready: Promise<void>
  private markReady!: () => void
  private markFailed!: (error: unknown) => void
  private readonly onFrame: (frame: { data: string; metadata: { timestamp?: number }; sessionId: number }) => void
  constructor(private readonly tab: LiveTab) {
    this.ready = new Promise<void>((resolve, reject) => { this.markReady = resolve; this.markFailed = reject }); this.ready.catch(() => {})
    this.onFrame = frame => {
      void this.frame(frame).catch(() => {})
      // Chrome has its own small producer budget. Viewers each have an independent
      // one-frame budget; a slow viewer never holds the browser or another viewer.
      const timer = setTimeout(() => { if (!this.stopped) void tab.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {}) }, 100); timer.unref()
    }
    tab.cdp.on('Page.screencastFrame', this.onFrame)
  }
  async start(options: { maxWidth?: number; maxHeight?: number; quality?: number }) {
    try {
      const deadline = Date.now() + 15000
      while (true) {
        await this.tab.page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, deadline - Date.now()) })
        try { await this.tab.cdp.send('Page.startScreencast', { format: 'jpeg', quality: options.quality ?? 75, maxWidth: options.maxWidth ?? 1280, maxHeight: options.maxHeight ?? 1280, everyNthFrame: 1 }); break }
        catch (error) { if (this.tab.page.isClosed() || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)) }
      }
      this.markReady()
    } catch (error) { this.markFailed(error); throw error }
  }
  private async frame(frame: { data: string; metadata: { timestamp?: number } }) {
    if (this.stopped || frame.data.length > 800000) return
    const metadata = await sharp(Buffer.from(frame.data, 'base64')).metadata()
    if (this.stopped) return
    if (!metadata.width || !metadata.height || metadata.width < 240 || metadata.height < 240) {
      if (!this.invalidFrame) for (const viewer of this.viewers) viewer.send({ kind: 'state', tabId: this.tab.state.tabId, state: 'error', message: 'Browser viewport is too small for live view. Resize it to at least 240 × 240.' })
      this.invalidFrame = true; return
    }
    this.invalidFrame = false
    this.latest = { kind: 'frame', tabId: this.tab.state.tabId, frameId: ++this.sequence, data: frame.data, mimeType: 'image/jpeg', width: metadata.width, height: metadata.height, timestamp: frame.metadata.timestamp ?? Date.now() / 1000 }
    for (const viewer of this.viewers) this.deliver(viewer)
  }
  private deliver(viewer: Viewer) { if (!this.latest || viewer.pending !== undefined || this.latest.frameId <= viewer.last) return; viewer.pending = this.latest.frameId; viewer.last = this.latest.frameId; viewer.send(this.latest) }
  attach(send: Viewer['send']) {
    const viewer: Viewer = { send, last: 0 }; this.viewers.add(viewer)
    send({ kind: 'state', tabId: this.tab.state.tabId, state: this.invalidFrame ? 'error' : 'ready', ...(this.invalidFrame ? { message: 'Browser viewport is too small for live view. Resize it to at least 240 × 240.' } : {}) }); this.deliver(viewer)
    return { ack: async (frameId: number) => { if (viewer.pending !== frameId) return; viewer.pending = undefined; this.deliver(viewer) }, release: async () => { this.viewers.delete(viewer); if (!this.viewers.size) { if (this.tab.stream === this) this.tab.stream = undefined; await this.stop() } } }
  }
  async stop() { if (this.stopped) return; this.stopped = true; this.tab.cdp.off('Page.screencastFrame', this.onFrame); for (const viewer of this.viewers) viewer.send({ kind: 'state', tabId: this.tab.state.tabId, state: 'closed' }); this.viewers.clear(); await this.tab.cdp.send('Page.stopScreencast').catch(() => {}) }
}
/** Single owner for session tabs, project profiles, actions and viewer streams. */
export class BrowserEngine {
  private shuttingDown = false
  readonly cookies: BrowserCookieImport
  readonly version = HEADLESS_CHROME_VERSION
  readonly desktop: DesktopBrowserChannel
  readonly headless: HeadlessBrowser
  private readonly sessions = new Map<string, Promise<Session>>()
  private readonly cancellationGenerations = new Map<string, number>()
  private readonly watchers = new Map<string, Set<(snapshot: BrowserEngineSnapshot) => void>>()
  private readonly options: { dataDir: string; resolveSession(sessionId: string): string | undefined; browserCacheDir?: string; desktop?: DesktopBrowserChannel }
  constructor(options: BrowserEngine['options']) {
    this.cookies = new BrowserCookieImport({ engine: this, dataDir: options.dataDir }); this.options = options; this.desktop = options.desktop ?? new DesktopBrowserChannel()
    this.headless = new HeadlessBrowser({ dataDir: options.dataDir, cacheDir: options.browserCacheDir ?? process.env.FORGE_BROWSER_CACHE_DIR, onSetup: () => { for (const work of this.sessions.values()) void work.then(session => this.publish(session)).catch(() => {}) } })
    this.desktop.onInput = tabId => { for (const work of this.sessions.values()) void work.then(session => { const tab = session.tabs.get(tabId); if (tab) this.humanInput(session, tab) }).catch(() => {}) }
    this.desktop.onPopup = (tabId, openerTabId) => {
      void (async () => {
        for (const work of this.sessions.values()) {
          const session = await work, opener = session.tabs.get(openerTabId)
          if (opener && !session.closed) { this.adoptPopup(session, opener, tabId, async () => { try { const native = await this.desktop.adopt(tabId); return { page: native.page, dispose: native.close } } catch (error) { await this.desktop.discard(tabId).catch(() => {}); throw error } }); return }
        }
        await this.desktop.discard(tabId)
      })().catch(() => this.desktop.discard(tabId).catch(() => {}))
    }
    this.desktop.onClosed = tabId => { for (const work of this.sessions.values()) void work.then(session => { const tab = session.tabs.get(tabId); if (tab) { tab.state.errorCode = 'crashed'; tab.state.error = 'Desktop browser page closed.'; this.publish(session) } }).catch(() => {}) }
  }
  setupState(): BrowserSetupState { return this.desktop.available ? { browserEngineState: 'ready' } : this.headless.state() }
  async setup(): Promise<BrowserSetupState> { if (!this.desktop.available) void this.headless.prepare().catch(() => {}); return this.setupState() }
  projectForSession(sessionId: string) { return this.project(sessionId) }
  private project(sessionId: string) { const project = this.options.resolveSession(sessionId); if (!project) throw new Error('Browser session is unavailable.'); return project }
  private session(sessionId: string): Promise<Session> {
    const projectId = this.project(sessionId); const current = this.sessions.get(sessionId); if (current) return current
    const work = this.load(sessionId, projectId).catch(error => { this.sessions.delete(sessionId); throw error }); this.sessions.set(sessionId, work); return work
  }
  private async load(sessionId: string, projectId: string): Promise<Session> {
    let restored: BrowserEngineSnapshot | undefined
    try { const stored = JSON.parse(await readFile(getSessionBrowserStatePath(this.options.dataDir, projectId, sessionId), 'utf8')); if (stored.schemaVersion === 3 && Value.Check(BrowserEngineSnapshotSchema, stored.snapshot) && stored.snapshot.sessionId === sessionId && stored.snapshot.projectId === projectId) restored = stored.snapshot }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    const session: Session = { snapshot: { sessionId, projectId, tabs: [], activeTabId: restored?.activeTabId ?? null, revision: restored?.revision ?? 0 }, tabs: new Map(), popups: new Set(), write: Promise.resolve() }
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
    else { page = await this.headless.withContext(session.snapshot.projectId, context => context.newPage()); dispose = async () => { await page.close(); await this.headless.retireIdle(session.snapshot.projectId) } }
    try { return await this.attachPage(session, tabId, viewport, page, dispose) }
    catch (error) { await dispose().catch(() => {}); throw error }
  }
  private adoptPopup(session: Session, opener: LiveTab, tabId: string, physical: () => Promise<{ page: Page; dispose(): Promise<void> }>) {
    const work = (async () => {
      const native = await physical()
      try {
        if (session.closed || this.shuttingDown || opener.page.isClosed() || session.tabs.size >= 100) return
        const tab = await this.attachPage(session, tabId, opener.state.viewport, native.page, native.dispose)
        if (session.closed || this.shuttingDown || native.page.isClosed() || opener.page.isClosed() || session.tabs.size >= 100) return
        tab.state.openerTabId = opener.state.tabId; session.tabs.set(tabId, tab); session.snapshot.activeTabId = tabId
        this.publish(session); await this.refresh(tab); await this.persist(session)
      } finally { if (!session.tabs.has(tabId)) await native.dispose().catch(() => {}) }
    })().catch(() => {})
    session.popups.add(work); void work.finally(() => session.popups.delete(work))
  }
  private async attachPage(session: Session, tabId: string, viewport: BrowserEngineTab['viewport'], page: Page, dispose: () => Promise<void>): Promise<LiveTab> {
    await page.setViewportSize(viewport); page.setDefaultTimeout(15000)
    const cdp = await page.context().newCDPSession(page)
    const state: BrowserEngineTab = { tabId, sessionId: session.snapshot.sessionId, projectId: session.snapshot.projectId, host: this.desktop.available ? 'desktop' : 'headless', url: page.url(), title: '', loading: false, canGoBack: false, canGoForward: false, viewport, controller: 'none' }
    const tab: LiveTab = { state, page, cdp, dispose, actionEpoch: 0, actionTail: Promise.resolve(), cursorSequence: 0, console: [], network: [] }
    page.on('popup', popup => { if (!this.desktop.available) this.adoptPopup(session, tab, randomUUID(), async () => ({ page: popup, dispose: async () => { await popup.close(); await this.headless.retireIdle(session.snapshot.projectId) } })) })
    page.on('console', message => { tab.console.push({ level: message.type(), text: message.text().slice(0, 4096), timestamp: new Date().toISOString() }); if (tab.console.length > 200) tab.console.shift() })
    page.on('response', response => { tab.network.push({ url: response.url().slice(0, 2048), method: response.request().method(), status: response.status(), failed: false, timestamp: new Date().toISOString() }); if (tab.network.length > 200) tab.network.shift() })
    page.on('crash', () => { tab.action?.abort(); state.error = 'Browser page crashed. Reload or close this tab.'; state.errorCode = 'crashed'; this.publish(session) })
    page.on('close', () => { if (this.shuttingDown || tab.closing) return; tab.closing = true; void tab.stream?.stop(); void tab.dispose().catch(() => {}); if (session.tabs.delete(tabId)) { if (session.snapshot.activeTabId === tabId) session.snapshot.activeTabId = session.tabs.keys().next().value ?? null; this.publish(session); void this.persist(session) } })
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
    if (session.closed) return Promise.resolve()
    const snapshot = this.snapshot(session); snapshot.tabs = snapshot.tabs.map(({ agentAction: _action, agentCursor: _cursor, ...tab }) => ({ ...tab, controller: 'none' }))
    const path = getSessionBrowserStatePath(this.options.dataDir, snapshot.projectId, snapshot.sessionId)
    session.write = session.write.catch(() => {}).then(() => writeJsonFileAtomic(path, { schemaVersion: 3, snapshot }, { mode: 0o600 })); return session.write
  }
  async withCookieContext<T>(sessionId: string, work: (context: BrowserContext) => Promise<T>): Promise<T> {
    const projectId = this.project(sessionId)
    if (!this.desktop.available) return this.headless.withContext(projectId, work)
    for (const loaded of this.sessions.values()) { const session = await loaded; if (session.snapshot.projectId === projectId) { const tab = [...session.tabs.values()][0]; if (tab && !tab.page.isClosed()) return work(tab.page.context()) } }
    const temporary = await this.desktop.create(randomUUID(), projectId, { width: 1280, height: 800 })
    try { return await work(temporary.page.context()) } finally { await temporary.close() }
  }
  async getSnapshot(sessionId: string) { return this.snapshot(await this.session(sessionId)) }
  watch(sessionId: string, send: (snapshot: BrowserEngineSnapshot) => void): () => void { this.project(sessionId); const watchers = this.watchers.get(sessionId) ?? new Set(); watchers.add(send); this.watchers.set(sessionId, watchers); return () => { watchers.delete(send); if (!watchers.size) this.watchers.delete(sessionId) } }
  private checkOpenGeneration(sessionId: string, generation: number) { if ((this.cancellationGenerations.get(sessionId) ?? 0) !== generation) throw new Error('Browser open aborted because the session was stopped.') }
  async open(sessionId: string, input: { url?: string; activate?: boolean }, generation = this.cancellationGenerations.get(sessionId) ?? 0) {
    const session = await this.session(sessionId); if (session.tabs.size >= 100) throw new Error('This browser session already has 100 tabs.')
    this.checkOpenGeneration(sessionId, generation)
    const tabId = randomUUID(); const tab = await this.create(session, tabId, { width: 1280, height: 800 })
    try { this.checkOpenGeneration(sessionId, generation); if (session.closed || this.project(sessionId) !== session.snapshot.projectId) throw new Error('Browser session was closed during tab creation.') }
    catch (error) { tab.closing = true; await tab.dispose(); throw error }
    session.tabs.set(tabId, tab)
    if (input.activate !== false || !session.snapshot.activeTabId) session.snapshot.activeTabId = tabId
    this.publish(session)
    try { this.checkOpenGeneration(sessionId, generation) } catch (error) { await this.close(sessionId, tabId); throw error }
    if (input.url) await this.navigate(sessionId, tabId, { url: input.url }); else await this.persist(session)
    return this.snapshot(session)
  }
  private async tab(sessionId: string, tabId?: string): Promise<{ session: Session; tab: LiveTab }> { const session = await this.session(sessionId); const tab = session.tabs.get(tabId ?? session.snapshot.activeTabId ?? ''); if (!tab) throw new Error('Browser tab does not belong to this session.'); return { session, tab } }
  async activate(sessionId: string, tabId: string) { const { session } = await this.tab(sessionId, tabId); session.snapshot.activeTabId = tabId; this.publish(session); await this.persist(session); return this.snapshot(session) }
  async close(sessionId: string, tabId: string) { const { session, tab } = await this.tab(sessionId, tabId); tab.closing = true; tab.action?.abort(); if (tab.recording) await this.recordingStop(sessionId, tabId); await tab.stream?.stop(); session.tabs.delete(tabId); if (session.snapshot.activeTabId === tabId) session.snapshot.activeTabId = session.tabs.keys().next().value ?? null; await tab.dispose(); this.publish(session); await this.persist(session); return this.snapshot(session) }
  async navigate(sessionId: string, tabId: string, input: { url?: string; direction?: 'back' | 'forward' | 'reload' }, signal?: AbortSignal, readiness: 'load' | 'domcontentloaded' | 'commit' = 'domcontentloaded') {
    const { session, tab } = await this.tab(sessionId, tabId); if (!signal) this.humanInput(session, tab); tab.state.loading = true; delete tab.state.error; delete tab.state.errorCode; this.publish(session)
    try { const options = { waitUntil: readiness, timeout: 15000, signal }; if (input.url) await tab.page.goto(normalizeUrl(input.url), options); else if (input.direction === 'back') await tab.page.goBack(options); else if (input.direction === 'forward') await tab.page.goForward(options); else await tab.page.reload(options); await this.refresh(tab) }
    catch (error) { tab.state.error = error instanceof Error ? error.message.slice(0, 1024) : 'Navigation failed.'; tab.state.errorCode = /ERR_CONNECTION|ERR_NAME|ERR_ADDRESS/.test(tab.state.error) ? 'unreachable' : 'navigation_failed'; throw error }
    finally { tab.state.loading = false; this.publish(session); await this.persist(session) }
    return this.snapshot(session)
  }
  async resize(sessionId: string, tabId: string, viewport: BrowserEngineTab['viewport']) { if (viewport.width * viewport.height > 3840 * 2160) throw new Error('Browser viewport exceeds its area budget.'); const { session, tab } = await this.tab(sessionId, tabId); await tab.page.setViewportSize(viewport); tab.state.viewport = viewport; this.publish(session); await this.persist(session); return this.snapshot(session) }
  private humanInput(session: Session, tab: LiveTab) { tab.actionEpoch++; tab.action?.abort(new Error('User input interrupted this browser action.')); tab.state.controller = 'human'; delete tab.state.agentAction; delete tab.state.agentCursor; this.publish(session) }
  async input(sessionId: string, tabId: string, input: BrowserEngineInput) {
    const { session, tab } = await this.tab(sessionId, tabId); this.humanInput(session, tab)
    if (input.kind === 'text') await tab.cdp.send('Input.insertText', { text: input.text })
    else if (input.kind === 'key') { const { kind: _kind, ...params } = input; await tab.cdp.send('Input.dispatchKeyEvent', params) }
    else if (input.kind === 'wheel') { const { kind: _kind, ...params } = input; await tab.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...params }) }
    else { const { kind: _kind, ...params } = input; await tab.cdp.send('Input.dispatchMouseEvent', params) }
  }
  async screencast(sessionId: string, tabId: string, options: { maxWidth?: number; maxHeight?: number; quality?: number }, send: (item: BrowserScreencastItem) => void): Promise<{ ack(frameId: number): Promise<void>; release(): Promise<void> }> {
    const { tab } = await this.tab(sessionId, tabId)
    if (!tab.stream) { const stream = new ScreencastHub(tab); tab.stream = stream; void stream.start(options).catch(async () => { if (tab.stream === stream) tab.stream = undefined; await stream.stop() }) }
    const stream = tab.stream
    await stream.ready
    if (tab.stream !== stream) return this.screencast(sessionId, tabId, options, send)
    return stream.attach(send)
  }
  async recordingStart(sessionId: string, tabId: string) {
    const { session, tab } = await this.tab(sessionId, tabId)
    if (tab.recording) throw new Error('This tab is already recording.')
    const recordingId = randomUUID(), startedAt = new Date().toISOString()
    const path = join(getSessionBrowserArtifactsDir(this.options.dataDir, session.snapshot.projectId, sessionId), `${recordingId}.webm`)
    const encoder = await BrowserRecording.start(this.options.dataDir, path, tab.state.viewport.width, tab.state.viewport.height)
    const recording: NonNullable<LiveTab['recording']> = { recordingId, startedAt, encoder, cast: { release: async () => {} }, work: Promise.resolve() }
    const cast = await this.screencast(sessionId, tabId, {}, item => {
      if (item.kind !== 'frame') return
      recording.work = recording.work.then(async () => { await encoder.frame(item.data); await cast.ack(item.frameId) }).catch(error => { recording.error = error; void cast.release() })
    })
    recording.cast = cast; tab.recording = recording; tab.state.recordingId = recordingId; this.publish(session)
    return { recordingId, tabId, recording: true, startedAt, mimeType: 'video/webm', ...tab.state.viewport }
  }
  async recordingStop(sessionId: string, tabId: string) {
    const { session, tab } = await this.tab(sessionId, tabId); const recording = tab.recording
    if (!recording) throw new Error('This tab is not recording.')
    tab.recording = undefined; delete tab.state.recordingId; await recording.cast.release(); await recording.work
    try { const sizeBytes = await recording.encoder.stop(); if (recording.error) throw recording.error; return { recordingId: recording.recordingId, tabId, path: recording.encoder.path, mimeType: 'video/webm', extension: 'webm', sizeBytes, ...tab.state.viewport, createdAt: new Date().toISOString() } }
    finally { this.publish(session) }
  }
  async invoke<O extends BrowserAutomationOperation>(sessionId: string, projectId: string, operation: O, input: BrowserAutomationInputByOperation[O]): Promise<BrowserAutomationInvocationResult<O>> {
    try {
      if (this.project(sessionId) !== projectId) throw new Error('Browser profile does not belong to this session.')
      const result = await this.perform(sessionId, operation, input)
      return { ok: true, operation, result: result as BrowserAutomationResultByOperation[O] }
    } catch (error) { return { ok: false, operation, error: { code: error instanceof Error && /interrupt|abort/i.test(error.message) ? 'request-cancelled' : 'execution-failed', message: error instanceof Error ? error.message.slice(0, 1024) : 'Browser operation failed.', retryable: false } } }
  }
  private async perform(sessionId: string, operation: BrowserAutomationOperation, input: BrowserAutomationInputByOperation[BrowserAutomationOperation]): Promise<unknown> {
    const sessionGeneration = this.cancellationGenerations.get(sessionId) ?? 0
    if (operation === 'status') { const snapshot = await this.getSnapshot(sessionId); return { available: snapshot.browserEngineState !== 'failed' && snapshot.browserEngineState !== 'needs-host-setup', ...this.setupState(), selectedTab: snapshot.tabs.find(tab => tab.tabId === snapshot.activeTabId) ?? null, tabs: snapshot.tabs } }
    if (operation === 'open') {
      const generation = this.cancellationGenerations.get(sessionId) ?? 0
      const value = input as BrowserAutomationInputByOperation['open']; const current = await this.getSnapshot(sessionId)
      this.checkOpenGeneration(sessionId, generation)
      const existing = value.tabId ? current.tabs.find(tab => tab.tabId === value.tabId) : value.reuseExistingTab ? current.tabs.find(tab => tab.tabId === current.activeTabId) : undefined
      if (value.tabId && !existing) throw new Error('The requested browser tab does not belong to this session.')
      const snapshot = existing ? await this.activate(sessionId, existing.tabId) : await this.open(sessionId, {}, generation)
      try {
        this.checkOpenGeneration(sessionId, generation)
        if (value.url) await this.perform(sessionId, 'navigate', { tabId: snapshot.activeTabId!, url: value.url, timeoutMs: 15000, readiness: 'domContentLoaded' })
      } catch (error) { if (!existing && (this.cancellationGenerations.get(sessionId) ?? 0) !== generation) await this.close(sessionId, snapshot.activeTabId!).catch(() => {}); throw error }
      return { tab: (await this.getSnapshot(sessionId)).tabs.find(tab => tab.tabId === snapshot.activeTabId)!, created: !existing, panelRevealRequested: value.show !== false }
    }
    const { session, tab } = await this.tab(sessionId, input.tabId)
    const actionEpoch = tab.actionEpoch
    const run = async () => {
      this.checkOpenGeneration(sessionId, sessionGeneration)
      if (tab.actionEpoch !== actionEpoch) throw new Error('User input interrupted this browser action.')
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
      case 'navigate': { const input = raw as BrowserAutomationInputByOperation['navigate']; const url = input.url ?? `${input.environmentProtocol ?? 'http'}://127.0.0.1:${input.environmentPort}${input.path ?? '/'}`; await this.navigate(session.snapshot.sessionId, tabId, { url }, signal, input.readiness === 'none' ? 'commit' : input.readiness === 'domContentLoaded' ? 'domcontentloaded' : 'load'); return { tab: structuredClone(tab.state), readiness: input.readiness } }
      case 'resize': { const input = raw as BrowserAutomationInputByOperation['resize']; const viewport = input.mode === 'freeform' ? { width: input.width, height: input.height } : input.mode === 'preset' ? { ...BROWSER_VIEWPORT_PRESETS[input.presetId] } : { width: 1280, height: 800 }; if (input.mode === 'preset' && input.orientation === 'landscape') [viewport.width, viewport.height] = [viewport.height, viewport.width]; await this.resize(session.snapshot.sessionId, tabId, viewport); return { tabId, setting: { mode: 'freeform', ...viewport }, viewport: { ...viewport, deviceScaleFactor: 1 } } }
      case 'recordingStart': return this.recordingStart(session.snapshot.sessionId, tabId)
      case 'recordingStop': return this.recordingStop(session.snapshot.sessionId, tabId)
      case 'snapshot': return this.capture(tab, signal)
      case 'click': { const input = raw as BrowserAutomationInputByOperation['click']; let point: { x: number; y: number }; if ('x' in input && typeof input.x === 'number' && typeof input.y === 'number') { point = { x: input.x, y: input.y }; tab.state.agentCursor = { ...point, phase: 'click', sequence: ++tab.cursorSequence }; this.publish(session); await page.mouse.click(point.x, point.y) } else { const locator = locate(page, input as { locator?: string; selector?: string }); point = await this.point(session, tab, locator, signal, true); await locator.click({ timeout: input.timeoutMs, signal }) } return { tabId, point } }
      case 'type': { const input = raw as BrowserAutomationInputByOperation['type']; const locator = input.locator || input.selector ? locate(page, input) : page.locator(':focus'); await this.point(session, tab, locator, signal); if (input.clear) await locator.fill(input.text, { timeout: input.timeoutMs, signal }); else await locator.pressSequentially(input.text, { timeout: input.timeoutMs, signal }); return { tabId, characters: input.text.length, cleared: input.clear ?? false } }
      case 'press': { const input = raw as BrowserAutomationInputByOperation['press']; signal.throwIfAborted(); await page.keyboard.press([...(input.modifiers ?? []), input.key].join('+')); return { tabId, key: input.key, modifiers: input.modifiers ?? [] } }
      case 'scroll': { const input = raw as BrowserAutomationInputByOperation['scroll']; const deltaX = input.deltaX ?? 0, deltaY = input.deltaY ?? 0; if (input.locator || input.selector) { const locator = locate(page, input); await this.point(session, tab, locator, signal); await locator.evaluate(`(element) => element.scrollBy(${deltaX}, ${deltaY})`) } else { signal.throwIfAborted(); await page.mouse.wheel(deltaX, deltaY) } const positions = await page.evaluate<{ scrollX: number; scrollY: number }>('({ scrollX, scrollY })'); return { tabId, deltaX, deltaY, ...positions } }
      case 'evaluate': {
        const input = raw as BrowserAutomationInputByOperation['evaluate']; signal.throwIfAborted()
        let interrupt!: () => void
        const cancelled = new Promise<never>((_resolve, reject) => {
          interrupt = () => { void tab.cdp.send('Runtime.terminateExecution').catch(() => {}); reject(signal.reason ?? new Error('Browser evaluation was interrupted.')) }
          signal.addEventListener('abort', interrupt, { once: true })
        })
        try {
          // Termination does not settle CDP evaluations waiting on a page promise.
          // The owning action must still finish immediately when the user interrupts it.
          const result = await Promise.race([tab.cdp.send('Runtime.evaluate', { expression: input.expression, awaitPromise: input.awaitPromise, returnByValue: input.returnByValue }), cancelled])
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
          signal.throwIfAborted(); const value = result.result.value; const serializedBytes = Buffer.byteLength(JSON.stringify(value) ?? '')
          if (serializedBytes > 65536) throw new Error('Evaluation result exceeds 64 KiB.')
          return { tabId, ...(input.returnByValue ? { value } : { remoteObject: result.result }), serializedBytes }
        } finally { signal.removeEventListener('abort', interrupt) }
      }
      case 'waitFor': { const input = raw as BrowserAutomationInputByOperation['waitFor']; const started = Date.now(); if (input.locator || input.selector) await locate(page, input).waitFor({ state: 'visible', timeout: input.timeoutMs, signal }); if (input.text) await page.getByText(input.text, { exact: false }).first().waitFor({ state: 'visible', timeout: input.timeoutMs, signal }); if (input.urlIncludes) await page.waitForURL(url => url.href.includes(input.urlIncludes!), { timeout: input.timeoutMs, signal }); return { tabId, matched: true, elapsedMs: Date.now() - started } }
      default: throw new Error(`Browser operation ${operation} is not implemented yet.`)
    }
  }
  private async capture(tab: LiveTab, signal: AbortSignal): Promise<BrowserSnapshotResult> {
    const image = await sharp(await tab.page.screenshot({ type: 'png', signal })).resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true })
    const visibleText = await tab.page.locator('body').innerText({ timeout: 15000, signal }).catch(() => '')
    const accessibility = await tab.page.locator('body').ariaSnapshot({ timeout: 15000, signal })
    const interactiveElements = await tab.page.evaluate<BrowserSnapshotResult['interactiveElements']>(`(() => {
      const selector = element => { if (element.id) return '#' + CSS.escape(element.id); const parts = []; for (let node = element; node && node !== document.documentElement; node = node.parentElement) { const siblings = node.parentElement ? [...node.parentElement.children].filter(other => other.tagName === node.tagName) : []; parts.unshift(node.tagName.toLowerCase() + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : '')); if (parts.length >= 8) break; } return parts.join(' > '); };
      return [...document.querySelectorAll('button,a[href],input:not([type=hidden]),textarea,select,[role=button],[role=link],[contenteditable=true]')].filter(element => { const bounds = element.getBoundingClientRect(); const style = getComputedStyle(element); return bounds.width > 0 && bounds.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; }).slice(0, 200).map(element => { const bounds = element.getBoundingClientRect(); return { tag: element.tagName.toLowerCase(), role: element.getAttribute('role') || ({BUTTON:'button',A:'link',TEXTAREA:'textbox',SELECT:'combobox',INPUT:'textbox'})[element.tagName] || null, name: (element.getAttribute('aria-label') || element.labels?.[0]?.innerText || element.innerText || element.getAttribute('placeholder') || element.getAttribute('title') || '').slice(0,256), selector: selector(element), x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }; });
    })()`)
    return { tabId: tab.state.tabId, url: tab.page.url(), title: await tab.page.title(), loading: tab.state.loading, viewportSetting: { mode: 'freeform', ...tab.state.viewport }, viewport: { ...tab.state.viewport, deviceScaleFactor: 1 }, visibleText: visibleText.slice(0, 20000), interactiveElements, accessibility: accessibility.slice(0, 64000), consoleEntries: tab.console.slice(), networkEntries: tab.network.slice(), actionTimeline: [], screenshot: { mimeType: 'image/png', data: image.data.toString('base64'), width: image.info.width, height: image.info.height } }
  }
  cancelSession(sessionId: string): number {
    this.cancellationGenerations.set(sessionId, (this.cancellationGenerations.get(sessionId) ?? 0) + 1)
    const loaded = this.sessions.get(sessionId)
    if (loaded) void loaded.then(session => { for (const tab of session.tabs.values()) { tab.actionEpoch++; tab.action?.abort(new Error('Browser session was stopped.')) } }).catch(() => {})
    return loaded ? 1 : 0
  }
  async endBrowserTurn(_profileId: string, sessionId: string, _turnId: string): Promise<void> { await this.releaseSessionForLifecycle(_profileId, sessionId, 'stop') }
  async releaseSessionForLifecycle(_profileId: string, sessionId: string, _reason: 'stop' | 'archive' | 'delete' | 'host-replaced'): Promise<void> {
    this.cancelSession(sessionId); const loaded = this.sessions.get(sessionId); if (!loaded) return
    const session = await loaded; await Promise.allSettled([...session.tabs.values()].map(tab => tab.actionTail))
    for (const tab of session.tabs.values()) { tab.state.controller = 'none'; delete tab.state.agentAction; delete tab.state.agentCursor }
    this.publish(session)
  }
  async archiveSession(profileId: string, sessionId: string): Promise<void> {
    await this.releaseSessionForLifecycle(profileId, sessionId, 'archive'); this.cookies.releaseSession(sessionId)
    const loaded = this.sessions.get(sessionId); if (!loaded) return; const session = await loaded
    await this.persist(session); session.closed = true; this.sessions.delete(sessionId); await Promise.allSettled([...session.popups])
    for (const tab of session.tabs.values()) { tab.closing = true; if (tab.recording) { await tab.recording.cast.release(); await tab.recording.work; await tab.recording.encoder.stop().catch(() => {}) }; await tab.stream?.stop(); await tab.dispose() }
    session.tabs.clear(); session.snapshot.activeTabId = null; this.publish(session)
  }
  async restoreSession(_profileId: string, sessionId: string): Promise<void> { if (this.sessions.has(sessionId)) return; await this.getSnapshot(sessionId) }
  async deleteSession(profileId: string, sessionId: string): Promise<void> {
    await this.archiveSession(profileId, sessionId)
    await rm(getSessionBrowserStatePath(this.options.dataDir, profileId, sessionId), { force: true })
    await rm(getSessionBrowserArtifactsDir(this.options.dataDir, profileId, sessionId), { recursive: true, force: true })
  }
  async shutdown() { this.cookies.shutdown(); this.shuttingDown = true; for (const work of this.sessions.values()) { const session = await work.catch(() => undefined); if (!session) continue; await Promise.allSettled([...session.popups]); await this.persist(session); for (const tab of session.tabs.values()) { tab.action?.abort(); if (tab.recording) await this.recordingStop(session.snapshot.sessionId, tab.state.tabId).catch(() => {}); await tab.stream?.stop(); await tab.dispose().catch(() => {}) } } this.sessions.clear(); await this.headless.shutdown(); await this.desktop.shutdown() }
}
function normalizeUrl(raw: string) { const url = new URL(raw); if (!['http:', 'https:', 'about:'].includes(url.protocol) || url.username || url.password || (url.protocol === 'about:' && url.href !== 'about:blank')) throw new Error('Browser navigation requires HTTP(S) or about:blank, without URL credentials.'); return url.href }
function locate(page: Page, input: { selector?: string; locator?: string }) { if (input.selector) return page.locator(input.selector); const locator = input.locator ?? ':focus'; if (locator.startsWith('label=')) return page.getByLabel(locator.slice(6), { exact: true }); if (locator.startsWith('text=')) return page.getByText(locator.slice(5), { exact: true }); const role = /^role=([\w-]+)(?:\[name=["'](.*)["']\])?$/.exec(locator); if (role) return page.getByRole(role[1] as Parameters<Page['getByRole']>[0], role[2] ? { name: role[2], exact: true } : {}); return page.locator(locator) }
function actionLabel(operation: string, input: object) { const value = input as { locator?: string; selector?: string }; const target = value.locator?.replace(/^(label|text)=/, '').replace(/^role=\w+\[name=["'](.*)["']\]$/, '$1') ?? value.selector; const verb = ({ click: 'Clicking', type: 'Typing into', navigate: 'Navigating', snapshot: 'Inspecting the page', waitFor: 'Waiting for', evaluate: 'Evaluating page JavaScript', scroll: 'Scrolling', press: 'Pressing a key', resize: 'Resizing' } as Record<string, string>)[operation] ?? operation; return `${verb}${target ? ` “${target}”` : ''}`.slice(0, 256) }
