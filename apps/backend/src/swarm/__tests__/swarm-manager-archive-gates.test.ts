import { loadState } from '../../environment/control/orchestration/store.js'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { createTestEnvironment } from '../../test-support/environment-auth.js'
import { describe, expect, it, vi } from 'vitest'
import { makeTempConfig as buildTempConfig, TestSwarmManager, bootWithDefaultManager as bootLegacyManager } from '../../test-support/index.js'
import type { SwarmConfig } from '../types.js'

async function makeTempConfig(port = 8791): Promise<SwarmConfig> {
  return buildTempConfig({
    prefix: 'swarm-manager-archive-gates-',
    port,
    omitSharedAuthFile: true,
    omitSharedSecretsFile: true,
    skipRepoMemorySkillPlaceholder: true,
  })
}

describe('SwarmManager archive gates', () => {
  it('blocks user/runtime/message operations for directly archived sessions', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const created = await manager.createSession('manager', { label: 'Archived session' })

    await manager.archiveSession(created.sessionAgent.agentId)

    await expect(manager.handleUserMessage('hello archived session', {
      targetAgentId: created.sessionAgent.agentId,
    })).rejects.toThrow("Archived sessions can’t be used until restored.")
    await expect(manager.resumeSession(created.sessionAgent.agentId)).rejects.toThrow(
      "Archived sessions can’t be used until restored.",
    )
    await expect(manager.sendMessage('manager', created.sessionAgent.agentId, 'ping', 'auto')).rejects.toThrow(
      "Archived sessions can’t be used until restored.",
    )
    await expect(manager.pinMessage(created.sessionAgent.agentId, 'missing-message', false)).rejects.toThrow(
      "Archived sessions can’t be used until restored.",
    )
    await expect(manager.clearAllPins(created.sessionAgent.agentId)).rejects.toThrow(
      "Archived sessions can’t be used until restored.",
    )
    await expect(manager.clearSessionConversation(created.sessionAgent.agentId)).rejects.toThrow(
      "Archived sessions can’t be used until restored.",
    )

    await manager.restoreSession(created.sessionAgent.agentId)
    await expect(manager.handleUserMessage('hello restored session', {
      targetAgentId: created.sessionAgent.agentId,
    })).resolves.toBeUndefined()
    await vi.waitFor(() => expect(manager.runtimeByAgentId.get(created.sessionAgent.agentId)?.sendCalls).toHaveLength(1))
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
  return environment
}
