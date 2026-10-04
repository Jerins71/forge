import { readFile, writeFile } from 'node:fs/promises';

import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest'

import { getLegacySessionsDirPath } from '../data-paths.js';

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
    config.cortexEnabled = false
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
    await expectHiddenAndRetained(first)

    // A Builder mutation rewrites agents.json from the live maps.
    await first.renameSession('manager', 'Renamed Manager')
    expect((await readStore()).agents).toContainEqual(expect.objectContaining({ agentId: 'manager', sessionLabel: 'Renamed Manager' }))
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
