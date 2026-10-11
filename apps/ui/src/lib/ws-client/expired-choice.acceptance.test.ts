import { afterEach, expect, it } from 'vitest'
import { createEnvironmentRegistry, createMemoryCredentialStore, createMemoryPersistence } from '@forge/client-runtime'
import { startFixtureServer, until, fixtureWebSocket } from '../../../../../packages/client-runtime/src/__tests__/fixture-server'
import { ManagerWsClient } from '../ws-client'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('presents an expired native choice as a closed row on live updates and fresh bootstrap', async () => {
  const server = await startFixtureServer(); cleanup.push(() => server.close())
  const choice = { choiceId: 'native-choice', agentId: 'session-1', status: 'pending' as const, questions: [{ id: 'q', question: 'Allow?', options: [{ id: 'yes', label: 'Yes' }] }] }
  server.seed.details!['session-1'].choices = [choice]
  const mount = async (source = server) => {
    const registry = createEnvironmentRegistry({ persistence: createMemoryPersistence(), credentials: createMemoryCredentialStore(), fetch: (url, init) => globalThis.fetch(url, init), webSocket: fixtureWebSocket, random: () => .01 })
    cleanup.push(() => registry.dispose()); await registry.register(source.seed.entry); await registry.start()
    const client = registry.get(source.seed.entry.environmentId)
    await until(() => client.connection.getSnapshot().phase === 'online')
    const facade = new ManagerWsClient('', 'session-1', { environmentClient: client }); cleanup.push(() => facade.destroy())
    await until(() => facade.getState().conversationBootstrap.phase === 'ready')
    return { facade, registry }
  }
  const { facade: live, registry } = await mount()
  expect(live.getState().pendingChoiceIds.has(choice.choiceId)).toBe(true)
  server.seed.details!['session-1'].choices = [{ ...choice, status: 'expired' }]
  server.emit({ kind: 'event', streamEpoch: server.seed.descriptor.streamEpoch, sequence: 2, event: { type: 'choice.upsert', choice: { ...choice, status: 'expired' } } }, 'session.subscribe')
  await until(() => !live.getState().pendingChoiceIds.has(choice.choiceId))
  expect(live.getState().messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'choice_request', choiceId: choice.choiceId, status: 'expired', questions: choice.questions })]))
  live.destroy(); await registry.dispose()
  const restarted = await startFixtureServer(1); cleanup.push(() => restarted.close())
  restarted.seed.details!['session-1'].choices = [{ ...choice, status: 'expired' }]
  const { facade: fresh } = await mount(restarted)
  expect(fresh.getState().pendingChoiceIds.has(choice.choiceId)).toBe(false)
  expect(fresh.getState().messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'choice_request', choiceId: choice.choiceId, status: 'expired' })]))
});
