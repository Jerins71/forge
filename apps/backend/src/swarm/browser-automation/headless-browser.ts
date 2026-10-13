import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, accessSync, readFileSync, constants } from 'node:fs'
import { access, chmod, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import extract from '@electron-internal/extract-zip'
import { chromium, type BrowserContext } from 'playwright-core'
import { getBrowserProfileDir, getBrowserRuntimeDir } from '../storage/data-paths.js'
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
export interface BrowserSetupState { browserEngineState: 'ready' | 'missing' | 'installing' | 'failed'; browserEngineMessage?: string }
function platformKey(): keyof typeof releases {
  if (!['x64', 'arm64', ...(process.platform === 'win32' ? ['ia32'] : [])].includes(process.arch)) throw new Error(`Chrome headless shell does not support ${process.platform}-${process.arch}.`)
  const key = process.platform === 'darwin' ? `mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}` : process.platform === 'win32' ? process.arch === 'ia32' ? 'win32' : 'win64' : process.platform === 'linux' ? process.arch === 'arm64' ? 'linux-arm64' : 'linux64' : undefined
  if (!key || !(key in releases)) throw new Error(`Chrome headless shell does not support ${process.platform}-${process.arch}.`)
  return key as keyof typeof releases
}
export class HeadlessBrowser {
  private installing?: Promise<string>
  private executable?: string
  private setup: BrowserSetupState = { browserEngineState: 'missing' }
  private readonly contexts = new Map<string, Promise<BrowserContext>>()
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
        const part = join(staging, 'download.zip'); let bytes = 0
        async function* bounded() { for await (const chunk of Readable.fromWeb(response.body! as Parameters<typeof Readable.fromWeb>[0])) { bytes += chunk.length; if (bytes > releases[platform][0]) throw new Error('Browser archive exceeds its pinned length.'); yield chunk } }
        // The archive streams to disk with a size cap; the whole-file helper would buffer it.
        // eslint-disable-next-line no-restricted-syntax
        await pipeline(bounded(), createWriteStream(part, { mode: 0o600 })); await rename(part, archive)
      }
      const [length, sha256] = releases[platform]; const hash = createHash('sha256'); let bytes = 0
      for await (const chunk of createReadStream(archive)) { bytes += chunk.length; hash.update(chunk) }
      if (bytes !== length || hash.digest('hex') !== sha256) { await rm(archive); throw new Error('Browser archive did not match its pinned SHA-256 and size.') }
      await extract(archive, { dir: staging })
      await import('../../utils/atomic-files.js').then(files => files.writeJsonFileAtomic(join(staging, 'integrity.json'), { version: HEADLESS_CHROME_VERSION, sha256: releases[platform][1] }, { mode: 0o600 }))
      if (process.platform !== 'win32') await chmod(join(staging, folder, 'chrome-headless-shell'), 0o755)
      await mkdir(join(root, HEADLESS_CHROME_VERSION), { recursive: true, mode: 0o700 })
      // Concurrent environments may share only the binary cache, never profiles.
      // Atomically install the entire verified directory, including its executable and marker.
      // eslint-disable-next-line no-restricted-syntax
      try { await rename(staging, target) } catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; if (!this.cachedExecutable()) { await rm(target, { recursive: true, force: true }); await rename(staging, target) } }
      return executable
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
  async context(projectId: string): Promise<BrowserContext> {
    const current = this.contexts.get(projectId); if (current) return current
    const work = this.launch(projectId).catch(error => { this.contexts.delete(projectId); throw error }); this.contexts.set(projectId, work); return work
  }
  private async launch(projectId: string): Promise<BrowserContext> {
    const executablePath = await this.ensureExecutable()
    const profile = getBrowserProfileDir(this.options.dataDir, projectId); await mkdir(profile, { recursive: true, mode: 0o700 })
    // Provider credentials and private bootstrap capabilities must not be inherited.
    const allowed = /^(PATH|HOME|USER|LOGNAME|TMPDIR|TMP|TEMP|LANG|LC_.*|SYSTEMROOT|WINDIR|LOCALAPPDATA|APPDATA|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|LD_LIBRARY_PATH)$/i
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.test(key) && value !== undefined)) as Record<string, string>
    try {
      const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, chromiumSandbox: true, viewport: { width: 1280, height: 800 }, env })
      for (const page of context.pages()) await page.close()
      context.on('close', () => { this.contexts.delete(projectId) }); return context
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause)
      const message = process.platform === 'linux' && /shared libraries|not found|host system is missing|lib.*\.so/.test(raw)
        ? `Browser system libraries are missing. On Debian/Ubuntu run: sudo apt-get install ${LINUX_BROWSER_PACKAGES}`
        : /sandbox|zygote|Operation not permitted/.test(raw) ? 'Chromium sandbox could not start. Enable unprivileged user namespaces or a supported sandbox on this host; Forge does not disable the sandbox.' : `Browser failed to start: ${raw.slice(0, 700)}`
      this.update({ browserEngineState: 'failed', browserEngineMessage: message }); throw new Error(message)
    }
  }
  async shutdown() { await Promise.allSettled([...this.contexts.values()].map(async work => (await work).close())); this.contexts.clear() }
}
