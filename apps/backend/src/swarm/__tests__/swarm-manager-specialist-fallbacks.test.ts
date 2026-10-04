import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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

import { AgentRuntime } from '../runtime/pi-agent-runtime.js'
import type { MemoryCoordinator } from '../memory-coordinator.js'
import type { SwarmSpecialistFallbackManager } from '../swarm-specialist-fallback-manager.js'
import type { AgentContextUsage, AgentDescriptor, SwarmConfig } from '../types.js';
import type { RuntimeCreationOptions, SwarmAgentRuntime } from '../runtime-contracts.js';
import {
  bootWithDefaultManager,
  FakeRuntime,
  makeTempConfig as buildTempConfig,
  TestSwarmManager as TestSwarmManagerBase,
} from '../../test-support/index.js'

class TestSwarmManager extends TestSwarmManagerBase {
  getSpecialistFallbackManagerForTest(): SwarmSpecialistFallbackManager {
    return (this as unknown as {
      specialistFallbackManager: SwarmSpecialistFallbackManager
    }).specialistFallbackManager
  }

  updateSessionMetaForWorkerDescriptorForTest(descriptor: AgentDescriptor): Promise<void> {
    return (this as unknown as {
      memoryCoordinator: MemoryCoordinator
    }).memoryCoordinator.updateSessionMetaForWorkerDescriptor(descriptor)
  }

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

class FallbackReplaySession {
  isStreaming = false
  promptCalls: string[] = []
  steerCalls: string[] = []
  listener: ((event: any) => void) | undefined
  promptImpl: ((message: string) => Promise<void>) | undefined
  steerImpl: ((message: string) => Promise<void>) | undefined
  private sessionMessages: unknown[] = []

  readonly sessionManager = {
    getEntries: () => [],
    buildSessionContext: () => ({ messages: structuredClone(this.sessionMessages) as unknown[] }),
    resetLeaf: () => {
      this.sessionMessages = []
    },
    appendModelChange: () => {},
    appendThinkingLevelChange: () => {},
    appendMessage: (message: unknown) => {
      this.sessionMessages.push(structuredClone(message))
    },
    appendCustomEntry: () => 'custom-id',
  }

  readonly model = { provider: 'openai-codex', id: 'gpt-5.5' }
  readonly thinkingLevel = 'medium'
  readonly state = { messages: [] as Array<{ role?: string; stopReason?: string }> }
  readonly agent = {
    state: this.state,
  }

  async prompt(message: string): Promise<void> {
    this.promptCalls.push(message)
    if (this.promptImpl) {
      await this.promptImpl(message)
    }
  }

  async steer(message: string): Promise<void> {
    this.steerCalls.push(message)
    if (this.steerImpl) {
      await this.steerImpl(message)
    }
  }

  async sendUserMessage(): Promise<void> {}
  async abort(): Promise<void> {}
  async compact(): Promise<unknown> { return { ok: true } }
  getContextUsage(): AgentContextUsage | undefined { return undefined }
  dispose(): void {}

  subscribe(listener: (event: any) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = undefined
    }
  }

  emit(event: any): void {
    this.listener?.(event)
  }
}

class RuntimeFallbackReplayTestManager extends TestSwarmManager {
  fallbackReplaySessionByAgentId = new Map<string, FallbackReplaySession>()
  fallbackReplayRuntimeByAgentId = new Map<string, AgentRuntime>()
  fallbackReplayWorkerId: string | undefined

  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime> {
    const workerId = this.fallbackReplayWorkerId
    const creationCount = (this.runtimeCreationCountByAgentId.get(descriptor.agentId) ?? 0) + 1

    if (workerId && descriptor.agentId === workerId && creationCount === 1) {
      const session = new FallbackReplaySession()
      const runtime = new AgentRuntime({
        descriptor: structuredClone(descriptor),
        session: session as any,
        systemPrompt,
        callbacks: {
          onStatusChange: async () => {},
          onSessionEvent: async () => {},
          onAgentEnd: async () => {},
          onRuntimeError: async () => {},
        },
      })
      this.runtimeCreationCountByAgentId.set(descriptor.agentId, creationCount)
      this.createdRuntimeIds.push(descriptor.agentId)
      this.fallbackReplaySessionByAgentId.set(descriptor.agentId, session)
      this.fallbackReplayRuntimeByAgentId.set(descriptor.agentId, runtime)
      this.systemPromptByAgentId.set(descriptor.agentId, systemPrompt)
      return runtime as unknown as SwarmAgentRuntime
    }

    return super.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options)
  }
}

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T) => {}
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })

  return { promise, resolve }
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
  it('replays the full accepted turn set when a queued follow-up was already consumed', async () => {
    const config = await makeTempConfig()
    const manager = new RuntimeFallbackReplayTestManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.5',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    manager.fallbackReplayWorkerId = 'planner-active-follow-up-worker'
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Active Follow Up Worker',
      specialist: 'planner',
    })
    const activeRuntime = manager.fallbackReplayRuntimeByAgentId.get(worker.agentId)
    const activeSession = manager.fallbackReplaySessionByAgentId.get(worker.agentId)
    expect(activeRuntime).toBeDefined()
    expect(activeSession).toBeDefined()

    const firstPromptStarted = createDeferred<void>()
    const releaseFirstPrompt = createDeferred<void>()
    activeSession!.promptImpl = async (message: string) => {
      if (message === 'first prompt') {
        firstPromptStarted.resolve(undefined)
        await releaseFirstPrompt.promise
      }
    }

    await activeRuntime!.sendMessage('first prompt', 'auto')
    await firstPromptStarted.promise
    await activeRuntime!.sendMessage('second prompt', 'auto')
    releaseFirstPrompt.resolve(undefined)

    activeSession!.emit({
      type: 'message_start',
      message: {
        role: 'user',
        content: 'second prompt',
      },
    })
    await Promise.resolve()

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage:
          '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
      },
    })

    const replacementRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(replacementRuntime).toBeDefined()
    expect(replacementRuntime?.sendCalls).toEqual([
      {
        message: {
          text: 'first prompt',
          images: [],
        },
        delivery: 'auto',
      },
      {
        message: {
          text: 'second prompt',
          images: [],
        },
        delivery: 'steer',
      },
    ])
  })

})
