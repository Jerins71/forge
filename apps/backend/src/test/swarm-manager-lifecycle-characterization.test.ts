import { afterEach, describe, expect, it } from 'vitest'
import { AgentRuntime } from '../swarm/runtime/pi-agent-runtime.js'
import { bootWithDefaultManager, createTempConfig, TestSwarmManager, type TempConfigHandle } from '../test-support/index.js'
import type { AgentContextUsage, SwarmConfig } from '../swarm/types.js'

const tempConfigHandles: TempConfigHandle[] = []

class EventSession {
  isStreaming = false
  promptImpl: ((message: string) => Promise<void>) | undefined
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
    await this.promptImpl?.(message)
  }

  async steer(): Promise<void> {}
  async sendUserMessage(): Promise<void> {}
  async abort(): Promise<void> {}
  async compact(): Promise<unknown> { return { ok: true } }
  getContextUsage(): AgentContextUsage | undefined { return undefined }
  dispose(): void {}

  subscribe(_listener: (event: any) => void): () => void {
    return () => {}
  }
}

afterEach(async () => {
  await Promise.all(tempConfigHandles.splice(0).map((handle) => handle.cleanup()))
})

async function makeTempConfig(port = 8891): Promise<SwarmConfig> {
  const handle = await createTempConfig({
    prefix: 'swarm-manager-lifecycle-characterization-',
    port,
  })
  tempConfigHandles.push(handle)
  return handle.config
}

describe('swarm-manager lifecycle characterization', () => {
  it('invokes runtime callbacks in the live normal-operation sequence', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const descriptor = await bootWithDefaultManager(manager, config)
    const session = new EventSession()
    const callbackOrder: string[] = []

    const runtime = new AgentRuntime({
      descriptor: structuredClone(descriptor),
      session: session as any,
      systemPrompt: 'You are the manager.',
      callbacks: {
        onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
          callbackOrder.push(`handleRuntimeStatus:${status}`)
          await (manager as any).handleRuntimeStatus(undefined, agentId, status, pendingCount, contextUsage)
        },
        onSessionEvent: async (agentId, event) => {
          callbackOrder.push(`handleRuntimeSessionEvent:${event.type}`)
          await (manager as any).handleRuntimeSessionEvent(agentId, event)
        },
        onAgentEnd: async (agentId) => {
          callbackOrder.push('handleRuntimeAgentEnd')
          await (manager as any).handleRuntimeAgentEnd(agentId)
        },
        onRuntimeError: async (agentId, error) => {
          callbackOrder.push(`handleRuntimeError:${error.phase}`)
          await (manager as any).handleRuntimeError(agentId, error)
        },
      },
    })

    session.isStreaming = true
    await (runtime as any).handleEvent({ type: 'agent_start' })
    await (runtime as any).handleEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Finished the turn.' }],
        stopReason: 'stop',
      },
    })
    session.isStreaming = false
    await (runtime as any).handleEvent({ type: 'agent_end', willRetry: false, messages: [] })
    await (runtime as any).handleEvent({ type: 'agent_settled' })

    expect(callbackOrder).toEqual([
      'handleRuntimeSessionEvent:agent_start',
      'handleRuntimeStatus:streaming',
      'handleRuntimeSessionEvent:message_end',
      'handleRuntimeSessionEvent:agent_end',
      'handleRuntimeStatus:idle',
      'handleRuntimeAgentEnd',
    ])
  })
})
