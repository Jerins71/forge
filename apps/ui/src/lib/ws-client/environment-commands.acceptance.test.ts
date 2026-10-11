// Guards command identity on the compatibility send path against a real runtime and WS fixture:
// a submit owns one command ID across lost acknowledgments, reconnect recovery and explicit retry;
// interrupted receipts are shown and never resubmitted unless the user resends (a new command).
import { afterEach, describe, expect, it, vi } from 'vitest'
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

async function environment(resendUndelivered = false) {
  const server = await startFixtureServer(0)
  server.seed.descriptor.capabilities.sessionLifecycle = true
  Object.assign(server.seed.descriptor.capabilities, { workerDelete: true })
  server.seed.descriptor.capabilities.resendUndelivered = resendUndelivered
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
  it('resends a proved-undelivered message with an explicit canonical reference', async () => {
    const { server, facade, commandIds } = await environment(true)
    facade.sendUserMessage('rejected before dispatch', { agentId: 'session-1' })
    await until(() => commandIds('session.send').size === 1)
    const [commandId] = commandIds('session.send')
    const accepted = server.receipts.get(commandId)!
    const failed: CommandReceipt = { ...accepted, state: 'failed', delivery: 'none', updatedSequence: 50 }
    server.receipts.set(commandId, failed)
    server.emit({ kind: 'event', streamEpoch: server.seed.descriptor.streamEpoch, sequence: 50, event: { type: 'receipt.upsert', receipt: failed } }, 'session.subscribe')
    await until(() => facade.getState().commandStatuses?.[commandId]?.state === 'failed')
    expect(facade.resendEnvironmentMessage(commandId)).toBe(true)
    await until(() => commandIds('session.send').size === 2)
    expect(server.inputs.filter(entry => entry.method === 'session.send').at(-1)!.input).toMatchObject({ resendOfCommandId: commandId })
  })

  // Sidebar workers can belong to a session whose detail is not mounted.
  // Delete must use that row's explicit owner, not silently return or target the open session.
  it('deletes an unmounted worker using its explicit owning session', async () => {
    const { server, facade } = await environment()
    server.seed.details!['background-session'] = { ...server.seed.details!['session-1']!, workers: [{ agentId: 'background-worker', title: 'Background worker', status: 'terminated' }] }
    facade.deleteAgent('background-worker', 'background-session')
    await until(() => server.inputs.some(entry => entry.method === 'worker.delete'))
    expect(server.inputs.find(entry => entry.method === 'worker.delete')!.input).toMatchObject({ workerId: 'background-worker', sessionId: 'background-session' })
    await until(() => !facade.getState().agents.some(agent => agent.agentId === 'background-worker'))
  })

  it('requires worker deletion capability before sending the new method', async () => {
    const { server, client, facade } = await environment()
    Object.assign(client.descriptor()!.capabilities, { workerDelete: false })
    facade.deleteAgent('worker-1', 'session-1')
    await until(() => Boolean(facade.getState().lastError?.includes('Update this environment')))
    expect(server.inputs.some(entry => entry.method === 'worker.delete')).toBe(false)
  })

  it('hydrates an unmounted session worker list through the existing native projection', async () => {
    const { server, facade } = await environment()
    server.seed.details!['background-session'] = { ...server.seed.details!['session-1']!, workers: [{ agentId: 'background-worker', title: 'Background worker', status: 'idle' }] }
    await facade.getSessionWorkers('background-session')
    expect(facade.getState().agents.find(agent => agent.agentId === 'background-worker')).toMatchObject({ managerId: 'background-session', status: 'idle' })
    expect(facade.getState().workerMetadataSessionIds.has('background-session')).toBe(true)
  })

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
    await until(() => [...server.receipts.values()].filter(r => r.method === 'session.choose').length === 1)
    expect(commandIds('session.choose').size).toBe(1)

    // A different answer is a different intent and therefore a different command.
    facade.sendChoiceResponse('session-1', 'choice-1', [{ questionId: 'q1', selectedOptionIds: ['b'] }])
    await until(() => commandIds('session.choose').size === 2)
  })
})

// Batch 8 acceptance cases precede native lifecycle implementation.
describe('native environment lifecycle consumers', () => {
  it('requires an updated environment before sending lifecycle controls', async () => {
    const { server, client, facade } = await environment()
    client.descriptor()!.capabilities.sessionLifecycle = false
    await expect(facade.clearSession('session-1')).rejects.toThrow('Update this environment')
    expect(server.inputs.some(entry => entry.method === 'session.clear')).toBe(false)
  })
  it.each([
    ['session.resume', (f: ManagerWsClient) => f.resumeSession('session-1')],
    ['session.archive', (f: ManagerWsClient) => f.archiveSession('session-1')],
    ['session.restore', (f: ManagerWsClient) => f.restoreSession('session-1')],
    ['session.clear', (f: ManagerWsClient) => f.clearSession('session-1')],
    ['session.delete', (f: ManagerWsClient) => f.deleteSession('session-1')],
    ['session.fork', (f: ManagerWsClient) => f.forkSession('session-1', 'fork')],
    ['session.stopAll', (f: ManagerWsClient) => f.stopAllAgents('session-1')],
    ['session.choice.cancel', (f: ManagerWsClient) => f.sendChoiceCancel('session-1', 'choice-1')],
    ['worker.delete', (f: ManagerWsClient) => f.deleteAgent('worker-1')],
  ] as const)('%s uses a native receipt and no legacy request', async (method, invoke) => {
    const { server, facade } = await environment()
    server.transformOutbound = value => {
      const frame = value as { output?: CommandReceipt }
      if (frame.output?.commandId) return { ...frame, output: { ...frame.output, state: 'succeeded', result: { sessionId: 'session-1', projectId: 'project-1' } } }
      return value
    }
    const operation = Promise.resolve(invoke(facade)).catch(() => {})
    await until(() => server.inputs.some(entry => entry.method === method))
    expect(server.inputs.filter(entry => entry.method.startsWith('legacy.'))).toEqual([])
    await operation
  })
})

// A slow runtime exit keeps the stop receipt running; that is not a failure. A real stop
// failure belongs to its session and must not follow the user to another one.
describe('session stop reporting', () => {
  it('waits for a stop that is still settling instead of reporting it as failed', async () => {
    const { server, facade } = await environment()
    let exited = false
    server.transformOutbound = value => {
      const frame = value as { output?: CommandReceipt }
      return frame.output?.method === 'session.stop' && !exited ? { ...frame, output: { ...frame.output, state: 'running' } } : value
    }
    const polls = () => server.inputs.filter(entry => entry.method === 'command.get').length
    const now = Date.now
    let skew = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + skew)
    cleanups.push(() => clock.mockRestore())
    let outcome = 'settling'
    const stop = facade.stopSession('session-1').then(() => { outcome = 'stopped' }, (error: Error) => { outcome = error.message })
    await until(() => polls() > 1)
    skew = 11_000
    const seen = polls()
    await until(() => polls() > seen + 1 || outcome !== 'settling')
    expect(outcome).toBe('settling')
    exited = true
    await stop
    expect(outcome).toBe('stopped')
    expect(new Set(server.inputs.filter(entry => entry.method === 'session.stop').map(entry => (entry.input as { commandId: string }).commandId)).size).toBe(1)
  })
  it('shows a stop failure only on its own session and drops it when another session is opened', async () => {
    const { facade } = await environment()
    facade.reportSessionError('session-2', 'Failed to stop session: runtime could not be confirmed stopped')
    expect(facade.getState().lastError).toBeNull()
    facade.reportSessionError('session-1', 'Failed to stop session: runtime could not be confirmed stopped')
    expect(facade.getState().lastError).toBe('Failed to stop session: runtime could not be confirmed stopped')
    facade.subscribeToAgent('session-2')
    expect(facade.getState().targetAgentId === 'session-2' ? facade.getState().lastError : null).toBeNull()
    await until(() => facade.getState().targetAgentId === 'session-2')
    expect(facade.getState().lastError).toBeNull()
  })
})

// Batch 3 failures: native controls accidentally use selected-session legacy RPC;
// optimistic counts mask rejection; cached sidebar fields or detail pins disappear.
describe('native session state controls', () => {
  it('addresses rename, session/message pins and read controls through native receipts', async () => {
    const { server, facade } = await environment()
    const rename = facade.renameSession('session-1', 'Renamed').catch(() => {})
    facade.markUnread('session-1')
    facade.pinMessage('session-1', 'item-1', true)
    facade.clearAllPins('session-1')
    facade.markAllRead('project-1')
    await until(() => server.inputs.some(e => e.method === 'session.update'))
    expect(server.inputs.find(e => e.method === 'session.update')?.input).toMatchObject({ sessionId: 'session-1', title: 'Renamed', commandId: expect.any(String) })
    await until(() => server.inputs.some(e => e.method === 'project.readState.clear'))
    expect(server.inputs.find(e => e.method === 'session.message.pin')?.input).toMatchObject({ sessionId: 'session-1', itemId: 'item-1', pinned: true })
    expect(server.inputs.find(e => e.method === 'session.pins.clear')?.input).toMatchObject({ sessionId: 'session-1' })
    expect(server.inputs.find(e => e.method === 'session.readState.set' && (e.input as { read: boolean }).read === false)?.input).toMatchObject({ sessionId: 'session-1', read: false })
    expect(server.inputs.find(e => e.method === 'project.readState.clear')?.input).toMatchObject({ projectId: 'project-1' })
    expect(server.inputs.some(e => e.method.startsWith('legacy.'))).toBe(false)
    await rename
  })
  it('keeps authoritative unread until the shell acknowledges the requested state', async () => {
    const { facade } = await environment()
    const before = facade.getState().unreadCounts['session-1'] ?? 0
    facade.markUnread('session-1')
    expect(facade.getState().unreadCounts['session-1'] ?? 0).toBe(before)
  })
})
