import { afterEach, expect, it } from 'vitest'
import { startFixtureServer } from '../../../../packages/client-runtime/src/__tests__/fixture-server.js'
import { assertManagedHostIdle } from '../managed-hosts-idle.js'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f()
})
async function fixture() {
  const server = await startFixtureServer()
  cleanup.push(() => server.close())
  const record = {
    hostAlias: 'test',
    installDir: '/tmp/forge-test',
    installedVersion: '0.26.1',
    artifactSha256: 'a'.repeat(64),
    serviceName: 'forge-test',
    remotePort: 47788,
    environmentId: server.seed.entry.environmentId,
  }
  let pending = false,
    terminal = false
  const credentials = {
    wsTicket: async () => ({ ok: true, value: { ticket: 't'.repeat(43) } }),
    request: async () => ({
      ok: true,
      value: {
        status: 200,
        body: JSON.stringify({
          terminals: terminal ? [{ status: 'running' }] : [],
        }),
      },
    }),
  }
  const driver = {
    run: async () => {
      if (pending) throw new Error('FORGE_BUSY')
      return ''
    },
  }
  return {
    server,
    record,
    credentials,
    driver,
    pending: () => {
      pending = true
    },
    terminal: () => {
      terminal = true
    },
  }
}
it('reads an authenticated complete idle shell and checks host unsettled commands', async () => {
  const f = await fixture()
  await expect(
    assertManagedHostIdle(
      f.credentials as any,
      f.record,
      f.server.seed.entry.baseUrl,
      'app://forge',
      f.driver as any,
    ),
  ).resolves.toBeUndefined()
})
it('fails closed for busy sessions, pending host commands, live terminals and incomplete state', async () => {
  const f = await fixture()
  f.server.seed.shell!.sessions[0].status = 'running'
  await expect(
    assertManagedHostIdle(
      f.credentials as any,
      f.record,
      f.server.seed.entry.baseUrl,
      'app://forge',
      f.driver as any,
    ),
  ).rejects.toThrow()
  f.server.seed.shell!.sessions[0].status = 'idle'
  f.pending()
  await expect(
    assertManagedHostIdle(
      f.credentials as any,
      f.record,
      f.server.seed.entry.baseUrl,
      'app://forge',
      f.driver as any,
    ),
  ).rejects.toThrow()
  const t = await fixture()
  t.terminal()
  await expect(
    assertManagedHostIdle(
      t.credentials as any,
      t.record,
      t.server.seed.entry.baseUrl,
      'app://forge',
      t.driver as any,
    ),
  ).rejects.toThrow()
})

it('allows historical finished workers but rejects a streaming worker in an idle session', async () => {
  const f = await fixture()
  f.server.seed.shell!.sessions[0].workerCount = 1
  f.server.seed.details!['session-1'].workers = [
    { agentId: 'worker-1', title: 'Finished', status: 'terminated' },
  ]
  await expect(
    assertManagedHostIdle(
      f.credentials as any,
      f.record,
      f.server.seed.entry.baseUrl,
      'app://forge',
      f.driver as any,
    ),
  ).resolves.toBeUndefined()
  f.server.seed.details!['session-1'].workers[0].status = 'streaming'
  await expect(
    assertManagedHostIdle(
      f.credentials as any,
      f.record,
      f.server.seed.entry.baseUrl,
      'app://forge',
      f.driver as any,
    ),
  ).rejects.toThrow()
})
