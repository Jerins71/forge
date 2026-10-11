import { randomUUID } from 'node:crypto'
import { loadState } from '../../environment/control/orchestration/store.js'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { createTestEnvironment } from '../../test-support/environment-auth.js'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { bootWithDefaultManager as bootLegacyManager, createTempConfig, TestSwarmManager } from '../../test-support/index.js'

// Actual manager, lifecycle, shutdown quarantine, admission and durable session store.
// Only the provider is substituted so failed/late cleanup can be reproduced reliably.
async function fixture() {
  const handle = await createTempConfig({ prefix: 'forge-stop-recovery-', omitSharedAuthFile: true, omitSharedSecretsFile: true })
  const manager = new TestSwarmManager(handle.config)
  const { environment, paired } = await bootWithDefaultManager(manager, handle.config)
  await manager.handleUserMessage('Original work', { targetAgentId: 'manager' })
  await vi.waitFor(() => expect(manager.runtimeByAgentId.get('manager')?.sendCalls).toHaveLength(1))
  const runtime = manager.runtimeByAgentId.get('manager')!
  runtime.terminateMutatesDescriptorStatus = false
  let clean = false
  const cleanup = vi.fn(async () => { if (!clean) throw new Error('Provider cleanup is still pending') })
  runtime.stopInFlight = cleanup
  runtime.terminate = cleanup
  runtime.providerAdapter.close = cleanup
  runtime.providerAdapter.drain = async () => ({ status: clean ? 'clean' : 'pending' })
  const stop = await environment.control.execute(paired.principal, 'session.stop', { commandId: randomUUID(), sessionId: 'manager' })
  await vi.waitFor(async () => expect(await environment.control.getReceipt(paired.principal, stop.commandId)).toMatchObject({ state: 'interrupted' }))
  expect(loadState(environment.database).threads.manager).toMatchObject({ desired: 'stopped', shutdown: 'quarantined' })
  await manager.stopAllAgents('manager', 'manager')
  expect(manager.getAgent('manager')?.status).toBe('stopped')
  return { ...handle, manager, environment, paired, runtime, cleanupAttempt: cleanup, settle: () => { clean = true } }
}

describe('Stopped session recovery acceptance', () => {
  it('recovers on new user input, rejects while cleanup is unsafe, and coalesces concurrent replacement creation', async () => {
    const f = await fixture()
    try {
      const before = await readFile(f.runtime.descriptor.sessionFile, 'utf8')
      await expect(f.manager.handleUserMessage('Unsafe retry', { targetAgentId: 'manager' })).rejects.toThrow(/shutdown|cleanup/i)
      expect(await readFile(f.runtime.descriptor.sessionFile, 'utf8')).toBe(before)
      expect(f.manager.runtimeCreationCountByAgentId.get('manager')).toBe(1)
      f.settle()
      const retryStop = await f.environment.control.execute(f.paired.principal, 'session.stop', { commandId: randomUUID(), sessionId: 'manager' })
      await vi.waitFor(async () => expect(await f.environment.control.getReceipt(f.paired.principal, retryStop.commandId)).toMatchObject({ state: 'succeeded' }))
      expect(loadState(f.environment.database).threads.manager.shutdown).toBe('clean')
      await Promise.all([
        f.manager.handleUserMessage('First new input', { targetAgentId: 'manager' }),
        f.manager.handleUserMessage('Second new input', { targetAgentId: 'manager' }),
      ])
      await vi.waitFor(() => expect(f.manager.runtimeByAgentId.get('manager')?.sendCalls).toHaveLength(2))
      expect(f.manager.runtimeCreationCountByAgentId.get('manager')).toBe(2)
      const replacement = f.manager.runtimeByAgentId.get('manager')!
      expect(replacement).not.toBe(f.runtime)
      expect(replacement.sendCalls).toHaveLength(2)
      expect((await readFile(f.runtime.descriptor.sessionFile, 'utf8')).startsWith(before)).toBe(true)
    } finally { f.settle(); await f.manager.stopSession('manager'); await f.environment.stop(); await f.cleanup() }
  })

})

async function bootWithDefaultManager(manager: TestSwarmManager, config: Parameters<typeof bootLegacyManager>[1]) {
  manager.onCreateRuntime = ({ runtime }) => {
    // Native writer initialization is a provider resource fact, before core transcript append.
    const native = (runtime as unknown as { sessionManager: SessionManager }).sessionManager
    native.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'fixture ready' }] } as never)
  }
  const { environment, paired } = await createTestEnvironment(manager, { boot: true })
  if (!manager.getAgent(config.managerId ?? 'manager')) {
    await manager.createManager(config.managerId ?? 'manager', { name: config.managerDisplayName ?? 'Manager', cwd: config.defaultCwd })
  }
  environment.start()
  await vi.waitFor(() => expect(Object.values(loadState(environment.database).runs).every(run => run.state === 'terminal')).toBe(true))
  const bootstrap = manager.runtimeByAgentId.get(config.managerId ?? 'manager')
  if (bootstrap) { bootstrap.sendCalls = []; bootstrap.nextDeliveryId = 0 }
  return { environment, paired }
}
