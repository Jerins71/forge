import { loadState } from '../../environment/control/orchestration/store.js'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { createTestEnvironment } from '../../test-support/environment-auth.js'


import { describe, expect, it, vi } from 'vitest';

import type { AgentDescriptor, SwarmConfig } from '../types.js';
import type { RuntimeCreationOptions, SwarmAgentRuntime } from '../runtime-contracts.js'
import { makeTempConfig as buildTempConfig } from '../../test-support/index.js'
import { FakeRuntime, TestSwarmManager as TestSwarmManagerBase, bootWithDefaultManager as bootLegacyManager } from '../../test-support/index.js'

class TestSwarmManager extends TestSwarmManagerBase {
  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime> {
    const runtime = await super.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options)
    ;(runtime as FakeRuntime).terminateMutatesDescriptorStatus = false
    return runtime
  }
}

async function makeTempConfig(port = 8790): Promise<SwarmConfig> {
  return buildTempConfig({
    prefix: 'swarm-manager-test-',
    port,
    omitSharedAuthFile: true,
    omitSharedSecretsFile: true,
    skipRepoMemorySkillPlaceholder: true,
  })
}

describe('SwarmManager', () => {
  it('rehydrates work graph and active goal context through compaction and restart', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const environment = await bootWithDefaultManager(manager, config)
    await manager.createGoal('manager', 'goal-continuity', {
      objective: 'Preserve the durable objective',
    })
    await manager.updateWorkGraph('manager', 'graph-continuity', {
      explanation: 'A user decision gates the next graph outcome.',
      nodes: [{
        id: 'decision',
        title: 'Confirm the next outcome',
        task: 'Wait for the user decision before continuing.',
        kind: 'decision',
        status: 'waiting',
      }],
    })

    await manager.compactAgentContext('manager')
    const compactInstructions = manager.runtimeByAgentId.get('manager')?.compactCalls.at(-1) as string
    expect(compactInstructions).toContain('[workingPlan] {"revision":1')
    expect(compactInstructions).toContain('"coordinationMode":"graph"')
    expect(compactInstructions).toContain('"id":"decision"')
    expect(compactInstructions).toContain('[activeGoal] {"revision":1')
    expect(compactInstructions).toContain('"objective":"Preserve the durable objective"')

    await manager.stopSession('manager')
    await environment.stop()
    const rebooted = new TestSwarmManager(config)
    await bootWithDefaultManager(rebooted, config)
    await rebooted.handleUserMessage('Continue from durable state.', { targetAgentId: 'manager' })
    await vi.waitFor(() => expect(rebooted.runtimeByAgentId.get('manager')?.sendCalls).toHaveLength(1))
    const sent = rebooted.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    const runtimeText = typeof sent === 'string' ? sent : sent?.text ?? ''
    expect(runtimeText).toContain('[workingPlan] {"revision":1')
    expect(runtimeText).toContain('"coordinationMode":"graph"')
    expect(runtimeText).toContain('"id":"decision"')
    expect(runtimeText).toContain('[activeGoal] {"revision":2')
    expect(runtimeText).toContain('"objective":"Preserve the durable objective"')
    await expect(rebooted.getSessionPlanSnapshot('manager')).resolves.toMatchObject({
      revision: 1,
      coordinationMode: 'graph',
      workGraph: { nodes: [{ id: 'decision', status: 'waiting' }] },
    })
    await expect(rebooted.getSessionGoalSnapshot('manager')).resolves.toMatchObject({
      revision: 2,
      goal: { objective: 'Preserve the durable objective', status: 'active' },
    })
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
