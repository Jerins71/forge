import { writeFile } from 'node:fs/promises'
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
const RECOVERED_REPORT = 'Recovered worker result from the persisted ledger.'
const RECOVERED_DELIVERY_ID = 'worker-result:recovery-worker:persisted'

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
  await persistWorkerParentContext(handle.config, worker.agentId)
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
  await writeFile(handle.config.paths.agentsStoreFile + ".canonical-fixture.jsonl", JSON.stringify({ id: "fixture-result", data: { message: RECOVERED_REPORT } }) + "\n");
  await recordRecoveryFact(target, {
    t: 'delivery_pending',
    turnId: 'manager-turn-before-restart',
    deliveryId: RECOVERED_DELIVERY_ID,
    from: worker.agentId,
    to: 'manager',
    contentRef: { file: handle.config.paths.agentsStoreFile + ".canonical-fixture.jsonl", entryId: "fixture-result" },
    assignmentId: 'assignment:recovery-worker:persisted',
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

async function persistWorkerParentContext(
  config: SwarmConfig,
  workerId: string,
  assignmentId = 'assignment:recovery-worker:persisted',
): Promise<void> {
  const owner = new AgentDescriptorStore({ dataDir: config.paths.dataDir, storeFilePath: config.paths.agentsStoreFile });
  const store = await owner.load();
  store.agents = store.agents.map((agent) => agent.agentId === workerId
    ? {
        ...agent,
        workerParentContext: {
          schemaVersion: 1,
          assignmentId,
          managerId: 'manager',
          assignedAt: NOW,
          outputTarget: { kind: 'internal_only', reason: 'restart_recovery_test' },
        },
      }
    : agent)
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
        undeliveredReports: [{
          deliveryId: RECOVERED_DELIVERY_ID,
          fromAgentId: fixture.workerId,
          toAgentId: 'manager',
          turnId: 'manager-turn-before-restart',
          assignmentId: 'assignment:recovery-worker:persisted',
        }],
      })

      snapshot!.interruptedManagers.push('mutated-manager')
      snapshot!.interruptedWorkers.length = 0
      snapshot!.undeliveredReports[0]!.fromAgentId = 'mutated-worker'
      expect(recovered.getRestartRecoverySnapshot()).toMatchObject({
        interruptedManagers: ['manager'],
        interruptedWorkers: [fixture.workerId],
        undeliveredReports: [{ fromAgentId: fixture.workerId }],
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
