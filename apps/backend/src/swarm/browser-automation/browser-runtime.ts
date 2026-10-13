import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, accessSync, readFileSync, constants } from 'node:fs'
import { access, chmod, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import extract from 'extract-zip'
import { writeFileAtomic, writeJsonFileAtomic } from '../../utils/atomic-files.js'
/** Chrome for Testing pins verified by T3 Tools Inc. @df26ef99 (MIT).
 * Updating this version requires replacing all hashes and archive lengths. */
export const HEADLESS_CHROME_VERSION = '154.0.8037.92'
export const BROWSER_RELEASES = {
  linux64: [120477194, '636aa5c79f2693632e9921b8bbb050038ba11672e02346c06c20f991aed096f9'],
  'linux-arm64': [121182296, '0ed0e47d9e9f639197f508d62ada09e5c6b4c4c60edab3160a9312a733091df6'],
  'mac-arm64': [99221129, '77da14e75d7f2568e6f7898d3df7cdc6faac74b15e903b2c9d486ebb6ca9b929'],
  'mac-x64': [104748425, 'a54292aaacbb77f76f6ef47558e7c51ab884044e0adacca315567f83c060bcc4'],
  win32: [114295943, '56b30d2d6c35775ebf8dc3618680f6529e1c38c87f7feb28a16e9904273d51f7'],
  win64: [120822223, '3ac2561f02d9d87aadc0399d00b9002d718a4c365624fa67db9e7bfaf6b1a568'],
} as const
export function browserPlatform(): keyof typeof BROWSER_RELEASES {
  if (!['x64', 'arm64', ...(process.platform === 'win32' ? ['ia32'] : [])].includes(process.arch)) throw new Error(`Chrome headless shell does not support ${process.platform}-${process.arch}.`)
  const key = process.platform === 'darwin' ? `mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}` : process.platform === 'win32' ? process.arch === 'ia32' ? 'win32' : 'win64' : process.platform === 'linux' ? process.arch === 'arm64' ? 'linux-arm64' : 'linux64' : undefined
  if (!key || !(key in BROWSER_RELEASES)) throw new Error(`Chrome headless shell does not support ${process.platform}-${process.arch}.`)
  return key as keyof typeof BROWSER_RELEASES
}
export async function runtimeFileHash(path: string): Promise<string> {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex')
}
export function cachedBrowserExecutable(root: string, platform = browserPlatform()): string | undefined {
  try {
    const folder = `chrome-headless-shell-${platform}`
    const target = join(root, HEADLESS_CHROME_VERSION, platform)
    const marker = JSON.parse(readFileSync(join(target, 'integrity.json'), 'utf8')) as { version?: string; sha256?: string }
    if (marker.version !== HEADLESS_CHROME_VERSION || marker.sha256 !== BROWSER_RELEASES[platform][1]) return undefined
    const executable = join(target, folder, platform.startsWith('win') ? 'chrome-headless-shell.exe' : 'chrome-headless-shell')
    accessSync(executable, platform.startsWith('win') ? constants.F_OK : constants.X_OK); return executable
  } catch { return undefined }
}
export async function installBrowserRuntime(root: string, options: { platform?: keyof typeof BROWSER_RELEASES; force?: boolean; progress?(message: string): void } = {}): Promise<string> {
  const platform = options.platform ?? browserPlatform()
  const folder = `chrome-headless-shell-${platform}`; const target = join(root, HEADLESS_CHROME_VERSION, platform)
  const executable = join(target, folder, platform.startsWith('win') ? 'chrome-headless-shell.exe' : 'chrome-headless-shell')
  const cached = cachedBrowserExecutable(root, platform); if (cached && !options.force) return cached
  options.progress?.('Downloading the Forge browser…')
  const staging = join(root, `.install-${randomUUID()}`); await mkdir(staging, { recursive: true, mode: 0o700 })
  await mkdir(join(root, HEADLESS_CHROME_VERSION), { recursive: true, mode: 0o700 })
  const archive = join(root, HEADLESS_CHROME_VERSION, `${platform}.zip`)
  try {
    try { await access(archive) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const response = await fetch(`https://storage.googleapis.com/chrome-for-testing-public/${HEADLESS_CHROME_VERSION}/${platform}/${folder}.zip`, { signal: AbortSignal.timeout(15 * 60 * 1000) })
      if (!response.ok || !response.body) throw new Error(`Browser download failed (${response.status}). Retry setup.`)
      let bytes = 0
      async function* bounded() { for await (const chunk of Readable.fromWeb(response.body! as Parameters<typeof Readable.fromWeb>[0])) { bytes += chunk.length; if (bytes > BROWSER_RELEASES[platform][0]) throw new Error('Browser archive exceeds its pinned length.'); yield chunk } }
      await writeFileAtomic(archive, bounded(), { mode: 0o600 })
    }
    const [length, sha256] = BROWSER_RELEASES[platform]; const hash = createHash('sha256'); let bytes = 0
    for await (const chunk of createReadStream(archive)) { bytes += chunk.length; hash.update(chunk) }
    if (bytes !== length || hash.digest('hex') !== sha256) { await rm(archive); throw new Error('Browser archive did not match its pinned SHA-256 and size.') }
    await extract(archive, { dir: staging })
    const binary = join(staging, folder, platform.startsWith('win') ? 'chrome-headless-shell.exe' : 'chrome-headless-shell')
    const executableSha256 = await runtimeFileHash(binary)
    await writeJsonFileAtomic(join(staging, 'integrity.json'), { version: HEADLESS_CHROME_VERSION, sha256: BROWSER_RELEASES[platform][1], executableSha256 }, { mode: 0o600 })
    if (!platform.startsWith('win')) await chmod(join(staging, folder, 'chrome-headless-shell'), 0o755)
    await mkdir(join(root, HEADLESS_CHROME_VERSION), { recursive: true, mode: 0o700 })
    // Concurrent environments may share only the binary cache, never profiles.
    // Atomically install the entire verified directory, including its executable and marker.
    // eslint-disable-next-line no-restricted-syntax
    try { await rename(staging, target) } catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; if (options.force || !cachedBrowserExecutable(root, platform)) { await rm(target, { recursive: true, force: true }); await rename(staging, target) } }
    return executable
  } finally { await rm(staging, { recursive: true, force: true }) }
}
