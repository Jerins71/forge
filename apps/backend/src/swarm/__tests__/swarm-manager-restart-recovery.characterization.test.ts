import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createTempConfig, TestSwarmManager, bootWithDefaultManager } from '../../test-support/index.js';
import type { AgentDescriptor, SwarmConfig } from '../types.js'
import { SessionPlanStore } from '../planning/session-plan-store.js'
import {
  appendTurnLedgerRecord,
  replayTurnLedger,
  type TurnLedgerSessionTarget,
} from '../turn-ledger.js'

const NOW = '2026-07-13T12:00:00.000Z'
const RECOVERED_REPORT = 'Recovered worker result from the persisted ledger.'
const RECOVERED_DELIVERY_ID = 'worker-result:recovery-worker:persisted'

interface RecoveryFixture {
  cleanup: () => Promise<void>
  config: SwarmConfig
  target: TurnLedgerSessionTarget
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

  const target: TurnLedgerSessionTarget = {
    dataDir: handle.config.paths.dataDir,
    profileId: 'manager',
    sessionAgentId: 'manager',
  }
  await appendTurnLedgerRecord(target, {
    t: 'turn_dispatched',
    turnId: 'manager-turn-before-restart',
    agentId: 'manager',
    role: 'manager',
    kind: 'user',
    at: NOW,
  })
  await appendTurnLedgerRecord(target, {
    t: 'turn_dispatched',
    turnId: 'worker-turn-before-restart',
    agentId: worker.agentId,
    role: 'worker',
    kind: 'agent_message',
    at: NOW,
  })
  await appendTurnLedgerRecord(target, {
    t: 'delivery_pending',
    turnId: 'manager-turn-before-restart',
    deliveryId: RECOVERED_DELIVERY_ID,
    from: worker.agentId,
    to: 'manager',
    message: RECOVERED_REPORT,
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
  const store = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
    agents: AgentDescriptor[]
    profiles?: unknown[]
  }
  store.agents = store.agents.map((agent) => {
    const status = statuses.get(agent.agentId)
    return status ? { ...agent, status, updatedAt: NOW } : agent
  })
  await writeFile(config.paths.agentsStoreFile, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

async function persistWorkerParentContext(
  config: SwarmConfig,
  workerId: string,
  assignmentId = 'assignment:recovery-worker:persisted',
): Promise<void> {
  const store = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
    agents: AgentDescriptor[]
    profiles?: unknown[]
  }
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
  await writeFile(config.paths.agentsStoreFile, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

describe('SwarmManager restart recovery characterization', () => {
  it('builds an isolated boot snapshot and records interrupted turns once', async () => {
    const fixture = await createRecoveryFixture()
    try {
      const recovered = new TestSwarmManager(fixture.config, { now: () => NOW })
      await recovered.boot()

      const snapshot = recovered.getRestartRecoverySnapshot()
      expect(snapshot).toEqual({
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

      const ledgerAfterFirstRecovery = await replayTurnLedger(fixture.target)
      const seededInterruptedReceipts = ledgerAfterFirstRecovery.records.filter(
        (record) => record.t === 'recovery_receipt'
          && record.receipt === 'turn_interrupted'
          && (record.turnId === 'manager-turn-before-restart' || record.turnId === 'worker-turn-before-restart'),
      )
      expect(seededInterruptedReceipts).toHaveLength(2)

      await persistAgentStatuses(fixture.config, new Map([
        ['manager', 'streaming'],
        [fixture.workerId, 'streaming'],
      ]))
      const recoveredAgain = new TestSwarmManager(fixture.config, { now: () => NOW })
      await recoveredAgain.boot()

      const ledgerAfterSecondRecovery = await replayTurnLedger(fixture.target)
      expect(ledgerAfterSecondRecovery.records.filter(
        (record) => record.t === 'recovery_receipt'
          && record.receipt === 'turn_interrupted'
          && (record.turnId === 'manager-turn-before-restart' || record.turnId === 'worker-turn-before-restart'),
      )).toHaveLength(2)
    } finally {
      await fixture.cleanup()
    }
  })
})
