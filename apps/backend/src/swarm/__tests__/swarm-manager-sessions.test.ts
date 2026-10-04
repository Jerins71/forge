

import { describe, expect, it } from 'vitest';

import type { AgentDescriptor, SwarmConfig } from '../types.js';
import type { RuntimeCreationOptions, SwarmAgentRuntime } from '../runtime-contracts.js'
import { makeTempConfig as buildTempConfig } from '../../test-support/index.js'
import { FakeRuntime, TestSwarmManager as TestSwarmManagerBase, bootWithDefaultManager } from '../../test-support/index.js'

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
    await bootWithDefaultManager(manager, config)
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

    const rebooted = new TestSwarmManager(config)
    await bootWithDefaultManager(rebooted, config)
    await rebooted.handleUserMessage('Continue from durable state.', { targetAgentId: 'manager' })
    const runtimeText = rebooted.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message as string
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
