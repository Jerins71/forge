import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, accessSync, readFileSync, constants } from 'node:fs'
import { access, chmod, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { writeFileAtomic, writeJsonFileAtomic } from '../../utils/atomic-files.js'
import extract from '@electron-internal/extract-zip'
import { chromium, type BrowserContext } from 'playwright-core'
import { getBrowserProfileDir, getBrowserRuntimeDir } from '../storage/data-paths.js'
import type { BrowserEngineSetupState } from '@forge/protocol'
import { BROWSER_HOST_SETUP_COMMAND, needsLinuxBrowserHostSetup } from './linux-browser-sandbox.js'
/** Chrome for Testing pins verified by T3 Tools Inc. @df26ef99 (MIT).
 * Updating this version requires replacing all hashes and archive lengths. */
export const HEADLESS_CHROME_VERSION = '154.0.8037.92'
const releases = {
  linux64: [120477194, '636aa5c79f2693632e9921b8bbb050038ba11672e02346c06c20f991aed096f9'],
  'linux-arm64': [121182296, '0ed0e47d9e9f639197f508d62ada09e5c6b4c4c60edab3160a9312a733091df6'],
  'mac-arm64': [99221129, '77da14e75d7f2568e6f7898d3df7cdc6faac74b15e903b2c9d486ebb6ca9b929'],
  'mac-x64': [104748425, 'a54292aaacbb77f76f6ef47558e7c51ab884044e0adacca315567f83c060bcc4'],
  win32: [114295943, '56b30d2d6c35775ebf8dc3618680f6529e1c38c87f7feb28a16e9904273d51f7'],
  win64: [120822223, '3ac2561f02d9d87aadc0399d00b9002d718a4c365624fa67db9e7bfaf6b1a568'],
} as const
export const LINUX_BROWSER_PACKAGES = 'libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libdbus-1-3 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2'
export interface BrowserSetupState { browserEngineState: BrowserEngineSetupState; browserEngineMessage?: string; browserEngineSetupCommand?: string }
interface ProjectContext { work: Promise<BrowserContext>; operations: number; retiring?: Promise<void> }
function browserEnvironment() {
  // Provider credentials and private bootstrap capabilities must not be inherited.
  const allowed = /^(PATH|HOME|USER|LOGNAME|TMPDIR|TMP|TEMP|LANG|LC_.*|SYSTEMROOT|WINDIR|LOCALAPPDATA|APPDATA|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|LD_LIBRARY_PATH)$/i
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.test(key) && value !== undefined)) as Record<string, string>
}
function platformKey(): keyof typeof releases {
  if (!['x64', 'arm64', ...(process.platform === 'win32' ? ['ia32'] : [])].includes(process.arch)) throw new Error(`Chrome headless shell does not support ${process.platform}-${process.arch}.`)
  const key = process.platform === 'darwin' ? `mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}` : process.platform === 'win32' ? process.arch === 'ia32' ? 'win32' : 'win64' : process.platform === 'linux' ? process.arch === 'arm64' ? 'linux-arm64' : 'linux64' : undefined
  if (!key || !(key in releases)) throw new Error(`Chrome headless shell does not support ${process.platform}-${process.arch}.`)
  return key as keyof typeof releases
}
export class HeadlessBrowser {
  private installing?: Promise<string>
  private preparing?: Promise<void>
  private executable?: string
  private setup: BrowserSetupState = { browserEngineState: 'missing' }
  private readonly contexts = new Map<string, ProjectContext>()
  constructor(private readonly options: { dataDir: string; cacheDir?: string; onSetup?(state: BrowserSetupState): void }) {
    const cached = this.cachedExecutable()
    if (cached) { this.executable = cached; this.setup = { browserEngineState: 'ready' } }
  }
  private cachedExecutable(): string | undefined {
    try {
      const platform = platformKey(), folder = `chrome-headless-shell-${platform}`
      const target = join(this.options.cacheDir ?? getBrowserRuntimeDir(this.options.dataDir), HEADLESS_CHROME_VERSION, platform)
      const marker = JSON.parse(readFileSync(join(target, 'integrity.json'), 'utf8')) as { version?: string; sha256?: string }
      if (marker.version !== HEADLESS_CHROME_VERSION || marker.sha256 !== releases[platform][1]) return undefined
      const executable = join(target, folder, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell')
      accessSync(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return executable
    } catch { return undefined }
  }
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
  async ensureExecutable(): Promise<string> {
    if (this.executable) return this.executable
    if (this.installing) return this.installing
    this.update({ browserEngineState: 'installing', browserEngineMessage: 'Preparing the Forge browser…' })
    this.installing = this.install().then(path => { this.executable = path; this.update({ browserEngineState: 'ready' }); return path }, error => { this.update({ browserEngineState: 'failed', browserEngineMessage: error instanceof Error ? error.message.slice(0, 1024) : 'Browser installation failed.' }); throw error }).finally(() => { this.installing = undefined })
    return this.installing
  }
  private async install(): Promise<string> {
    const platform = platformKey(); const root = this.options.cacheDir ?? getBrowserRuntimeDir(this.options.dataDir)
    const folder = `chrome-headless-shell-${platform}`; const target = join(root, HEADLESS_CHROME_VERSION, platform)
    const executable = join(target, folder, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell')
    const cached = this.cachedExecutable(); if (cached) return cached
    this.update({ browserEngineState: 'installing', browserEngineMessage: 'Downloading the Forge browser…' })
    const staging = join(root, `.install-${randomUUID()}`); await mkdir(staging, { recursive: true, mode: 0o700 })
    await mkdir(join(root, HEADLESS_CHROME_VERSION), { recursive: true, mode: 0o700 })
    const archive = join(root, HEADLESS_CHROME_VERSION, `${platform}.zip`)
    try {
      try { await access(archive) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const response = await fetch(`https://storage.googleapis.com/chrome-for-testing-public/${HEADLESS_CHROME_VERSION}/${platform}/${folder}.zip`, { signal: AbortSignal.timeout(15 * 60 * 1000) })
        if (!response.ok || !response.body) throw new Error(`Browser download failed (${response.status}). Retry setup.`)
        let bytes = 0
        async function* bounded() { for await (const chunk of Readable.fromWeb(response.body! as Parameters<typeof Readable.fromWeb>[0])) { bytes += chunk.length; if (bytes > releases[platform][0]) throw new Error('Browser archive exceeds its pinned length.'); yield chunk } }
        await writeFileAtomic(archive, bounded(), { mode: 0o600 })
      }
      const [length, sha256] = releases[platform]; const hash = createHash('sha256'); let bytes = 0
      for await (const chunk of createReadStream(archive)) { bytes += chunk.length; hash.update(chunk) }
      if (bytes !== length || hash.digest('hex') !== sha256) { await rm(archive); throw new Error('Browser archive did not match its pinned SHA-256 and size.') }
      await extract(archive, { dir: staging })
      await writeJsonFileAtomic(join(staging, 'integrity.json'), { version: HEADLESS_CHROME_VERSION, sha256: releases[platform][1] }, { mode: 0o600 })
      if (process.platform !== 'win32') await chmod(join(staging, folder, 'chrome-headless-shell'), 0o755)
      await mkdir(join(root, HEADLESS_CHROME_VERSION), { recursive: true, mode: 0o700 })
      // Concurrent environments may share only the binary cache, never profiles.
      // Atomically install the entire verified directory, including its executable and marker.
      // eslint-disable-next-line no-restricted-syntax
      try { await rename(staging, target) } catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; if (!this.cachedExecutable()) { await rm(target, { recursive: true, force: true }); await rename(staging, target) } }
      return executable
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
  private projectContext(projectId: string): ProjectContext {
    const current = this.contexts.get(projectId); if (current) return current
    const entry: ProjectContext = { work: undefined!, operations: 0 }
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
    // opening this persistent profile again. Its directory and cookies stay put.
    entry.retiring = context.close().finally(() => { if (this.contexts.get(projectId) === entry) this.contexts.delete(projectId) })
    return entry.retiring
  }
  private async launch(projectId: string, owner: ProjectContext): Promise<BrowserContext> {
    const executablePath = await this.ensureExecutable()
    const profile = getBrowserProfileDir(this.options.dataDir, projectId); await mkdir(profile, { recursive: true, mode: 0o700 })
    try {
      const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, chromiumSandbox: true, viewport: { width: 1280, height: 800 }, env: browserEnvironment() })
      for (const page of context.pages()) await page.close()
      context.on('page', page => { page.once('close', () => { void this.retireIdle(projectId).catch(() => {}) }) })
      context.on('close', () => { if (this.contexts.get(projectId) === owner && !owner.retiring) this.contexts.delete(projectId) }); return context
    } catch (cause) { throw await this.launchFailure(cause) }
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
      const message = `This machine needs a one-time browser host setup: ${BROWSER_HOST_SETUP_COMMAND}. Then retry the Forge browser. Chromium’s sandbox remains enabled. Do not substitute other browsers.`
      this.update({ browserEngineState: 'needs-host-setup', browserEngineMessage: message, browserEngineSetupCommand: BROWSER_HOST_SETUP_COMMAND })
      return new Error(message)
    }
    const message = process.platform === 'linux' && /shared libraries|not found|host system is missing|lib.*\.so/.test(raw)
        ? `Browser system libraries are missing. On Debian/Ubuntu run: sudo apt-get install ${LINUX_BROWSER_PACKAGES}`
        : /sandbox|zygote|Operation not permitted/.test(raw) ? 'Chromium sandbox could not start. Enable unprivileged user namespaces or a supported sandbox on this host; Forge does not disable the sandbox.' : `Browser failed to start: ${raw.slice(0, 700)}`
    this.update({ browserEngineState: 'failed', browserEngineMessage: message }); return new Error(message)
  }
  async shutdown() { await Promise.allSettled([...this.contexts.values()].map(async entry => entry.retiring ?? (await entry.work).close())); this.contexts.clear() }
}
