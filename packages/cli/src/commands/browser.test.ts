/** Failure modes: root-required exits zero; setup needs pairing; unknown subcommand
 * touches host policy; a no-op is unclear. Host policy is mocked, never installed. */
import { expect, it, vi } from 'vitest'
import { setupLinuxBrowserSandbox } from '../../../../apps/backend/src/swarm/browser-automation/linux-browser-sandbox.js'
import { runCli } from './index.js'
vi.mock('../../../../apps/backend/src/swarm/browser-automation/linux-browser-sandbox.js', () => ({ setupLinuxBrowserSandbox: vi.fn() }))

it.each(['root-required', 'installed', 'not-needed'] as const)('runs browser setup without pairing: %s', async state => {
  vi.mocked(setupLinuxBrowserSandbox).mockResolvedValue(state === 'root-required' ? { state, command: 'sudo forge browser setup' } : { state })
  const stdout: string[] = [], stderr: string[] = []
  const io = { stdout: { write: (text: string) => { stdout.push(text); return true } }, stderr: { write: (text: string) => { stderr.push(text); return true } } } as Parameters<typeof runCli>[1]['io']
  const createClient = vi.fn()
  const exit = await runCli(['browser', 'setup'], { io, createClient })
  expect(typeof exit).toBe('number')
  expect(exit === 0).toBe(state !== 'root-required')
  expect(createClient).not.toHaveBeenCalled()
  expect(stdout.join('') + stderr.join('')).toContain(state === 'root-required' ? 'sudo forge browser setup' : state === 'installed' ? 'sandbox remains enabled' : 'No host setup is needed')
})
