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

  it('shows Update required for a paired protocol-1 host before authenticated reads', async () => {
    const environmentId = '11111111-1111-1111-1111-111111111111';
    const requests: string[] = [];
    const client = new ForgeClient({ credential: { environmentId, baseUrl: 'http://127.0.0.1:47287', bearerToken: 'P'.repeat(43), deviceSessionId: environmentId } as never, fetchImpl: async (url, init) => {
      requests.push(new URL(String(url)).pathname);
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return Response.json({ environmentId, protocolVersion: 1 });
    } });
    await expect(client.getStatus()).rejects.toMatchObject({ message: expect.stringContaining('Update required'), exitCode: 23, code: 'unsupported_protocol' });
    expect(requests).toEqual(['/api/v2/environment']);
  })

  it('requires pairing for session controls while API-key HTTP reads remain supported', async () => {
    const client = new ForgeClient({ url: 'http://127.0.0.1:47287', apiKey: 'secret' })
    await expect(client.run({ command: 'run', target: { kind: 'session', agentId: 'session-1' }, text: 'hello' })).rejects.toMatchObject({ code: 'pairing_required', exitCode: 23 })
  })
})
