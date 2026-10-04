import { readFile, writeFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest'

import { getProfileMemoryPath, getProfileMergeAuditLogPath, getRootSessionMemoryPath, getSessionMemoryPath } from '../data-paths.js';
import { makeTempConfig as buildTempConfig } from '../../test-support/index.js'
const memoryMergeMockState = vi.hoisted(() => ({
  executeLLMMerge: vi.fn(async (..._args: any[]) => '# Swarm Memory\n\n## Decisions\n- merged by mock\n'),
}))
const projectAgentAnalysisMockState = vi.hoisted(() => ({
  analyzeSessionForPromotion: vi.fn(async (..._args: any[]) => ({
    whenToUse: 'Use for release coordination.',
    systemPrompt: 'You are the release coordination manager.',
  })),
}))

vi.mock('../prompts/memory-merge.js', async () => {
  const actual = await vi.importActual<typeof import('../prompts/memory-merge.js')>('../prompts/memory-merge.js')
  return {
    ...actual,
    executeLLMMerge: (...args: Parameters<typeof actual.executeLLMMerge>) =>
      memoryMergeMockState.executeLLMMerge(...args),
  }
})

vi.mock('../agents/project-agent-analysis.js', async () => {
  const actual = await vi.importActual<typeof import('../agents/project-agent-analysis.js')>('../agents/project-agent-analysis.js')
  return {
    ...actual,
    analyzeSessionForPromotion: (...args: Parameters<typeof actual.analyzeSessionForPromotion>) =>
      projectAgentAnalysisMockState.analyzeSessionForPromotion(...args),
  }
})

import { readSessionMeta } from '../session/session-manifest.js';

import type { AgentDescriptor, SwarmConfig } from '../types.js';
import type { RuntimeCreationOptions, SwarmAgentRuntime } from '../runtime-contracts.js';
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

class MergeEnabledTestSwarmManager extends TestSwarmManager {
  protected override async executeSessionMemoryLLMMerge(
    _descriptor: AgentDescriptor,
    profileMemoryContent: string,
    sessionMemoryContent: string,
  ): Promise<{ mergedContent: string; model: string }> {
    const mergedContent = await memoryMergeMockState.executeLLMMerge(profileMemoryContent, sessionMemoryContent)
    return {
      mergedContent,
      model: 'mock/test-model',
    }
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
  it('preserves existing profile memory content across restart and keeps it in root runtime context', async () => {
    const config = await makeTempConfig()

    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const persistedMemory = '# Swarm Memory\n\n## Project Facts\n- remember me\n'
    await writeFile(getProfileMemoryPath(config.paths.dataDir, 'manager'), persistedMemory, 'utf8')

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const profileMemory = await readFile(getProfileMemoryPath(config.paths.dataDir, 'manager'), 'utf8')
    expect(profileMemory).toBe(persistedMemory)

    const resources = await secondBoot.getMemoryRuntimeResourcesForTest()
    expect(resources.memoryContextFile.path).toBe(getRootSessionMemoryPath(config.paths.dataDir, 'manager'))
    expect(resources.memoryContextFile.content).toContain(persistedMemory.trim())
    expect(resources.memoryContextFile.content).toContain('# Common Knowledge (maintained by Cortex — read-only reference)')
  })

  it('mergeSessionMemory safely promotes session memory into profile memory and records audit/meta state', async () => {
    memoryMergeMockState.executeLLMMerge.mockReset()
    memoryMergeMockState.executeLLMMerge.mockResolvedValue(
      '# Swarm Memory\n\n## Decisions\n- existing profile decision\n- merged by mock\n',
    )

    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Merge Session' })
    const profileMemoryPath = getProfileMemoryPath(config.paths.dataDir, 'manager')
    const sessionMemoryPath = getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId)
    const auditPath = getProfileMergeAuditLogPath(config.paths.dataDir, 'manager')

    await writeFile(profileMemoryPath, '# Swarm Memory\n\n## Decisions\n- existing profile decision\n', 'utf8')
    await writeFile(sessionMemoryPath, '# Swarm Memory\n\n## Decisions\n- session merge detail\n', 'utf8')

    const descriptorSaveSpy = vi.spyOn((manager as any).descriptorStore, 'save')
    const auditSpy = vi.spyOn(
      (manager as any).knowledgeMemoryCoordinator,
      'appendSessionMemoryMergeAuditEntry',
    )
    const snapshotSpy = vi.spyOn((manager as any).eventCoordinator, 'emitAgentsSnapshot')
    descriptorSaveSpy.mockClear()
    auditSpy.mockClear()
    snapshotSpy.mockClear()

    const result = await manager.mergeSessionMemory(sessionAgent.agentId)

    expect(result.status).toBe('applied')
    expect(result.strategy).toBe('llm')
    expect(result.auditPath).toBe(auditPath)

    const mergedProfileMemory = await readFile(profileMemoryPath, 'utf8')
    expect(mergedProfileMemory).toContain('existing profile decision')
    expect(mergedProfileMemory).toContain('merged by mock')
    expect(mergedProfileMemory).not.toContain('## Session Memory Merge —')

    const mergedSessionDescriptor = manager.listAgents().find((agent) => agent.agentId === sessionAgent.agentId)
    expect(mergedSessionDescriptor?.mergedAt).toBeDefined()
    expect(mergedSessionDescriptor?.mergedAt).toBe(result.mergedAt)

    const lastDescriptorSaveOrder = descriptorSaveSpy.mock.invocationCallOrder.at(-1)
    expect(lastDescriptorSaveOrder).toBeDefined()
    expect(lastDescriptorSaveOrder!).toBeLessThan(auditSpy.mock.invocationCallOrder[0])
    expect(auditSpy.mock.invocationCallOrder[0]).toBeLessThan(snapshotSpy.mock.invocationCallOrder[0])

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', sessionAgent.agentId)
    expect(sessionMeta?.memoryMergeAttemptCount).toBe(1)
    expect(sessionMeta?.lastMemoryMergeStatus).toBe('applied')
    expect(sessionMeta?.lastMemoryMergeStrategy).toBe('llm')
    expect(sessionMeta?.lastMemoryMergeAppliedAt).toBe(result.mergedAt)
    expect(sessionMeta?.lastMemoryMergeAttemptId).toEqual(expect.any(String))
    expect(sessionMeta?.lastMemoryMergeError).toBeNull()

    const auditLines = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(auditLines).toHaveLength(1)
    expect(auditLines[0]).toMatchObject({
      sessionAgentId: sessionAgent.agentId,
      profileId: 'manager',
      status: 'applied',
      strategy: 'llm',
      usedFallbackAppend: false,
      appliedChange: true,
    })
    expect(sessionMeta?.lastMemoryMergeAttemptId).toBe(auditLines[0].attemptId)
    expect(sessionMeta?.lastMemoryMergeProfileHashBefore).toBe(auditLines[0].profileContentHashBefore)
    expect(sessionMeta?.lastMemoryMergeProfileHashAfter).toBe(auditLines[0].profileContentHashAfter)
  })

  it('mergeSessionMemory fails closed when llm promotion fails and preserves profile memory', async () => {
    memoryMergeMockState.executeLLMMerge.mockReset()
    memoryMergeMockState.executeLLMMerge.mockRejectedValue(new Error('merge model unavailable'))

    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Failure Session' })
    const profileMemoryPath = getProfileMemoryPath(config.paths.dataDir, 'manager')
    const auditPath = getProfileMergeAuditLogPath(config.paths.dataDir, 'manager')

    await writeFile(profileMemoryPath, '# Swarm Memory\n\n## Decisions\n- keep this canonical summary\n', 'utf8')
    await writeFile(
      getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId),
      '# Swarm Memory\n\n## Decisions\n- risky session detail\n',
      'utf8',
    )

    await expect(manager.mergeSessionMemory(sessionAgent.agentId)).rejects.toThrow(
      'Session memory merge failed during llm: merge model unavailable',
    )

    const profileMemory = await readFile(profileMemoryPath, 'utf8')
    expect(profileMemory).toBe('# Swarm Memory\n\n## Decisions\n- keep this canonical summary\n')

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', sessionAgent.agentId)
    expect(sessionMeta?.memoryMergeAttemptCount).toBe(1)
    expect(sessionMeta?.lastMemoryMergeStatus).toBe('failed')
    expect(sessionMeta?.lastMemoryMergeStrategy).toBe('llm')
    expect(sessionMeta?.lastMemoryMergeError).toContain('merge model unavailable')
    expect(sessionMeta?.lastMemoryMergeAppliedAt).toBeNull()

    const auditLines = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(auditLines).toHaveLength(1)
    expect(auditLines[0]).toMatchObject({
      sessionAgentId: sessionAgent.agentId,
      status: 'failed',
      strategy: 'llm',
      usedFallbackAppend: false,
      appliedChange: false,
    })
  })

  it('mergeSessionMemory rolls back live and persisted mergedAt when descriptor-store save fails', async () => {
    memoryMergeMockState.executeLLMMerge.mockReset()
    memoryMergeMockState.executeLLMMerge.mockResolvedValue('# Swarm Memory\n\n## Decisions\n- merged before descriptor-store failure\n')

    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Descriptor Store Save Failure Session' })
    const beforeDescriptor = manager.listAgents().find((agent) => agent.agentId === sessionAgent.agentId)
    expect(beforeDescriptor?.mergedAt).toBeUndefined()

    await writeFile(getProfileMemoryPath(config.paths.dataDir, 'manager'), '# Swarm Memory\n\n## Decisions\n- existing profile decision\n', 'utf8')
    await writeFile(
      getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId),
      '# Swarm Memory\n\n## Decisions\n- detail before descriptor-store save failure\n',
      'utf8',
    )

    vi.spyOn((manager as any).descriptorStore, 'save').mockRejectedValueOnce(new Error('transactional store write failed'))

    await expect(manager.mergeSessionMemory(sessionAgent.agentId)).rejects.toThrow(
      'Session memory merge failed during save_store: transactional store write failed',
    )

    const liveDescriptor = manager.listAgents().find((agent) => agent.agentId === sessionAgent.agentId)
    expect(liveDescriptor?.mergedAt).toBeUndefined()

    const persistedStore = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
      agents: Array<{ agentId: string; mergedAt?: string }>
    }
    expect(persistedStore.agents.find((agent) => agent.agentId === sessionAgent.agentId)?.mergedAt).toBeUndefined()

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', sessionAgent.agentId)
    expect(sessionMeta?.lastMemoryMergeStatus).toBe('failed')
    expect(sessionMeta?.lastMemoryMergeFailureStage).toBe('save_store')
  })
})
