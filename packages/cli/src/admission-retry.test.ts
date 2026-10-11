import { afterEach, describe, expect, it } from 'vitest'
import { startFixtureServer } from '../../client-runtime/src/__tests__/fixture-server.js'
import { ForgeClient } from './forge-client.js'

// An environment refuses a command while an earlier change on the same session is still being
// applied, and marks that conflict retryable. The CLI waits and sends the same command again; any
// other refusal fails at once.
describe('ForgeClient admission conflicts', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
  async function paired() {
    const server = await startFixtureServer(0)
    cleanups.push(() => server.close())
    Object.assign(server.seed.descriptor.capabilities, { cliTransport: true })
    const client = new ForgeClient({
      credential: { environmentId: server.seed.entry.environmentId, baseUrl: server.seed.entry.baseUrl, bearerToken: 'B'.repeat(43), deviceSessionId: server.seed.entry.environmentId },
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname
        if (path.startsWith('/api/cli/sessions/')) return Response.json({ session: { agentId: 'session-1', managerId: 'session-1', profileId: 'forge', displayName: 'session-1' } })
        return fetch(url, init)
      },
    })
    const stops = () => server.inputs.filter(entry => entry.method === 'session.stop').map(entry => (entry.input as { commandId: string }).commandId)
    return { server, client, stops }
  }
  const busy = { code: 'CONFLICT', message: 'Another change to this session is still being applied. Try again in a moment.', retryable: true }

  it('sends the same command again after retryable conflicts, until it is accepted', async () => {
    const { server, client, stops } = await paired()
    server.refuseNext(busy, busy)
    await expect(client.stopSession('session-1')).resolves.toBeDefined()
    expect(stops()).toHaveLength(3)
    expect(new Set(stops()).size).toBe(1)
    expect(server.receipts.get(stops()[0]!)?.state).toBe('succeeded')
  })

  it('fails at once on a conflict the environment does not mark retryable', async () => {
    const { server, client, stops } = await paired()
    server.refuseNext({ code: 'CONFLICT', message: 'Archived sessions must be restored before resuming', retryable: false })
    await expect(client.stopSession('session-1')).rejects.toMatchObject({ code: 'CONFLICT', message: 'Archived sessions must be restored before resuming' })
    expect(stops()).toHaveLength(1)
  })

  it('gives up with the environment\'s own words when the conflict outlasts the wait', async () => {
    const { server, client, stops } = await paired()
    server.refuseNext(...Array.from({ length: 20 }, () => busy))
    await expect(client.stopSession('session-1')).rejects.toMatchObject({ code: 'CONFLICT', message: busy.message })
    expect(new Set(stops()).size).toBe(1)
    expect(stops().length).toBeGreaterThan(3)
  }, 20_000)
})
