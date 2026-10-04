import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { bootWithDefaultManager, createTempConfig, TestSwarmManager } from '../../test-support/index.js'

// Actual manager, lifecycle, shutdown quarantine, admission and durable session store.
// Only the provider is substituted so failed/late cleanup can be reproduced reliably.
async function fixture() {
  const handle = await createTempConfig({ prefix: 'forge-stop-recovery-', omitSharedAuthFile: true, omitSharedSecretsFile: true })
  const manager = new TestSwarmManager(handle.config)
  await bootWithDefaultManager(manager, handle.config)
  await manager.handleUserMessage('Original work', { targetAgentId: 'manager' })
  const runtime = manager.runtimeByAgentId.get('manager')!
  runtime.terminateMutatesDescriptorStatus = false
  let clean = false
  const cleanup = vi.fn(async () => { if (!clean) throw new Error('Provider cleanup is still pending') })
  runtime.stopInFlight = cleanup
  runtime.terminate = cleanup
  await manager.stopAllAgents('manager', 'manager')
  expect(manager.getAgent('manager')?.status).toBe('stopped')
  return { ...handle, manager, runtime, cleanupAttempt: cleanup, settle: () => { clean = true } }
}

describe('Stopped session recovery acceptance', () => {
  it('recovers on new user input, rejects while cleanup is unsafe, and coalesces concurrent replacement creation', async () => {
    const f = await fixture()
    try {
      const before = await readFile(f.runtime.descriptor.sessionFile, 'utf8')
      await expect(f.manager.handleUserMessage('Unsafe retry', { targetAgentId: 'manager' })).rejects.toThrow('cleanup')
      expect(await readFile(f.runtime.descriptor.sessionFile, 'utf8')).toBe(before)
      expect(f.manager.runtimeCreationCountByAgentId.get('manager')).toBe(1)
      f.settle()
      await Promise.all([
        f.manager.handleUserMessage('First new input', { targetAgentId: 'manager' }),
        f.manager.handleUserMessage('Second new input', { targetAgentId: 'manager' }),
      ])
      expect(f.manager.runtimeCreationCountByAgentId.get('manager')).toBe(2)
      const replacement = f.manager.runtimeByAgentId.get('manager')!
      expect(replacement).not.toBe(f.runtime)
      expect(replacement.sendCalls).toHaveLength(2)
      expect((await readFile(f.runtime.descriptor.sessionFile, 'utf8')).startsWith(before)).toBe(true)
    } finally { f.settle(); await f.manager.stopSession('manager'); await f.cleanup() }
  })

})
