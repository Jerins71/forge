import { describe, expect, it } from 'vitest'
import { createTempConfig, TestSwarmManager, bootWithDefaultManager } from '../../test-support/index.js';
import { AgentDescriptorStore } from "../agents/agent-descriptor-store.js";
import type { AgentDescriptor, SwarmConfig } from '../types.js'
import { SessionPlanStore } from '../planning/session-plan-store.js'
import {
  recordRecoveryFact,
  readRecoveryState,
  type RecoveryTarget,
} from '../recovery-state.js'

const NOW = '2026-07-13T12:00:00.000Z'

interface RecoveryFixture {
  cleanup: () => Promise<void>
  config: SwarmConfig
  target: RecoveryTarget
  workerId: string
}

async function createRecoveryFixture(options?: { withRunningGraph?: boolean }): Promise<RecoveryFixture> {
  const handle = await createTempConfig({
    prefix: 'swarm-manager-restart-recovery-',
    omitSharedAuthFile: true,
    omitSharedSecretsFile: true,
    skipRepoMemorySkillPlaceholder: true,
  })
  const manager = new TestSwarmManager(handle.config, { now: () => NOW })
  await bootWithDefaultManager(manager, handle.config)
  const worker = await manager.spawnAgent('manager', { agentId: 'Recovery Worker' })

  await persistAgentStatuses(handle.config, new Map([
    ['manager', 'streaming'],
    [worker.agentId, 'streaming'],
  ]))
  if (options?.withRunningGraph) {
    const planStore = new SessionPlanStore({
      dataDir: handle.config.paths.dataDir,
      profileId: 'manager',
      sessionAgentId: 'manager',
    })
    await planStore.update({
      coordinationMode: 'graph',
      plan: [{ step: 'Resume interrupted validation', status: 'in_progress' }],
      workGraph: {
        maxConcurrency: 1,
        nodes: [{
          id: 'validate',
          title: 'Resume interrupted validation',
          task: 'Finish the interrupted validation run.',
          kind: 'review',
          status: 'running',
          dependsOn: [],
          effort: 'routine',
          attempts: [{
            id: 'attempt-before-restart',
            number: 1,
            status: 'running',
            startedAt: NOW,
            behaviorMode: 'correctness-review',
            executionPolicy: 'routine',
            workerId: worker.agentId,
          }],
        }],
      },
    })
  }

  const target: RecoveryTarget = {
    dataDir: handle.config.paths.dataDir,
    profileId: 'manager',
    sessionAgentId: 'manager',
  }
  await recordRecoveryFact(target, {
    t: 'turn_dispatched',
    turnId: 'manager-turn-before-restart',
    agentId: 'manager',
    role: 'manager',
    kind: 'user',
    at: NOW,
  })
  await recordRecoveryFact(target, {
    t: 'turn_dispatched',
    turnId: 'worker-turn-before-restart',
    agentId: worker.agentId,
    role: 'worker',
    kind: 'agent_message',
    at: NOW,
  })

  return {
    cleanup: handle.cleanup,
    config: handle.config,
    target,
    workerId: worker.agentId,
  }
}

async function persistAgentStatuses(
  config: SwarmConfig,
  statuses: ReadonlyMap<string, AgentDescriptor['status']>,
): Promise<void> {
  const owner = new AgentDescriptorStore({ dataDir: config.paths.dataDir, storeFilePath: config.paths.agentsStoreFile });
  const store = await owner.load();
  store.agents = store.agents.map((agent) => {
    const status = statuses.get(agent.agentId)
    return status ? { ...agent, status, updatedAt: NOW } : agent
  })
  owner.replace(store); await owner.save();
}

describe('SwarmManager restart recovery characterization', () => {
  it('builds an isolated boot snapshot and records interrupted turns once', async () => {
    const fixture = await createRecoveryFixture()
    try {
      const recovered = new TestSwarmManager(fixture.config, { now: () => NOW })
      await recovered.boot()

      const snapshot = recovered.getRestartRecoverySnapshot()
      expect(snapshot).toEqual({
        recoveryId: expect.any(String),
        bootId: expect.any(String),
        createdAt: NOW,
        interruptedManagers: ['manager'],
        interruptedWorkers: [fixture.workerId],
        undeliveredReports: [],
      })

      snapshot!.interruptedManagers.push('mutated-manager')
      snapshot!.interruptedWorkers.length = 0
      expect(recovered.getRestartRecoverySnapshot()).toMatchObject({
        interruptedManagers: ['manager'],
        interruptedWorkers: [fixture.workerId],
        undeliveredReports: [],
      })

      const stateAfterFirstRecovery = await readRecoveryState(fixture.target);
      expect(stateAfterFirstRecovery.openTurns.has("manager-turn-before-restart")).toBe(true);
      expect(stateAfterFirstRecovery.openTurns.has("worker-turn-before-restart")).toBe(true);
      await persistAgentStatuses(fixture.config, new Map([
        ['manager', 'streaming'],
        [fixture.workerId, 'streaming'],
      ]))
      const recoveredAgain = new TestSwarmManager(fixture.config, { now: () => NOW })
      await recoveredAgain.boot()

      expect(recoveredAgain.getRestartRecoverySnapshot()?.bootId).toBe(snapshot!.bootId);
      expect((await readRecoveryState(fixture.target)).openTurns.has("worker-turn-before-restart")).toBe(true);

    } finally {
      await fixture.cleanup()
    }
  })
})
