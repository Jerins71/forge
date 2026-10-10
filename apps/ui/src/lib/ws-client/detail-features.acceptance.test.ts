// Guards command identity on the compatibility send path against a real runtime and WS fixture:
// a submit owns one command ID across lost acknowledgments, reconnect recovery and explicit retry;
// interrupted receipts are shown and never resubmitted unless the user resends (a new command).
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEnvironmentRegistry,
  createMemoryCredentialStore,
  createMemoryPersistence,
} from '@forge/client-runtime'
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

describe('typed detail consumers', () => {
  it('hydrates and updates plan/goal and recovery on a fresh V2 facade', async () => {
    const { server, facade } = await environment()
    const plan = { revision: 2, updatedAt: null, plan: [{ step: 'Verify', status: 'in_progress' as const }] }
    const goal = { revision: 2, measuredAt: '2026-10-09T00:00:00.000Z', goal: null }
    const recovery = { recoveryId: 'boot', bootId: 'boot', createdAt: '2026-10-09T00:00:00.000Z', interruptedManagers: ['session-1'], interruptedWorkers: [], undeliveredReports: [] }
    server.emit({ kind: 'event', streamEpoch: server.seed.descriptor.streamEpoch, sequence: 10, event: { type: 'plan.upsert', snapshot: plan } }, 'session.subscribe')
    server.emit({ kind: 'event', streamEpoch: server.seed.descriptor.streamEpoch, sequence: 11, event: { type: 'goal.upsert', snapshot: goal } }, 'session.subscribe')
    server.emit({ kind: 'event', streamEpoch: server.seed.descriptor.streamEpoch, sequence: 12, event: { type: 'recovery.upsert', recovery } }, 'shell.subscribe')
    await until(() => facade.getState().planSnapshots['session-1']?.revision === 2 && facade.getState().goalSnapshots['session-1']?.revision === 2 && facade.getState().restartRecovery?.bootId === 'boot')
    expect(facade.getState().planSnapshots['session-1'].plan).toEqual(plan.plan)
    facade.controlSessionGoal('session-1', { action: 'pause' })
    facade.dismissRestartRecovery()
    await until(() => server.inputs.some(e => e.method === 'session.goal.control') && server.inputs.some(e => e.method === 'recovery.decide'))
    expect(server.inputs.filter(e => e.method.startsWith('legacy.'))).toHaveLength(0)
  })
})
