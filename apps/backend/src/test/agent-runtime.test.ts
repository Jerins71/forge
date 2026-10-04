import { describe, expect, it, vi, beforeEach } from 'vitest'
import { AgentRuntime } from '../swarm/runtime/pi-agent-runtime.js'
import { clearForgePiCompactionFailure } from '../swarm/compaction/forge-pi-compaction-extension.js'
import type { AgentDescriptor } from '../swarm/types.js'

const openAICodexResponsesMockState = vi.hoisted(() => ({
  closeOpenAICodexWebSocketSessions: vi.fn(),
  getOpenAICodexWebSocketDebugStats: vi.fn(),
}))

vi.mock('@earendil-works/pi-ai/api/openai-codex-responses', () => ({
  closeOpenAICodexWebSocketSessions: (...args: unknown[]) =>
    openAICodexResponsesMockState.closeOpenAICodexWebSocketSessions(...args),
  getOpenAICodexWebSocketDebugStats: (...args: unknown[]) =>
    openAICodexResponsesMockState.getOpenAICodexWebSocketDebugStats(...args),
}))

class FakeSession {
  isStreaming = false
  promptCalls: string[] = []
  promptImageCounts: number[] = []
  followUpCalls: string[] = []
  steerCalls: string[] = []
  queuedSteers: string[] = []
  steerImageCounts: number[] = []
  userMessageCalls: Array<string | Array<{ type: string }>> = []
  abortCalls = 0
  disposeCalls = 0
  clearQueueCalls = 0
  listener: ((event: any) => void) | undefined
  contextUsageCalls = 0
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined
  agent = { transport: 'websocket-cached' }
  model = { provider: 'openai-codex', api: 'openai-codex-responses' }
  state: { messages: Array<Record<string, any>> } = { messages: [] }
  authStorageCredentials = new Map<string, unknown>()
  modelRegistry: any = {
    authStorage: {
      get: vi.fn((key: string) => this.authStorageCredentials.get(key)),
      set: vi.fn((key: string, value: unknown) => {
        this.authStorageCredentials.set(key, value)
      }),
    },
  }
  sessionId = 'fake-session-id'
  sessionManager = {
    getEntries: () => [],
  }
  shutdownEvents: any[] = []
  extensionRunner = {
    hasHandlers: (eventName: string) => eventName === 'session_shutdown',
    emit: async (event: any) => {
      this.shutdownEvents.push(event)
    },
  }

  async prompt(message: string, options?: { images?: Array<{ type: string }> }): Promise<void> {
    this.promptCalls.push(message)
    this.promptImageCounts.push(options?.images?.length ?? 0)
  }

  async followUp(message: string): Promise<void> {
    this.followUpCalls.push(message)
  }

  async steer(message: string, images?: Array<{ type: string }>): Promise<void> {
    this.steerCalls.push(message)
    this.queuedSteers.push(message)
    this.steerImageCounts.push(images?.length ?? 0)
  }

  async sendUserMessage(content: string | Array<{ type: string }>): Promise<void> {
    this.userMessageCalls.push(content)
  }

  async abort(): Promise<void> {
    this.abortCalls += 1
  }

  async waitForIdle(): Promise<void> {}

  async compact(): Promise<{ ok: true }> {
    return { ok: true }
  }

  setFreshContextHandler(_handler?: unknown): void {}

  clearQueue(): { steering: string[]; followUp: string[] } {
    this.clearQueueCalls += 1
    return { steering: this.queuedSteers.splice(0), followUp: [] }
  }

  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined {
    this.contextUsageCalls += 1
    return this.contextUsage
  }

  dispose(): void {
    this.disposeCalls += 1
  }

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

function makeDescriptor(): AgentDescriptor {
  return {
    agentId: 'worker',
    displayName: 'Worker',
    role: 'worker',
    managerId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/project',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'medium',
    },
    sessionFile: '/tmp/project/worker.jsonl',
  }
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (condition()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  throw new Error('Timed out waiting for async condition')
}

describe('AgentRuntime', () => {
  beforeEach(() => {
    openAICodexResponsesMockState.closeOpenAICodexWebSocketSessions.mockReset()
    openAICodexResponsesMockState.getOpenAICodexWebSocketDebugStats.mockReset()
    clearForgePiCompactionFailure('worker')
    clearForgePiCompactionFailure('worker::stale')
    clearForgePiCompactionFailure('worker::fresh')
    clearForgePiCompactionFailure('worker::shared')
  })

  it('fails closed before dispatch when an active broker runtime sees local auth mode', async () => {
    const session = new FakeSession()
    const runtimeErrors: unknown[] = []
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
        onRuntimeError: (_agentId, error) => runtimeErrors.push(error),
      },
    })
    const handle = {
      leaseId: 'lease-broker',
      renewedAtMs: Date.now(),
      identity: { clientId: 'forge', sessionId: 'worker' },
      lease: {
        leaseId: 'lease-broker',
        credential: { type: 'oauth', access: 'access-1', refresh: '', expires: 1_700_000_000_000 },
      },
    }
    const brokerRuntimeService = {
      isBrokerModeActive: vi.fn(async () => false),
      release: vi.fn(async () => undefined),
    }
    runtime.configureOpenAIAuthBrokerController(brokerRuntimeService as any, handle as any)

    await runtime.sendMessage('hello')
    await waitForCondition(() => runtimeErrors.length > 0)

    expect(session.promptCalls).toEqual([])
    expect(brokerRuntimeService.release).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: 'lease-broker' }),
      'auth_source_change',
    )
    expect(runtimeErrors).toContainEqual(expect.objectContaining({
      phase: 'prompt_dispatch',
      message: expect.stringContaining('auth source changed to local credentials'),
    }))
  })

  it('retains runtime ownership when yielded-command cleanup fails and allows a scoped retry', async () => {
    const session = new FakeSession()
    const stopAll = vi.fn().mockRejectedValueOnce(new Error('command still running')).mockResolvedValue(undefined)
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(), session: session as any,
      callbacks: { onStatusChange: () => {} }, bashProcesses: { stopAll } as any,
    })
    await expect(runtime.shutdownForReplacement()).rejects.toThrow('command still running')
    expect(session.disposeCalls).toBe(0)
    expect(session.listener).toBeDefined()
    await runtime.shutdownForReplacement()
    expect(session.disposeCalls).toBe(1)
    expect(stopAll).toHaveBeenCalledTimes(2)
  })
})
