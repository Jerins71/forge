/** Failure modes: a different OS is modified; disabled AppArmor triggers setup;
 * non-root writes policy; policy grants unrelated binaries; a retry skips loading;
 * parser failure reports success. All host operations below are injected. */
import { describe, expect, it, vi } from 'vitest'
import { FORGE_BROWSER_APPARMOR_PROFILE, FORGE_BROWSER_APPARMOR_PATH, BROWSER_HOST_SETUP_COMMAND, needsLinuxBrowserHostSetup, setupLinuxBrowserSandbox } from '../browser-automation/linux-browser-sandbox.js'

function restricted() {
  return { platform: 'linux' as NodeJS.Platform, read: vi.fn(async (path: string) => path.includes('/sys/module/') ? 'Y\n' : path.includes('/proc/sys/') ? '1\n' : FORGE_BROWSER_APPARMOR_PROFILE), euid: () => 0, write: vi.fn(async () => {}), load: vi.fn(async () => {}) }
}
describe('Linux browser sandbox host setup', () => {
  it('limits the userns grant to Forge runtime binaries and preserves local policy', () => {
    expect(FORGE_BROWSER_APPARMOR_PROFILE).toBe('abi <abi/4.0>,\ninclude <tunables/global>\nprofile forge-chrome-headless-shell /**/runtimes/browser/*/linux*/chrome-headless-shell-linux*/chrome-headless-shell flags=(unconfined) {\n  userns,\n  include if exists <local/forge-chrome-headless-shell>\n}\n')
    expect(FORGE_BROWSER_APPARMOR_PATH).toBe('/etc/apparmor.d/forge-chrome-headless-shell')
    expect(BROWSER_HOST_SETUP_COMMAND).toBe('sudo forge browser setup')
  })
  it('detects enabled AppArmor and the userns restriction together', async () => {
    expect(await needsLinuxBrowserHostSetup(restricted())).toBe(true)
    for (const value of ['0\n', 'N\n', '']) expect(await needsLinuxBrowserHostSetup({ ...restricted(), read: async () => value })).toBe(false)
    for (const platform of ['darwin', 'win32'] as const) { const options = { ...restricted(), platform }; expect(await needsLinuxBrowserHostSetup(options)).toBe(false); expect(options.read).not.toHaveBeenCalled() }
    expect(await needsLinuxBrowserHostSetup({ ...restricted(), read: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }) } })).toBe(false)
  })
  it('refuses non-root before any policy writes or loads', async () => {
    const options = { ...restricted(), euid: () => 1000 }
    expect(await setupLinuxBrowserSandbox(options)).toEqual({ state: 'root-required', command: BROWSER_HOST_SETUP_COMMAND })
    expect(options.write).not.toHaveBeenCalled(); expect(options.load).not.toHaveBeenCalled()
  })
  it('writes a missing policy and reloads it on every idempotent retry', async () => {
    const options = restricted()
    options.read.mockImplementation(async path => { if (path === FORGE_BROWSER_APPARMOR_PATH) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return path.includes('/sys/module/') ? 'Y' : '1' })
    expect(await setupLinuxBrowserSandbox(options)).toEqual({ state: 'installed' })
    expect(options.write).toHaveBeenCalledWith(FORGE_BROWSER_APPARMOR_PATH, FORGE_BROWSER_APPARMOR_PROFILE)
    expect(options.load).toHaveBeenCalledWith(FORGE_BROWSER_APPARMOR_PATH)
    options.read.mockImplementation(restricted().read)
    await setupLinuxBrowserSandbox(options)
    expect(options.write).toHaveBeenCalledTimes(1); expect(options.load).toHaveBeenCalledTimes(2)
  })
  it('is a no-op elsewhere and surfaces detection and parser errors', async () => {
    const options = { ...restricted(), platform: 'darwin' as NodeJS.Platform }
    expect(await setupLinuxBrowserSandbox(options)).toEqual({ state: 'not-needed' })
    expect(options.write).not.toHaveBeenCalled(); expect(options.load).not.toHaveBeenCalled()
    await expect(needsLinuxBrowserHostSetup({ ...restricted(), read: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } })).rejects.toThrow('denied')
    await expect(setupLinuxBrowserSandbox({ ...restricted(), load: async () => { throw new Error('parser failed') } })).rejects.toThrow('parser failed')
  })
})
