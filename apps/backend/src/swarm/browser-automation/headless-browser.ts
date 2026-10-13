import { cachedBrowserExecutable, installBrowserRuntime } from './browser-runtime.js'
import { mkdir } from 'node:fs/promises'
import { chromium, type BrowserContext } from 'playwright-core'
import { getBrowserProfileDir, getBrowserRuntimeDir } from '../storage/data-paths.js'
import type { BrowserEngineSetupState } from '@forge/protocol'
import { BROWSER_HOST_SETUP_COMMAND, needsLinuxBrowserHostSetup, needsLinuxBrowserHostSetupSync, cachedSystemBrowserExecutable, verifiedSystemBrowserExecutable, hasOlderSystemBrowser } from './linux-browser-sandbox.js'
export { HEADLESS_CHROME_VERSION } from './browser-runtime.js'
export const LINUX_BROWSER_PACKAGES = 'libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libdbus-1-3 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2'
export interface BrowserSetupState { browserEngineState: BrowserEngineSetupState; browserEngineMessage?: string; browserEngineSetupCommand?: string }
interface ProjectContext { work: Promise<BrowserContext>; live?: BrowserContext; operations: number; rememberSessionCookies: boolean; retiring?: Promise<void> }
function browserEnvironment() {
  // Provider credentials and private bootstrap capabilities must not be inherited.
  const allowed = /^(PATH|HOME|USER|LOGNAME|TMPDIR|TMP|TEMP|LANG|LC_.*|SYSTEMROOT|WINDIR|LOCALAPPDATA|APPDATA|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|LD_LIBRARY_PATH)$/i
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.test(key) && value !== undefined)) as Record<string, string>
}
export class HeadlessBrowser {
  private installing?: Promise<string>
  private preparing?: Promise<void>
  private executable?: string
  private setup: BrowserSetupState = { browserEngineState: 'missing' }
  private readonly sessionCookies = new Map<string, Awaited<ReturnType<BrowserContext['cookies']>>>()
  private shuttingDown = false
  private systemVerified = false
  private readonly contexts = new Map<string, ProjectContext>()
  constructor(private readonly options: { dataDir: string; cacheDir?: string; onSetup?(state: BrowserSetupState): void }) {
    const system = cachedSystemBrowserExecutable(), cached = system ?? this.cachedExecutable()
    if (cached) { this.executable = cached; this.setup = { browserEngineState: 'ready' } }
    try { if (!system && needsLinuxBrowserHostSetupSync()) this.setup = this.hostSetupState() } catch (error) { this.setup = { browserEngineState: 'failed', browserEngineMessage: `Could not check the browser host policy: ${error instanceof Error ? error.message : 'permission denied'}` } }
  }
  private cachedExecutable(): string | undefined { return cachedBrowserExecutable(this.options.cacheDir ?? getBrowserRuntimeDir(this.options.dataDir)) }
  state(): BrowserSetupState { return { ...this.setup } }
  private update(setup: BrowserSetupState) { this.setup = setup; this.options.onSetup?.(this.state()) }
  /** Retry also verifies the host sandbox, even when Chrome is already cached. */
  prepare(): Promise<void> {
    if (this.preparing) return this.preparing
    this.update({ browserEngineState: 'installing', browserEngineMessage: 'Checking the Forge browser…' })
    this.preparing = (async () => {
      const executablePath = await this.ensureExecutable()
      this.update({ browserEngineState: 'installing', browserEngineMessage: 'Checking the browser sandbox…' })
      try {
        const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: browserEnvironment() })
        await browser.close(); this.update({ browserEngineState: 'ready' })
      } catch (cause) { throw await this.launchFailure(cause) }
    })().finally(() => { this.preparing = undefined })
    return this.preparing
  }
  private hostSetupState(): BrowserSetupState {
    const message = hasOlderSystemBrowser() ? `Forge's browser was updated; run ${BROWSER_HOST_SETUP_COMMAND} again on this machine.` : `This machine needs a one-time browser host setup: ${BROWSER_HOST_SETUP_COMMAND}.`
    return { browserEngineState: 'needs-host-setup', browserEngineMessage: `${message} Then retry the Forge browser. Chromium’s sandbox remains enabled. Do not substitute other browsers.`, browserEngineSetupCommand: BROWSER_HOST_SETUP_COMMAND }
  }
  async ensureExecutable(): Promise<string> {
    if (process.platform === 'linux' && !this.systemVerified) {
      const system = await verifiedSystemBrowserExecutable()
      if (system) { this.executable = system; this.systemVerified = true; this.update({ browserEngineState: 'ready' }); return system }
      let restricted: boolean
      try { restricted = await needsLinuxBrowserHostSetup() }
      catch (error) { this.update({ browserEngineState: 'failed', browserEngineMessage: 'Could not check the browser host sandbox policy.' }); throw error }
      if (restricted) { const setup = this.hostSetupState(); this.update(setup); throw new Error(setup.browserEngineMessage) }
      // An invalid system digest must never leave the startup candidate selected.
      this.executable = this.cachedExecutable()
    }
    if (this.executable) return this.executable
    if (this.installing) return this.installing
    this.update({ browserEngineState: 'installing', browserEngineMessage: 'Preparing the Forge browser…' })
    this.installing = installBrowserRuntime(this.options.cacheDir ?? getBrowserRuntimeDir(this.options.dataDir), { progress: message => this.update({ browserEngineState: 'installing', browserEngineMessage: message }) }).then(path => { this.executable = path; this.update({ browserEngineState: 'ready' }); return path }, error => { this.update({ browserEngineState: 'failed', browserEngineMessage: error instanceof Error ? error.message.slice(0, 1024) : 'Browser installation failed.' }); throw error }).finally(() => { this.installing = undefined })
    return this.installing
  }
  private projectContext(projectId: string): ProjectContext {
    const current = this.contexts.get(projectId); if (current) return current
    const entry: ProjectContext = { work: undefined!, operations: 0, rememberSessionCookies: true }
    entry.work = this.launch(projectId, entry).catch(error => { if (this.contexts.get(projectId) === entry) this.contexts.delete(projectId); throw error })
    this.contexts.set(projectId, entry); return entry
  }
  async context(projectId: string): Promise<BrowserContext> {
    const entry = this.projectContext(projectId)
    if (entry.retiring) { await entry.retiring; return this.context(projectId) }
    return entry.work
  }
  /** Hold the project while creating a page or using its cookie store. New work
   * waits for retirement, avoiding two processes locking the same profile. */
  async withContext<T>(projectId: string, work: (context: BrowserContext) => Promise<T>): Promise<T> {
    const entry = this.projectContext(projectId)
    if (entry.retiring) { await entry.retiring; return this.withContext(projectId, work) }
    entry.operations++
    try { return await work(await this.context(projectId)) }
    finally { entry.operations--; await this.retireIdle(projectId) }
  }
  async retireIdle(projectId: string): Promise<void> {
    const entry = this.contexts.get(projectId); if (!entry) return
    if (entry.retiring) return entry.retiring
    const context = await entry.work.catch(() => undefined)
    if (entry.retiring) return entry.retiring
    if (!context || this.contexts.get(projectId) !== entry || entry.operations || context.pages().length) return
    // Keep the entry until close completes: another operation must wait before
    // opening this persistent profile again. Session cookies remain memory-only.
    entry.retiring = (async () => {
      try {
        const cookies = (await context.cookies()).filter(cookie => cookie.expires === -1)
        if (entry.rememberSessionCookies && !this.shuttingDown) { if (cookies.length) this.sessionCookies.set(projectId, cookies); else this.sessionCookies.delete(projectId) }
      } finally { await context.close() }
    })().finally(() => { if (this.contexts.get(projectId) === entry) this.contexts.delete(projectId) })
    return entry.retiring
  }
  private async launch(projectId: string, owner: ProjectContext): Promise<BrowserContext> {
    const executablePath = await this.ensureExecutable()
    const profile = getBrowserProfileDir(this.options.dataDir, projectId); await mkdir(profile, { recursive: true, mode: 0o700 })
    let context: BrowserContext | undefined
    try {
      context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, chromiumSandbox: true, viewport: { width: 1280, height: 800 }, env: browserEnvironment() })
      const remembered = this.sessionCookies.get(projectId)
      if (remembered && owner.rememberSessionCookies) await context.addCookies(remembered)
      // Once open, Chromium owns the cookies. Forget operates on that same store;
      // the next retirement captures only the remaining session cookies.
      this.sessionCookies.delete(projectId)
      for (const page of context.pages()) await page.close()
      owner.live = context
      context.on('page', page => { page.once('close', () => { void this.retireIdle(projectId).catch(() => {}) }) })
      context.on('close', () => { if (this.contexts.get(projectId) === owner && !owner.retiring) this.contexts.delete(projectId) }); return context
    } catch (cause) { await context?.close().catch(() => {}); throw await this.launchFailure(cause) }
  }
  private async launchFailure(cause: unknown): Promise<Error> {
    const raw = cause instanceof Error ? cause.message : String(cause)
    let hostSetup = false
    if (/sandbox|zygote|Operation not permitted|userns|namespace/i.test(raw)) {
      try { hostSetup = await needsLinuxBrowserHostSetup() }
      catch (error) {
        const message = `Could not check the host browser sandbox policy: ${error instanceof Error ? error.message.slice(0, 700) : 'permission denied'}`
        this.update({ browserEngineState: 'failed', browserEngineMessage: message }); return new Error(message)
      }
    }
    if (hostSetup) {
      const setup = this.hostSetupState(); this.update(setup); return new Error(setup.browserEngineMessage)
    }
    const message = process.platform === 'linux' && /shared libraries|not found|host system is missing|lib.*\.so/.test(raw)
        ? `Browser system libraries are missing. On Debian/Ubuntu run: sudo apt-get install ${LINUX_BROWSER_PACKAGES}`
        : /sandbox|zygote|Operation not permitted/.test(raw) ? 'Chromium sandbox could not start. Enable unprivileged user namespaces or a supported sandbox on this host; Forge does not disable the sandbox.' : `Browser failed to start: ${raw.slice(0, 700)}`
    this.update({ browserEngineState: 'failed', browserEngineMessage: message }); return new Error(message)
  }
  forgetSessionCookies(projectId: string) {
    this.sessionCookies.delete(projectId)
    const context = this.contexts.get(projectId)
    // Another session's live tabs continue their existing Chromium session. Only
    // fence idle/in-flight retirement; there is no remembered stash while live.
    if (context && (context.retiring || !context.live?.pages().length)) context.rememberSessionCookies = false
  }
  async shutdown() { this.shuttingDown = true; this.sessionCookies.clear(); await Promise.allSettled([...this.contexts.values()].map(async entry => entry.retiring ?? (await entry.work).close())); this.contexts.clear(); this.sessionCookies.clear() }
}
