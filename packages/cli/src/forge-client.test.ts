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

  it('requires pairing for session controls while API-key HTTP reads remain supported', async () => {
    const client = new ForgeClient({ url: 'http://127.0.0.1:47287', apiKey: 'secret' })
    await expect(client.run({ command: 'run', target: { kind: 'session', agentId: 'session-1' }, text: 'hello' })).rejects.toMatchObject({ code: 'pairing_required', exitCode: 23 })
  })
})
