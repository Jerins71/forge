/** Failure modes: a different OS is modified; disabled AppArmor triggers setup;
 * non-root writes policy; policy grants unrelated binaries; a retry skips loading;
 * parser failure reports success. All host operations below are injected. */
import { describe, expect, it, vi } from 'vitest'
import { FORGE_BROWSER_APPARMOR_PROFILE, FORGE_BROWSER_APPARMOR_PATH, BROWSER_HOST_SETUP_COMMAND, needsLinuxBrowserHostSetup, setupLinuxBrowserSandbox, assertRootOwnedPath, FORGE_BROWSER_SYSTEM_ROOT, systemBrowserExecutablePath } from '../browser-automation/linux-browser-sandbox.js'

function restricted() {
  return { platform: 'linux' as NodeJS.Platform, read: vi.fn(async (path: string) => path.includes('/sys/module/') ? 'Y\n' : path.includes('/proc/sys/') ? '1\n' : FORGE_BROWSER_APPARMOR_PROFILE), euid: () => 0, installRuntime: vi.fn(async () => systemBrowserExecutablePath()), write: vi.fn(async () => {}), load: vi.fn(async () => {}) }
}
describe('Linux browser sandbox host setup', () => {
  it('limits the userns grant to Forge runtime binaries and preserves local policy', () => {
    expect(FORGE_BROWSER_APPARMOR_PROFILE).toContain('/opt/forge/browser/154.0.8037.92/')
    expect(FORGE_BROWSER_APPARMOR_PROFILE).not.toContain('*')
    expect(FORGE_BROWSER_APPARMOR_PROFILE).toContain('include if exists <local/forge-chrome-headless-shell>')
    expect(FORGE_BROWSER_SYSTEM_ROOT).toBe('/opt/forge/browser')
    expect(FORGE_BROWSER_APPARMOR_PATH).toBe('/etc/apparmor.d/forge-chrome-headless-shell')
    expect(BROWSER_HOST_SETUP_COMMAND).toBe('sudo forge browser setup')
  })
  // Root path failures: owner/group can replace code; writable ancestors can
  // swap a directory; symlinks escape the validated tree; special files fake a binary.
  it('requires root ownership and non-writable ancestors including the executable', () => {
    const path = '/opt/forge/browser/154.0.8037.92/linux64/chrome-headless-shell-linux64/chrome-headless-shell'
    const inspect = (bad?: string, change: object = {}) => (candidate: string) => ({ uid: 0, gid: 0, mode: 0o755, isDirectory: () => candidate !== path, isFile: () => candidate === path, isSymbolicLink: () => false, ...(candidate === bad ? change : {}) })
    expect(() => assertRootOwnedPath(path, 'file', inspect())).not.toThrow()
    for (const candidate of ['/', '/opt', '/opt/forge', '/opt/forge/browser', '/opt/forge/browser/154.0.8037.92', path]) {
      for (const change of [{ uid: 1000 }, { gid: 1000 }, { mode: 0o775 }, { mode: 0o777 }, { isSymbolicLink: () => true }]) expect(() => assertRootOwnedPath(path, 'file', inspect(candidate, change))).toThrow('root-owned')
    }
    expect(() => assertRootOwnedPath(path, 'file', inspect(path, { isFile: () => false }))).toThrow('regular file')
    expect(() => assertRootOwnedPath(path, 'file', inspect('/opt', { isDirectory: () => false }))).toThrow('directory')
  })
  it('does not attach policy when installing or verifying the runtime fails', async () => {
    const options = { ...restricted(), installRuntime: vi.fn(async () => { throw new Error('unsafe runtime') }) }
    await expect(setupLinuxBrowserSandbox(options)).rejects.toThrow('unsafe runtime')
    expect(options.write).not.toHaveBeenCalled(); expect(options.load).not.toHaveBeenCalled()
  })
  it('detects enabled AppArmor and the userns restriction together', async () => {
    expect(await needsLinuxBrowserHostSetup(restricted())).toBe(true)
    for (const value of ['0\n', 'N\n', '']) expect(await needsLinuxBrowserHostSetup({ ...restricted(), read: async () => value })).toBe(false)
    for (const platform of ['darwin', 'win32'] as const) { const options = { ...restricted(), platform }; expect(await needsLinuxBrowserHostSetup(options)).toBe(false); expect(options.read).not.toHaveBeenCalled() }
    expect(await needsLinuxBrowserHostSetup({ ...restricted(), read: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }) } })).toBe(false)
  })
  it('does not read a restricted sysctl when AppArmor is disabled', async () => {
    expect(await needsLinuxBrowserHostSetup({ ...restricted(), read: async path => {
      if (path.includes('/sys/module/')) return 'N'
      throw Object.assign(new Error('unreadable unused sysctl'), { code: 'EACCES' })
    } })).toBe(false)
  })
  it('refuses non-root before any policy writes or loads', async () => {
    const options = { ...restricted(), euid: () => 1000 }
    expect(await setupLinuxBrowserSandbox(options)).toEqual({ state: 'root-required', command: BROWSER_HOST_SETUP_COMMAND })
    expect(options.installRuntime).not.toHaveBeenCalled(); expect(options.write).not.toHaveBeenCalled(); expect(options.load).not.toHaveBeenCalled()
  })
  it('writes a missing policy and reloads it on every idempotent retry', async () => {
    const options = restricted()
    options.read.mockImplementation(async path => { if (path === FORGE_BROWSER_APPARMOR_PATH) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return path.includes('/sys/module/') ? 'Y' : '1' })
    expect(await setupLinuxBrowserSandbox(options)).toEqual({ state: 'installed' })
    expect(options.installRuntime).toHaveBeenCalled()
    expect(options.installRuntime.mock.invocationCallOrder[0]).toBeLessThan(options.write.mock.invocationCallOrder[0]!)
    expect(options.write).toHaveBeenCalledWith(FORGE_BROWSER_APPARMOR_PATH, FORGE_BROWSER_APPARMOR_PROFILE)
    expect(options.load).toHaveBeenCalledWith(FORGE_BROWSER_APPARMOR_PATH)
    options.read.mockImplementation(restricted().read)
    await setupLinuxBrowserSandbox(options)
    expect(options.write).toHaveBeenCalledTimes(1); expect(options.load).toHaveBeenCalledTimes(2)
  })
  it('is a no-op elsewhere and surfaces detection and parser errors', async () => {
    const options = { ...restricted(), platform: 'darwin' as NodeJS.Platform }
    expect(await setupLinuxBrowserSandbox(options)).toEqual({ state: 'not-needed' })
    expect(options.installRuntime).not.toHaveBeenCalled(); expect(options.write).not.toHaveBeenCalled(); expect(options.load).not.toHaveBeenCalled()
    await expect(needsLinuxBrowserHostSetup({ ...restricted(), read: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } })).rejects.toThrow('denied')
    await expect(setupLinuxBrowserSandbox({ ...restricted(), load: async () => { throw new Error('parser failed') } })).rejects.toThrow('parser failed')
  })
})
