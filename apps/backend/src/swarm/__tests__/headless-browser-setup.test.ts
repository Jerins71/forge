/** Failure modes: AppArmor is mislabeled as download failure; Retry never probes
 * an already cached binary; retry disables the sandbox; unknown host errors hide. */
import { afterEach, expect, it, vi } from 'vitest'
import { chromium } from 'playwright-core'
import { HeadlessBrowser } from '../browser-automation/headless-browser.js'
import { needsLinuxBrowserHostSetup } from '../browser-automation/linux-browser-sandbox.js'
vi.mock('../browser-automation/linux-browser-sandbox.js', () => ({ BROWSER_HOST_SETUP_COMMAND: 'sudo forge browser setup', needsLinuxBrowserHostSetup: vi.fn() }))
afterEach(() => vi.restoreAllMocks())
it('settles setup as failed if host sandbox detection is unreadable', async () => {
  const browser = new HeadlessBrowser({ dataDir: '/unused-test-browser-setup' })
  vi.spyOn(browser, 'ensureExecutable').mockResolvedValue('/synthetic/chrome-headless-shell')
  vi.spyOn(chromium, 'launch').mockRejectedValue(new Error('sandbox failed'))
  vi.mocked(needsLinuxBrowserHostSetup).mockRejectedValue(new Error('host policy denied'))
  await expect(browser.prepare()).rejects.toThrow('host policy denied')
  expect(browser.state().browserEngineState).toBe('failed')
})
it('reports the exact host setup command and retries the sandbox with a cached executable', async () => {
  const browser = new HeadlessBrowser({ dataDir: '/unused-test-browser-setup' })
  vi.spyOn(browser, 'ensureExecutable').mockResolvedValue('/synthetic/chrome-headless-shell')
  vi.mocked(needsLinuxBrowserHostSetup).mockResolvedValue(true)
  const launch = vi.spyOn(chromium, 'launch').mockRejectedValue(new Error('sandbox: Operation not permitted'))
  await expect(browser.prepare()).rejects.toThrow('sudo forge browser setup')
  expect(browser.state()).toMatchObject({ browserEngineState: 'needs-host-setup', browserEngineSetupCommand: 'sudo forge browser setup', browserEngineMessage: expect.stringContaining('Do not substitute other browsers') })
  const close = vi.fn(async () => {})
  launch.mockResolvedValue({ close } as unknown as Awaited<ReturnType<typeof chromium.launch>>)
  await browser.prepare()
  expect(launch).toHaveBeenLastCalledWith(expect.objectContaining({ chromiumSandbox: true }))
  expect(close).toHaveBeenCalledOnce(); expect(browser.state()).toEqual({ browserEngineState: 'ready' })
})
