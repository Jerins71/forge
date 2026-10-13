import { execFile } from 'node:child_process'
import { accessSync, constants, lstatSync, readFileSync, readdirSync, type Stats } from 'node:fs'
import { chmod, chown, mkdir, readFile, readdir, lstat } from 'node:fs/promises'
import { posix } from 'node:path'
const { dirname, join, resolve, sep } = posix
import { promisify } from 'node:util'
import { writeFileAtomic } from '../../utils/atomic-files.js'
import { HEADLESS_CHROME_VERSION, BROWSER_RELEASES, browserPlatform, installBrowserRuntime, runtimeFileHash } from './browser-runtime.js'

export const BROWSER_HOST_SETUP_COMMAND = 'sudo forge browser setup'
export const FORGE_BROWSER_SYSTEM_ROOT = '/opt/forge/browser'
export const FORGE_BROWSER_APPARMOR_PATH = '/etc/apparmor.d/forge-chrome-headless-shell'
const linuxPlatform = () => process.arch === 'arm64' ? 'linux-arm64' as const : 'linux64' as const
export function systemBrowserExecutablePath(platform = linuxPlatform()): string {
  return join(FORGE_BROWSER_SYSTEM_ROOT, HEADLESS_CHROME_VERSION, platform, `chrome-headless-shell-${platform}`, 'chrome-headless-shell')
}
export const FORGE_BROWSER_APPARMOR_PROFILE = `abi <abi/4.0>,
include <tunables/global>
profile forge-chrome-headless-shell "${systemBrowserExecutablePath()}" flags=(unconfined) {
  userns,
  include if exists <local/forge-chrome-headless-shell>
}
`

type PathStat = Pick<Stats, 'uid' | 'gid' | 'mode' | 'isDirectory' | 'isFile' | 'isSymbolicLink'>
/** lstat every ancestor: a symlink or writable parent invalidates the attachment,
 * even if the final executable itself looks root-owned. Never repair an unsafe tree. */
export function assertRootOwnedPath(path: string, kind: 'file' | 'directory', inspect: (path: string) => PathStat = lstatSync): void {
  const absolute = resolve(path), parts = absolute.split(sep).filter(Boolean)
  let current: string = sep
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = join(current, parts[index]!)
    const stat = inspect(current)
    if (stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o022)) throw new Error(`Browser runtime must be root-owned with no group/other write or symlinks: ${current}`)
    const directory = index < parts.length - 1 || kind === 'directory'
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Browser runtime must be a ${directory ? 'directory' : 'regular file'}: ${current}`)
  }
}
function assertRootTree(path: string): void {
  const stat = lstatSync(path); assertRootOwnedPath(path, stat.isDirectory() ? 'directory' : 'file')
  if (stat.isDirectory()) for (const name of readdirSync(path)) assertRootTree(join(path, name))
}
/** A root-protected marker proves the archive provenance. Verify the executable's
 * digest before first launch as well, so corruption cannot masquerade as this pin. */
export function cachedSystemBrowserExecutable(): string | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    const platform = linuxPlatform(), executable = systemBrowserExecutablePath(platform), target = dirname(dirname(executable))
    assertRootTree(target)
    const marker = JSON.parse(readFileSync(join(target, 'integrity.json'), 'utf8')) as { version?: string; sha256?: string; executableSha256?: string }
    if (marker.version !== HEADLESS_CHROME_VERSION || marker.sha256 !== BROWSER_RELEASES[platform][1] || !/^[a-f0-9]{64}$/.test(marker.executableSha256 ?? '')) return undefined
    accessSync(executable, constants.X_OK); return executable
  } catch { return undefined }
}
export async function verifiedSystemBrowserExecutable(): Promise<string | undefined> {
  try {
    const executable = cachedSystemBrowserExecutable(); if (!executable) return undefined
    const marker = JSON.parse(await readFile(join(dirname(dirname(executable)), 'integrity.json'), 'utf8')) as { executableSha256: string }
    return await runtimeFileHash(executable) === marker.executableSha256 ? executable : undefined
  } catch { return undefined }
}
export function hasOlderSystemBrowser(): boolean {
  try { assertRootOwnedPath(FORGE_BROWSER_SYSTEM_ROOT, 'directory'); return readdirSync(FORGE_BROWSER_SYSTEM_ROOT).some(name => /^\d+\.\d+\.\d+\.\d+$/.test(name) && name !== HEADLESS_CHROME_VERSION) } catch { return false }
}
async function secureDirectory(path: string) {
  const parent = dirname(path); if (parent !== path) await secureDirectory(parent)
  try { assertRootOwnedPath(path, 'directory') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(path, { mode: 0o755 }); await chown(path, 0, 0); assertRootOwnedPath(path, 'directory')
  }
}
async function sealRuntime(path: string) {
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Browser runtime contains an unsupported file.')
  if (stat.isDirectory()) for (const name of await readdir(path)) await sealRuntime(join(path, name))
  await chown(path, 0, 0); await chmod(path, stat.isDirectory() || (stat.mode & 0o111) ? 0o755 : 0o644)
}
async function installSystemRuntime(): Promise<string> {
  const platform = browserPlatform(); if (platform !== 'linux64' && platform !== 'linux-arm64') throw new Error('System browser setup requires supported Linux architecture.')
  await secureDirectory(FORGE_BROWSER_SYSTEM_ROOT); await secureDirectory(join(FORGE_BROWSER_SYSTEM_ROOT, HEADLESS_CHROME_VERSION))
  const target = join(FORGE_BROWSER_SYSTEM_ROOT, HEADLESS_CHROME_VERSION, platform)
  try { assertRootTree(target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const existing = await verifiedSystemBrowserExecutable(); if (existing) return existing
  const executable = await installBrowserRuntime(FORGE_BROWSER_SYSTEM_ROOT, { platform, force: true })
  await sealRuntime(target); assertRootTree(target)
  if (await verifiedSystemBrowserExecutable() !== executable) throw new Error('System browser verification failed. Retry setup.')
  return executable
}
interface HostOperations {
  platform: NodeJS.Platform
  read(path: string): Promise<string>
  euid(): number | undefined
  installRuntime(): Promise<string>
  write(path: string, text: string): Promise<void>
  load(path: string): Promise<void>
}
const host: HostOperations = {
  platform: process.platform,
  read: path => readFile(path, 'utf8'),
  euid: () => process.geteuid?.(),
  installRuntime: installSystemRuntime,
  write: async (path, text) => {
    assertRootOwnedPath(dirname(path), 'directory')
    try { assertRootOwnedPath(path, 'file') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await writeFileAtomic(path, text, { mode: 0o644, createParentDir: false })
  },
  load: async path => { await promisify(execFile)('/usr/sbin/apparmor_parser', ['-r', path], { timeout: 30000 }) },
}
function restrictedUserNamespaces(apparmor: string, restriction: string) { return apparmor.trim() === 'Y' && restriction.trim() === '1' }
export function needsLinuxBrowserHostSetupSync(): boolean {
  if (process.platform !== 'linux') return false
  try { const enabled = readFileSync('/sys/module/apparmor/parameters/enabled', 'utf8'); return enabled.trim() === 'Y' && restrictedUserNamespaces(enabled, readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
export async function needsLinuxBrowserHostSetup(operations: Partial<HostOperations> = {}): Promise<boolean> {
  const system = { ...host, ...operations }
  if (system.platform !== 'linux') return false
  try { const enabled = await system.read('/sys/module/apparmor/parameters/enabled'); return enabled.trim() === 'Y' && restrictedUserNamespaces(enabled, await system.read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
export type BrowserHostSetupResult = { state: 'not-needed' | 'installed' } | { state: 'root-required'; command: string }
/** Install only verified root-owned code before granting its exact path userns.
 * This never changes kernel sysctls or disables Chromium's sandbox. */
export async function setupLinuxBrowserSandbox(operations: Partial<HostOperations> = {}): Promise<BrowserHostSetupResult> {
  const system = { ...host, ...operations }
  if (!await needsLinuxBrowserHostSetup(system)) return { state: 'not-needed' }
  if (system.euid() !== 0) return { state: 'root-required', command: BROWSER_HOST_SETUP_COMMAND }
  const executable = await system.installRuntime()
  if (executable !== systemBrowserExecutablePath()) throw new Error('Browser setup returned an unexpected system runtime path.')
  let existing: string | undefined
  try { existing = await system.read(FORGE_BROWSER_APPARMOR_PATH) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (existing !== FORGE_BROWSER_APPARMOR_PROFILE) await system.write(FORGE_BROWSER_APPARMOR_PATH, FORGE_BROWSER_APPARMOR_PROFILE)
  await system.load(FORGE_BROWSER_APPARMOR_PATH); return { state: 'installed' }
}
