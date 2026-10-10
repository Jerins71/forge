// Guards command identity on the compatibility send path against a real runtime and WS fixture:
// a submit owns one command ID across lost acknowledgments, reconnect recovery and explicit retry;
// interrupted receipts are shown and never resubmitted unless the user resends (a new command).
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEnvironmentRegistry,
  createMemoryCredentialStore,
  createMemoryPersistence,
  type EnvironmentClient,
} from '@forge/client-runtime'
import type { CommandReceipt } from '@forge/protocol/environment-v2'
import {
  startFixtureServer,
  until,
  fixtureWebSocket,
} from '../../../../../packages/client-runtime/src/__tests__/fixture-server'
import { ManagerWsClient } from '../ws-client'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function environment() {
  const server = await startFixtureServer(0)
  cleanups.push(() => server.close())
  const registry = createEnvironmentRegistry({
    persistence: createMemoryPersistence(),
    credentials: createMemoryCredentialStore(),
    fetch: (url, init) => globalThis.fetch(url, init),
    webSocket: fixtureWebSocket,
    random: () => 0.01,
  })
  cleanups.push(() => registry.dispose())
  await registry.register(server.seed.entry)
  await registry.start()
  const client = registry.get(server.seed.entry.environmentId)
  await until(() => client.connection.getSnapshot().phase === 'online')
  const facade = new ManagerWsClient('', 'session-1', { environmentClient: client })
  cleanups.push(() => facade.destroy())
  await until(() => facade.getState().conversationBootstrap.phase === 'ready')
  const commandIds = (method: string) =>
    new Set(server.inputs.filter((entry) => entry.method === method).map((entry) => (entry.input as { commandId: string }).commandId))
  return { server, client, facade, commandIds }
}

const online = (client: EnvironmentClient) => client.connection.getSnapshot().phase === 'online'

describe('environment command identity', () => {
  it('keeps one command ID for a message across a lost acknowledgment, recovery and retry', async () => {
    const { server, client, facade, commandIds } = await environment()
    server.lostAck = true
    facade.sendUserMessage('hello once', { agentId: 'session-1' })
    // The local echo carries the command ID before any receipt exists.
    await until(() => Object.keys(facade.getState().commandStatuses ?? {}).length === 1)
    const [commandId] = Object.keys(facade.getState().commandStatuses!)
    expect(facade.getState().messages.some((m) => m.type === 'conversation_message' && m.clientRequestId === commandId)).toBe(true)

    // Reconnect recovery asks the server about the original command instead of minting another.
    await until(() => online(client) && facade.getState().commandStatuses?.[commandId]?.state === 'accepted')
    expect(server.inputs.some((e) => e.method === 'command.get' && (e.input as { commandId: string }).commandId === commandId)).toBe(true)

    // An explicit retry after a receipt is a no-op; nothing reaches the server under a new ID.
    expect(facade.retryEnvironmentMessage(commandId)).toBe(false)
    expect(commandIds('session.send')).toEqual(new Set([commandId]))
  })

  it('shows an interrupted receipt without resubmitting; resend is a new command', async () => {
    const { server, client, facade, commandIds } = await environment()
    facade.sendUserMessage('maybe delivered', { agentId: 'session-1' })
    await until(() => Object.values(facade.getState().commandStatuses ?? {}).some((s) => s.state === 'accepted'))
    const [commandId] = commandIds('session.send')
    const accepted = server.receipts.get(commandId)!
    const interrupted: CommandReceipt = { ...accepted, state: 'interrupted', delivery: 'unknown', updatedSequence: 50 }
    server.receipts.set(commandId, interrupted)
    server.emit({ kind: 'event', streamEpoch: server.seed.descriptor.streamEpoch, sequence: 50, event: { type: 'receipt.upsert', receipt: interrupted } }, 'session.subscribe')
    await until(() => facade.getState().commandStatuses?.[commandId]?.state === 'interrupted')
    expect(facade.getState().commandStatuses![commandId]).toMatchObject({ action: 'resend' })

    // Reconnecting never replays a terminal command.
    server.disconnect()
    await until(() => !online(client))
    await until(() => online(client))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(server.inputs.filter((e) => e.method === 'session.send')).toHaveLength(1)

    expect(facade.resendEnvironmentMessage(commandId)).toBe(true)
    await until(() => commandIds('session.send').size === 2)
    expect(facade.getState().commandStatuses![commandId]).toMatchObject({ state: 'interrupted', action: null })
    expect(facade.resendEnvironmentMessage(commandId)).toBe(false)
  })

  it('reuses the command ID when the same choice is submitted again before a receipt', async () => {
    const { server, client, facade, commandIds } = await environment()
    const answers = [{ questionId: 'q1', selectedOptionIds: ['a'] }]
    server.lostBeforeAccept = true
    facade.sendChoiceResponse('session-1', 'choice-1', answers)
    await until(() => commandIds('session.choose').size === 1 && !online(client))
    await until(() => online(client))
    facade.sendChoiceResponse('session-1', 'choice-1', answers)
    await until(() => server.receipts.size === 1)
    expect(commandIds('session.choose').size).toBe(1)

    // A different answer is a different intent and therefore a different command.
    facade.sendChoiceResponse('session-1', 'choice-1', [{ questionId: 'q1', selectedOptionIds: ['b'] }])
    await until(() => commandIds('session.choose').size === 2)
  })
})

// Batch 8 acceptance cases precede native lifecycle implementation.
describe('native environment lifecycle consumers', () => {
  it.each([
    ['session.resume', (f: ManagerWsClient) => f.resumeSession('session-1')],
    ['session.archive', (f: ManagerWsClient) => f.archiveSession('session-1')],
    ['session.restore', (f: ManagerWsClient) => f.restoreSession('session-1')],
    ['session.clear', (f: ManagerWsClient) => f.clearSession('session-1')],
    ['session.delete', (f: ManagerWsClient) => f.deleteSession('session-1')],
    ['session.fork', (f: ManagerWsClient) => f.forkSession('session-1', 'fork')],
    ['session.stop', (f: ManagerWsClient) => f.stopAllAgents('session-1')],
    ['session.choice.cancel', (f: ManagerWsClient) => f.sendChoiceCancel('session-1', 'choice-1')],
    ['worker.stop', (f: ManagerWsClient) => f.deleteAgent('worker-1')],
  ] as const)('%s uses a native receipt and no legacy request', async (method, invoke) => {
    const { server, facade } = await environment()
    server.transformOutbound = value => {
      const frame = value as { output?: CommandReceipt }
      if (frame.output?.commandId) return { ...frame, output: { ...frame.output, state: 'succeeded', result: { sessionId: 'session-1', projectId: 'project-1' } } }
      return value
    }
    const operation = Promise.resolve(invoke(facade)).catch(() => {})
    await until(() => server.inputs.some(entry => entry.method === method))
    expect(server.inputs.filter(entry => entry.method.startsWith('legacy.') && entry.method !== 'legacy.session.subscribe')).toEqual([])
    await operation
  })
})
