import { loadState } from '../../environment/control/orchestration/store.js'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { createTestEnvironment } from '../../test-support/environment-auth.js'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { bootWithDefaultManager as bootLegacyManager, createTempConfig, TestSwarmManager } from '../../test-support/index.js'

// Real manager, dispatcher, and durable agents store; only the provider runtime is faked.
// Failure modes covered:
// - peer messages stay anonymous, so the referenced session cannot identify or answer the sender
// - the referencing session is not told the referenced agent id
// - the referenced session cannot reply to the referencing session
// - the link is lost across a restart
// - self, unknown, and worker ids are silently turned into links
async function fixture() {
  const handle = await createTempConfig({ prefix: 'forge-session-references-', omitSharedAuthFile: true, omitSharedSecretsFile: true })
  const manager = new TestSwarmManager(handle.config)
  const environment = await bootWithDefaultManager(manager, handle.config)
  const otherCwd = join(handle.config.defaultCwd, 'other-project')
  await mkdir(otherCwd, { recursive: true })
  const other = await manager.createManager('manager', { name: 'Other Project', cwd: otherCwd })
  return { ...handle, manager, environment, otherAgentId: other.agentId }
}

function lastRuntimeText(manager: TestSwarmManager, agentId: string): string {
  const calls = manager.runtimeByAgentId.get(agentId)?.sendCalls ?? []
  const last = calls.at(-1)?.message
  return typeof last === 'string' ? last : last?.text ?? ''
}

describe('Session references acceptance', () => {
  it('lets a referenced session in another project and the referencing session message each other', async () => {
    const f = await fixture()
    try {
      // Without a reference the recipient gets an anonymous internal message it cannot reply to.
      await f.manager.sendMessage('manager', f.otherAgentId, 'unreferenced', 'auto')
      await vi.waitFor(() => expect(lastRuntimeText(f.manager, f.otherAgentId)).toContain('unreferenced'))
      expect(lastRuntimeText(f.manager, f.otherAgentId)).not.toContain('[projectAgentContext]')

      await f.manager.handleUserMessage('Ask [@Other Project] about the API', {
        targetAgentId: 'manager',
        sessionReferenceAgentIds: [f.otherAgentId, 'manager', 'missing-session'],
      })
      await vi.waitFor(() => expect(lastRuntimeText(f.manager, 'manager')).toContain('[sessionReferences]'))
      const guidance = lastRuntimeText(f.manager, 'manager')
      expect(guidance).toContain('[sessionReferences]')
      expect(guidance).toContain(f.otherAgentId)
      expect(guidance).toContain('Other Project')
      expect(guidance).not.toContain('missing-session')

      await f.manager.sendMessage('manager', f.otherAgentId, 'What is the API shape?', 'auto')
      await vi.waitFor(() => expect(lastRuntimeText(f.manager, f.otherAgentId)).toContain('What is the API shape?'))
      const inbound = lastRuntimeText(f.manager, f.otherAgentId)
      expect(inbound).toContain('[projectAgentContext]')
      expect(inbound).toContain('"fromAgentId":"manager"')
      expect(inbound).toContain('"external":false')
      expect(inbound).toContain('What is the API shape?')

      await f.manager.sendMessage(f.otherAgentId, 'manager', 'It is REST.', 'auto')
      await vi.waitFor(() => expect(lastRuntimeText(f.manager, 'manager')).toContain('It is REST.'))
      expect(lastRuntimeText(f.manager, 'manager')).toContain('It is REST.')
      // Peer links stay private to the backend; public snapshots never carry them.
      expect(f.manager.getAgent('manager')?.sessionReferenceAgentIds).toBeUndefined()

      await f.manager.stopSession('manager')
      await f.manager.stopSession(f.otherAgentId)
      await f.environment.stop()
      const rebooted = new TestSwarmManager(f.config)
      const reopened = await bootWithDefaultManager(rebooted, f.config)
      await rebooted.sendMessage(f.otherAgentId, 'manager', 'Still linked after restart', 'auto')
      await vi.waitFor(() => expect(lastRuntimeText(rebooted, 'manager')).toContain('Still linked after restart'))
      expect(lastRuntimeText(rebooted, 'manager')).toContain('Still linked after restart')
      await reopened.stop()
      await rebooted.disposeHistoryRecall()
    } finally {
      await f.environment.stop()
      await f.manager.disposeHistoryRecall()
      await f.cleanup()
    }
  })
})

async function bootWithDefaultManager(manager: TestSwarmManager, config: Parameters<typeof bootLegacyManager>[1]) {
  manager.onCreateRuntime = ({ runtime }) => {
    // Native writer initialization is a provider resource fact, before core transcript append.
    const native = (runtime as unknown as { sessionManager: SessionManager }).sessionManager
    native.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'fixture ready' }] } as never)
  }
  const { environment } = await createTestEnvironment(manager, { boot: true })
  if (!manager.getAgent(config.managerId ?? 'manager')) {
    await manager.createManager(config.managerId ?? 'manager', { name: config.managerDisplayName ?? 'Manager', cwd: config.defaultCwd })
  }
  environment.start()
  await vi.waitFor(() => expect(Object.values(loadState(environment.database).runs).every(run => run.state === 'terminal')).toBe(true))
  const bootstrap = manager.runtimeByAgentId.get(config.managerId ?? 'manager')
  if (bootstrap) { bootstrap.sendCalls = []; bootstrap.nextDeliveryId = 0 }
  return environment
}
