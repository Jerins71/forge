import { execFileSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProjectAgentDir } from '../data-paths.js';
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
const workspaceResolverMockState = vi.hoisted(() => ({
  failNextResolvePassive: undefined as Error | undefined,
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

vi.mock('../project-workspace-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../project-workspace-resolver.js')>('../project-workspace-resolver.js')
  class MockProjectWorkspaceResolver extends actual.ProjectWorkspaceResolver {
    override async resolvePassive(
      ...args: Parameters<InstanceType<typeof actual.ProjectWorkspaceResolver>['resolvePassive']>
    ): ReturnType<InstanceType<typeof actual.ProjectWorkspaceResolver>['resolvePassive']> {
      const failure = workspaceResolverMockState.failNextResolvePassive
      if (failure) {
        workspaceResolverMockState.failNextResolvePassive = undefined
        throw failure
      }
      return super.resolvePassive(...args)
    }
  }
  return {
    ...actual,
    ProjectWorkspaceResolver: MockProjectWorkspaceResolver,
  }
})

import type { AgentDescriptor, SwarmConfig } from '../types.js';
import type { RuntimeCreationOptions, SwarmAgentRuntime } from '../runtime-contracts.js'
import { FakeRuntime, TestSwarmManager as TestSwarmManagerBase, bootWithDefaultManager } from '../../test-support/index.js';

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

class ProjectAgentAwareSwarmManager extends TestSwarmManager {
  readonly notifiedProjectAgentProfileIds: string[] = []

  override async notifyProjectAgentsChanged(profileId: string): Promise<void> {
    this.notifiedProjectAgentProfileIds.push(profileId)
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

async function createRepoProjectAgentDefinition(rootDir: string, options: {
  definitionId: string
  handle?: string
  whenToUse?: string
  prompt?: string
  references?: Record<string, string>
  capabilities?: string[]
}): Promise<void> {
  const definitionDir = join(rootDir, '.forge', 'project-agents', options.definitionId)
  await mkdir(definitionDir, { recursive: true })
  await writeFile(
    join(definitionDir, 'config.json'),
    JSON.stringify({
      version: 1,
      handle: options.handle ?? options.definitionId,
      whenToUse: options.whenToUse ?? 'Use for repository docs.',
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    }),
    'utf8',
  )
  await writeFile(join(definitionDir, 'prompt.md'), options.prompt ?? 'Repo prompt body', 'utf8')
  if (options.references) {
    const referenceDir = join(definitionDir, 'reference')
    await mkdir(referenceDir, { recursive: true })
    for (const [fileName, content] of Object.entries(options.references)) {
      await writeFile(join(referenceDir, fileName), content, 'utf8')
    }
  }
}

describe('SwarmManager', () => {
  afterEach(() => {
    workspaceResolverMockState.failNextResolvePassive = undefined
  })

  it('activates a repo project-agent definition by creating a backing session without local prompt/reference copies', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Maintain repository docs.',
      prompt: 'Repo docs prompt',
      references: { 'guide.md': '# Repo guide' },
      capabilities: ['create_session'],
    })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const result = await manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'create',
      approvedCapabilities: ['create_session'],
    })

    expect(result.agentId).not.toBe('manager')
    const descriptor = manager.getAgent(result.agentId)!
    expect(descriptor.projectAgent).toMatchObject({
      handle: 'docs',
      whenToUse: 'Maintain repository docs.',
      capabilities: ['create_session'],
      sourceKind: 'repo',
    })
    expect(descriptor.projectAgent).not.toHaveProperty('source')
    expect(manager.getAgentForInternalUse(result.agentId)?.projectAgent?.source).toMatchObject({ type: 'repo', definitionId: 'docs' })
    await expect(stat(getProjectAgentDir(config.paths.dataDir, 'manager', 'docs'))).rejects.toMatchObject({ code: 'ENOENT' })
    const snapshot = await manager.getProjectAgentConfig(result.agentId)
    expect(snapshot.systemPrompt).toBe('Repo docs prompt')
    expect(snapshot.references).toEqual(['guide.md'])
    expect(await manager.getProjectAgentReference(result.agentId, 'guide.md')).toBe('# Repo guide')
    expect(snapshot.source).toMatchObject({ status: 'valid', definitionId: 'docs' })
    expect(manager.notifiedProjectAgentProfileIds).toContain('manager')
  })

  it('redacts repo project-agent source metadata from public list/bootstrap/snapshot payloads', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Maintain repository docs.',
      prompt: 'Repo docs prompt',
    })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const snapshots: Array<{ agents: AgentDescriptor[] }> = []
    const projectAgentUpdates: Array<{ projectAgent: AgentDescriptor['projectAgent'] | null }> = []
    manager.on('agents_snapshot', (event) => snapshots.push(event as { agents: AgentDescriptor[] }))
    manager.on('session_project_agent_updated', (event) => {
      projectAgentUpdates.push(event as { projectAgent: AgentDescriptor['projectAgent'] | null })
    })

    const result = await manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'create',
    })

    const liveDescriptor = (manager as unknown as { descriptors: Map<string, AgentDescriptor> }).descriptors.get(result.agentId)!
    liveDescriptor.sessionSystemPrompt = 'Private session role instructions from repo prompt composition.'
    ;(manager as unknown as { eventCoordinator: { emitAgentsSnapshot: () => void } })
      .eventCoordinator.emitAgentsSnapshot()
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const assertPublicProjectAgent = (projectAgent: AgentDescriptor['projectAgent'] | undefined) => {
      expect(projectAgent).toMatchObject({ handle: 'docs', whenToUse: 'Maintain repository docs.', sourceKind: 'repo' })
      expect(projectAgent).not.toHaveProperty('source')
      expect(projectAgent).not.toHaveProperty('systemPrompt')
      expect(JSON.stringify(projectAgent)).not.toContain('forgeDirRealpath')
      expect(JSON.stringify(projectAgent)).not.toContain('workspaceKey')
      expect(JSON.stringify(projectAgent)).not.toContain('activatedAt')
    }
    const assertPublicDescriptor = (descriptor: AgentDescriptor | undefined) => {
      expect(descriptor).toBeDefined()
      expect(descriptor).not.toHaveProperty('sessionSystemPrompt')
      assertPublicProjectAgent(descriptor?.projectAgent)
    }

    assertPublicProjectAgent(result.projectAgent)
    assertPublicDescriptor(manager.getAgent(result.agentId))
    assertPublicDescriptor(manager.listAgents().find((agent) => agent.agentId === result.agentId))
    assertPublicDescriptor(manager.listBootstrapAgents().find((agent) => agent.agentId === result.agentId))
    assertPublicDescriptor(manager.listManagerAgents().find((agent) => agent.agentId === result.agentId))
    assertPublicDescriptor(snapshots.at(-1)?.agents.find((agent) => agent.agentId === result.agentId))
    assertPublicProjectAgent(projectAgentUpdates.at(-1)?.projectAgent ?? undefined)
    expect(manager.getAgentForInternalUse(result.agentId)?.sessionSystemPrompt).toBe('Private session role instructions from repo prompt composition.')
    expect(manager.getAgentForInternalUse(result.agentId)?.projectAgent?.source).toMatchObject({ type: 'repo', definitionId: 'docs' })
  })

  it('rejects project-agent reference path traversal through the manager facade', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.createSession('manager', { label: 'Docs' })
    await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      whenToUse: 'Maintain docs.',
    })

    await expect(
      manager.setProjectAgentReference(created.sessionAgent.agentId, '../escape.md', 'escaped'),
    ).rejects.toThrow('Invalid path segment')
    await expect(manager.getProjectAgentReference(created.sessionAgent.agentId, '../escape.md')).rejects.toThrow(
      'Invalid path segment',
    )
  })

  it('retains a valid repository definition when created-session runtime shutdown fails', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const creator = await manager.createSession('manager', {
      label: 'Agent Creator',
      sessionPurpose: 'agent_creator',
    })
    vi.spyOn((manager as any).runtimeLifecycleCoordinator, 'runRuntimeShutdown').mockImplementation(
      async (descriptor: AgentDescriptor, action: string, options?: unknown) => {
        if (descriptor.projectAgent?.handle === 'docs' && action === 'terminate') {
          return { status: 'failed', error: new Error('shutdown boom') }
        }
        return (manager as any).runtimeLifecycleCoordinator.constructor.prototype.runRuntimeShutdown.call(
          (manager as any).runtimeLifecycleCoordinator,
          descriptor,
          action,
          options,
        )
      },
    )
    const descriptorStore = (manager as any).descriptorStore
    const originalSave = descriptorStore.save.bind(descriptorStore)
    const persistedSnapshots: Array<{
      createdAgentId?: string
      creatorResult?: AgentDescriptor['agentCreatorResult']
    }> = []
    const saveSpy = vi.spyOn(descriptorStore, 'save')
      .mockImplementationOnce(async () => {
        const created = manager.listAgents().find((agent) => agent.projectAgent?.handle === 'docs')
        persistedSnapshots.push({
          createdAgentId: created?.agentId,
          creatorResult: manager.getAgent(creator.sessionAgent.agentId)?.agentCreatorResult,
        })
        throw new Error('save boom')
      })
      .mockImplementationOnce(async (...args: any[]) => {
        const created = manager.listAgents().find((agent) => agent.projectAgent?.handle === 'docs')
        persistedSnapshots.push({
          createdAgentId: created?.agentId,
          creatorResult: manager.getAgent(creator.sessionAgent.agentId)?.agentCreatorResult,
        })
        await originalSave(...args)
      })

    await expect(
      manager.createAndPromoteProjectAgent(creator.sessionAgent.agentId, {
        sessionName: 'Docs',
        handle: 'docs',
        whenToUse: 'Maintain repository docs.',
        systemPrompt: 'You are the repository docs project agent.',
        placement: 'repo',
      }),
    ).rejects.toThrow('save boom')

    const created = manager.listAgents().find((agent) => agent.projectAgent?.handle === 'docs')
    expect(saveSpy).toHaveBeenCalledTimes(2)
    expect(persistedSnapshots).toHaveLength(2)
    expect(persistedSnapshots[0]).toMatchObject({
      createdAgentId: created?.agentId,
      creatorResult: { createdAgentId: created?.agentId, createdHandle: 'docs' },
    })
    expect(persistedSnapshots[1]).toMatchObject({
      createdAgentId: created?.agentId,
      creatorResult: { createdAgentId: created?.agentId, createdHandle: 'docs' },
    })
    expect(created?.projectAgent).toMatchObject({ handle: 'docs', sourceKind: 'repo' })
    expect(manager.getAgent(creator.sessionAgent.agentId)?.agentCreatorResult).toMatchObject({
      createdAgentId: created?.agentId,
      createdHandle: 'docs',
    })
    expect(await readFile(join(config.defaultCwd, '.forge', 'project-agents', 'docs', 'prompt.md'), 'utf8')).toBe(
      'You are the repository docs project agent.\n',
    )
  })
})
