import { readFile, writeFile } from 'node:fs/promises';

import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest'

import { getCommonKnowledgePath, getLegacySessionsDirPath } from '../data-paths.js';

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
  it('retains removed Collaboration records verbatim without loading them across save and restart', async () => {
    const config = await makeTempConfig()
    const sessionsDir = getLegacySessionsDirPath(config.paths.dataDir)
    const collabRoot = {
      agentId: '_collaboration',
      displayName: 'Collaboration',
      role: 'manager',
      managerId: '_collaboration',
      profileId: '_collaboration',
      status: 'idle',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:00.000Z',
      cwd: config.defaultCwd,
      model: config.defaultModel,
      sessionFile: join(sessionsDir, '_collaboration.jsonl'),
      futureCollabField: { kept: true },
    }
    const collabChannel = {
      ...collabRoot,
      agentId: 'channel-session',
      managerId: 'channel-session',
      archetypeId: 'collaboration-channel',
      sessionSurface: 'collab',
      collab: { workspaceId: 'workspace-1', channelId: 'channel-1' },
      sessionFile: join(sessionsDir, 'channel-session.jsonl'),
    }
    // No collab markers of its own: retained because its manager is retired.
    const collabWorker = {
      agentId: 'channel-worker',
      displayName: 'Channel Worker',
      role: 'worker',
      managerId: 'channel-session',
      status: 'idle',
      createdAt: '2026-03-27T00:01:00.000Z',
      updatedAt: '2026-03-27T00:01:00.000Z',
      cwd: config.defaultCwd,
      model: config.defaultModel,
      sessionFile: join(sessionsDir, 'channel-worker.jsonl'),
    }
    const collabProfile = {
      profileId: '_collaboration',
      displayName: 'Collaboration',
      defaultSessionAgentId: '_collaboration',
      profileType: 'system',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:00.000Z',
    }
    const builderManager = {
      agentId: 'manager',
      displayName: 'Manager',
      role: 'manager',
      managerId: 'manager',
      profileId: 'manager',
      archetypeId: 'manager',
      status: 'idle',
      createdAt: '2026-03-27T00:03:00.000Z',
      updatedAt: '2026-03-27T00:03:00.000Z',
      cwd: config.defaultCwd,
      model: config.defaultModel,
      sessionFile: join(sessionsDir, 'manager.jsonl'),
    }
    await writeFile(
      config.paths.agentsStoreFile,
      `${JSON.stringify({
        agents: [collabRoot, builderManager, collabWorker, collabChannel],
        profiles: [
          collabProfile,
          {
            profileId: 'manager',
            displayName: 'Manager',
            defaultSessionAgentId: 'manager',
            createdAt: '2026-03-27T00:03:00.000Z',
            updatedAt: '2026-03-27T00:03:00.000Z',
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    )

    const readStore = async () => JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
      agents: Array<Record<string, unknown>>
      profiles: Array<Record<string, unknown>>
    }
    const expectHiddenAndRetained = async (manager: TestSwarmManager) => {
      expect(manager.listAgents().map((descriptor) => descriptor.agentId)).toEqual(['manager'])
      expect(manager.listProfiles().map((profile) => profile.profileId)).toEqual(['manager'])
      const persisted = await readStore()
      for (const record of [collabRoot, collabWorker, collabChannel]) {
        expect(persisted.agents).toContainEqual(record)
      }
      expect(persisted.profiles).toContainEqual(collabProfile)
    }

    const first = new TestSwarmManager(config)
    await first.boot()
    await first.createManager('manager', { name:'Manager', cwd:config.defaultCwd })
    await expectHiddenAndRetained(first)

    // A Builder mutation commits to the DB; historical JSON remains unchanged.
    await first.renameSession('manager', 'Renamed Manager')
    expect(first.getAgent("manager")?.sessionLabel).toBe("Renamed Manager")
    await expectHiddenAndRetained(first)

    const restarted = new TestSwarmManager(config)
    await restarted.boot()
    await expectHiddenAndRetained(restarted)
  })

  it('retains removed Cortex records verbatim without loading them across save and restart', async () => {
    const config = await makeTempConfig()
    const sessionsDir = getLegacySessionsDirPath(config.paths.dataDir)
    const base = {
      status: 'idle',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:00.000Z',
      cwd: config.defaultCwd,
      model: config.defaultModel,
    }
    const cortexRoot = {
      ...base,
      agentId: 'cortex',
      displayName: 'Cortex',
      role: 'manager',
      managerId: 'cortex',
      profileId: 'cortex',
      archetypeId: 'cortex',
      sessionFile: join(sessionsDir, 'cortex.jsonl'),
    }
    const cortexReview = {
      ...base,
      agentId: 'cortex--review',
      displayName: 'Review Run',
      role: 'manager',
      managerId: 'cortex--review',
      profileId: 'cortex',
      archetypeId: 'cortex',
      sessionPurpose: 'cortex_review',
      status: 'streaming',
      sessionFile: join(sessionsDir, 'cortex--review.jsonl'),
    }
    // No Cortex markers of its own: retained because its manager is retired.
    const cortexWorker = {
      ...base,
      agentId: 'cortex--worker',
      displayName: 'Cortex Worker',
      role: 'worker',
      managerId: 'cortex--review',
      sessionFile: join(sessionsDir, 'cortex--worker.jsonl'),
    }
    // A capture-check fork lives in an ordinary profile but is still retired.
    const captureFork = {
      ...base,
      agentId: 'manager--s9',
      displayName: 'Capture check',
      role: 'manager',
      managerId: 'manager--s9',
      profileId: 'manager',
      sessionPurpose: 'capture_check',
      sessionFile: join(sessionsDir, 'manager--s9.jsonl'),
    }
    const cortexProfile = {
      profileId: 'cortex',
      displayName: 'Cortex',
      defaultSessionAgentId: 'cortex',
      profileType: 'system',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:00.000Z',
    }
    const builderManager = {
      ...base,
      agentId: 'manager',
      displayName: 'Manager',
      role: 'manager',
      managerId: 'manager',
      profileId: 'manager',
      archetypeId: 'manager',
      sessionFile: join(sessionsDir, 'manager.jsonl'),
    }
    await writeFile(
      config.paths.agentsStoreFile,
      `${JSON.stringify({
        agents: [cortexRoot, cortexReview, builderManager, cortexWorker, captureFork],
        profiles: [
          cortexProfile,
          {
            profileId: 'manager',
            displayName: 'Manager',
            defaultSessionAgentId: 'manager',
            createdAt: '2026-03-27T00:03:00.000Z',
            updatedAt: '2026-03-27T00:03:00.000Z',
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    )

    const readStore = async () => JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
      agents: Array<Record<string, unknown>>
      profiles: Array<Record<string, unknown>>
    }
    const expectHiddenAndRetained = async (manager: TestSwarmManager) => {
      expect(manager.listAgents().map((descriptor) => descriptor.agentId)).toEqual(['manager'])
      expect(manager.listProfiles().map((profile) => profile.profileId)).toEqual(['manager'])
      const persisted = await readStore()
      for (const record of [cortexRoot, cortexReview, cortexWorker, captureFork]) {
        expect(persisted.agents).toContainEqual(record)
      }
      expect(persisted.profiles).toContainEqual(cortexProfile)
    }

    const first = new TestSwarmManager(config)
    await first.boot()
    await first.createManager('manager', { name:'Manager', cwd:config.defaultCwd })
    await expectHiddenAndRetained(first)
    // Common knowledge is plain user memory now; boot never seeds it.
    await expect(readFile(getCommonKnowledgePath(config.paths.dataDir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    // A Builder mutation commits to the DB; historical JSON remains unchanged.
    await first.renameSession('manager', 'Renamed Manager')
    expect(first.getAgent("manager")?.sessionLabel).toBe("Renamed Manager")
    await expectHiddenAndRetained(first)

    const restarted = new TestSwarmManager(config)
    await restarted.boot()
    await expectHiddenAndRetained(restarted)
  })

  it('persists manager conversation history to disk and reloads it on restart', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    await firstBoot.handleUserMessage('persist this')
    await firstBoot.publishToUser('manager', 'saved reply', 'speak_to_user')

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const history = secondBoot.getConversationHistory('manager')
    expect(
      history.some(
        (message) =>
          message.type === 'conversation_message' &&
          message.text === 'persist this' &&
          message.source === 'user_input',
      ),
    ).toBe(true)
    expect(
      history.some(
        (message) =>
          message.type === 'conversation_message' &&
          message.text === 'saved reply' &&
          message.source === 'speak_to_user',
      ),
    ).toBe(true)
  })

})
