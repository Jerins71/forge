import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { writeFileAtomic } from '../../utils/atomic-files.js'

export const BROWSER_HOST_SETUP_COMMAND = 'sudo forge browser setup'
export const FORGE_BROWSER_APPARMOR_PATH = '/etc/apparmor.d/forge-chrome-headless-shell'
export const FORGE_BROWSER_APPARMOR_PROFILE = `abi <abi/4.0>,
include <tunables/global>
profile forge-chrome-headless-shell /**/runtimes/browser/*/linux*/chrome-headless-shell-linux*/chrome-headless-shell flags=(unconfined) {
  userns,
  include if exists <local/forge-chrome-headless-shell>
}
`

interface HostOperations {
  platform: NodeJS.Platform
  read(path: string): Promise<string>
  euid(): number | undefined
  write(path: string, text: string): Promise<void>
  load(path: string): Promise<void>
}
const host: HostOperations = {
  platform: process.platform,
  read: path => readFile(path, 'utf8'),
  euid: () => process.geteuid?.(),
  write: (path, text) => writeFileAtomic(path, text, { mode: 0o644, createParentDir: false }),
  load: async path => { await promisify(execFile)('apparmor_parser', ['-r', path], { timeout: 30000 }) },
}
/** Unknown permission failures surface instead of silently treating a restricted
 * host as supported. Missing kernel interfaces mean this policy is not needed. */
export async function needsLinuxBrowserHostSetup(operations: Partial<HostOperations> = {}): Promise<boolean> {
  const system = { ...host, ...operations }
  if (system.platform !== 'linux') return false
  try {
    return (await system.read('/sys/module/apparmor/parameters/enabled')).trim() === 'Y'
      && (await system.read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')).trim() === '1'
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
export type BrowserHostSetupResult = { state: 'not-needed' | 'installed' } | { state: 'root-required'; command: string }
/** This command changes only Forge's policy. It never changes kernel sysctls or
 * disables Chromium's sandbox. Reload even unchanged policy after a prior failure. */
export async function setupLinuxBrowserSandbox(operations: Partial<HostOperations> = {}): Promise<BrowserHostSetupResult> {
  const system = { ...host, ...operations }
  if (!await needsLinuxBrowserHostSetup(system)) return { state: 'not-needed' }
  if (system.euid() !== 0) return { state: 'root-required', command: BROWSER_HOST_SETUP_COMMAND }
  let existing: string | undefined
  try { existing = await system.read(FORGE_BROWSER_APPARMOR_PATH) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (existing !== FORGE_BROWSER_APPARMOR_PROFILE) await system.write(FORGE_BROWSER_APPARMOR_PATH, FORGE_BROWSER_APPARMOR_PROFILE)
  await system.load(FORGE_BROWSER_APPARMOR_PATH)
  return { state: 'installed' }
}
