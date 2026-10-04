import { EventEmitter } from 'node:events'

import type { CliWsCommand, ServerEvent } from '@forge/protocol'
import { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'

import { ForgeClient } from './forge-client.js'

describe('ForgeClient', () => {

  it('always sends bearer auth and never retries unauthenticated', async () => {
    const calls: Array<{ url: string; auth: string | null }> = []
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret',
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers)
        calls.push({ url: String(url), auth: headers.get('authorization') })
        return Response.json({
          serverTime: 'now',
          serverVersion: '0.9.0',
          capabilities: { protocolVersion: 1, minCliVersion: '0.9.0', available: true, features: {} },
        })
      },
    })

    await client.getStatus()
    expect(calls).toEqual([{ url: 'http://127.0.0.1:47287/api/cli/status', auth: 'Bearer secret' }])
  })

  it('redacts API keys from HTTP error messages', async () => {
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret-token',
      fetchImpl: async () => Response.json({ error: { code: 'bad', message: 'bad secret-token value' } }, { status: 500 }),
    })

    await expect(client.getStatus()).rejects.toMatchObject({
      message: 'bad <redacted> value',
      code: 'bad',
    })
  })

  it('subscribes before dispatching run to avoid fast-output races', async () => {
    const socket = new FakeWebSocket()
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret-token',
      fetchImpl: statusFetch,
      WebSocketImpl: fakeWebSocketImpl(socket),
    })

    await expect(client.run({ command: 'run', target: { kind: 'session', agentId: 'session-1' }, text: 'hello' })).resolves.toMatchObject({
      status: 'success',
      finalMessage: 'fast done',
    })
    expect(socket.sent.map((command) => command.type).slice(0, 2)).toEqual(['subscribe_headless', 'cli_run'])
  })
})

async function statusFetch(): Promise<Response> {
  return Response.json({
    status: 'ok',
    serverTime: 'now',
    serverVersion: '0.9.0',
    runtimeTarget: 'builder',
    capabilities: {
      protocolVersion: 1,
      minCliVersion: '0.9.0',
      available: true,
      runtimeTarget: 'builder',
      features: {
        bearerAuth: true,
        headlessWs: true,
        cliSourceContext: true,
        cliSessionMetadata: true,
        choiceOwnerLookup: true,
        activeToolSnapshot: true,
        projectAgentRunTarget: true,
        sessionTranscript: true,
        sessionCompaction: true,
        builderRuntimeOnly: true,
      },
    },
    summary: { profileCount: 1, sessionCount: 1, agentCount: 1 },
  })
}

function fakeWebSocketImpl(socket: FakeWebSocket): typeof WebSocket {
  return function createFakeWebSocket() {
    socket.readyState = WebSocket.OPEN
    queueMicrotask(() => socket.emit('open'))
    return socket
  } as unknown as typeof WebSocket
}

class FakeWebSocket extends EventEmitter {
  readonly sent: CliWsCommand[] = []
  readyState = WebSocket.OPEN

  constructor(
    private readonly options: {
      closeAfterRunAck?: boolean
      closeBeforeHeadlessReady?: boolean
      compactionUnsupported?: boolean
      progressOnlyAfterRun?: boolean
      delayedBootstrapPlanSnapshot?: boolean
    } = {},
  ) {
    super()
  }

  send(raw: string, callback?: (error?: Error) => void): void {
    const command = JSON.parse(raw) as CliWsCommand
    this.sent.push(command)
    callback?.()
    if (command.type === 'subscribe_headless') {
      if (this.options.closeBeforeHeadlessReady) {
        this.emit('close')
      } else {
        this.emitEvent({
          type: 'headless_ready',
          requestId: command.requestId,
          serverTime: 'now',
          capabilities: (statusPayload().capabilities),
          subscribed: { agentId: 'session-1', profileId: 'profile-1' },
          targetAgent: {
            agentId: 'session-1',
            managerId: 'session-1',
            role: 'manager',
            status: 'idle',
            displayName: 'Session 1',
            createdAt: 'now',
            updatedAt: 'now',
            cwd: '/tmp',
            model: { provider: 'openai', modelId: 'gpt-5.3' },
            sessionFile: '/tmp/session.jsonl',
            profileId: 'profile-1',
          },
          pendingChoices: [],
          workers: [],
          activeTools: [],
          status: { agentId: 'session-1', status: 'idle', pendingCount: 0 },
        })
        if (this.options.delayedBootstrapPlanSnapshot) {
          setTimeout(() => this.emitEvent({
            type: 'session_plan_snapshot',
            sessionAgentId: 'session-1',
            profileId: 'profile-1',
            revision: 1,
            updatedAt: 'now',
            plan: [{ step: 'Existing plan', status: 'in_progress' }],
          }), 0)
        }
      }
    }
    if (command.type === 'compact_session' || command.type === 'smart_compact_session') {
      if (this.options.compactionUnsupported) {
        this.emitEvent({
          type: 'cli_request_error',
          requestId: command.requestId,
          commandType: command.type,
          code: 'compaction_unsupported',
          message: 'Runtime does not support compaction.',
          status: 501,
        })
      } else {
        this.emitEvent({
          type: 'cli_request_success',
          requestId: command.requestId,
          commandType: command.type,
          result: {
            action: command.type === 'compact_session' ? 'compact' : 'smart_compact',
            sessionAgentId: command.agentId,
            profileId: 'profile-1',
            outcome: command.type === 'compact_session' ? 'compacted' : 'skipped',
            compacted: command.type === 'compact_session',
            ...(command.type === 'smart_compact_session' ? { reason: 'runtime_already_compacted' } : {}),
            customInstructionsProvided: Boolean(command.customInstructions),
            completedAt: 'now',
          },
        })
      }
    }
    if (command.type === 'cli_run') {
      this.emitEvent({
        type: 'cli_request_success',
        requestId: command.requestId,
        commandType: command.type,
        result: { sessionAgentId: 'session-1', profileId: 'profile-1', messageId: 'message-1', acceptedAt: 'now' },
      })
      if (this.options.closeAfterRunAck) {
        this.emit('close')
      } else if (this.options.progressOnlyAfterRun) {
        this.emitEvent({
          type: 'conversation_message',
          agentId: 'session-1',
          role: 'assistant',
          text: 'still working',
          timestamp: 'now',
          source: 'assistant_progress',
        })
      } else if (this.options.delayedBootstrapPlanSnapshot) {
        // The delayed subscription snapshot is the only event after dispatch.
      } else {
        this.emitEvent({
          type: 'conversation_message',
          agentId: 'session-1',
          role: 'assistant',
          text: 'fast done',
          timestamp: 'now',
          source: 'assistant_output',
        })
      }
    }
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
  }

  private emitEvent(event: ServerEvent): void {
    this.emit('message', JSON.stringify(event))
  }
}

function statusPayload() {
  return {
    capabilities: {
      protocolVersion: 1,
      minCliVersion: '0.9.0',
      available: true,
      runtimeTarget: 'builder',
      features: {
        bearerAuth: true,
        headlessWs: true,
        cliSourceContext: true,
        cliSessionMetadata: true,
        choiceOwnerLookup: true,
        activeToolSnapshot: true,
        projectAgentRunTarget: true,
        sessionTranscript: true,
        sessionCompaction: true,
        builderRuntimeOnly: true,
      },
    },
  } as const
}
