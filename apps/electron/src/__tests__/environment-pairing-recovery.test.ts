import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebSocketServer } from 'ws'
import { createEnvironmentCredentialService } from '../environment-credentials-ipc.js'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
it.each([1, 2])(
  'revokes a newly minted session when encryption fails on write %i and rolls back local targets',
  async (failingWrite) => {
    const root = await mkdtemp(join(tmpdir(), 'forge-pair-recovery-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const token = 't'.repeat(43)
    let revoked = false,
      writes = 0
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/v2/environment')
        return res.end(
          JSON.stringify({
            environmentId: id,
            protocolVersion: 1,
            label: 'fixture',
          }),
        )
      if (req.url === '/api/v2/access/challenge')
        return res.end(
          JSON.stringify({ challengeId: id, nonce: 'n'.repeat(43) }),
        )
      if (req.url === '/api/v2/access/exchange')
        return res.end(
          JSON.stringify({
            environment: { environmentId: id, label: 'fixture' },
            deviceSession: {
              deviceSessionId: id,
              deviceName: 'Forge Desktop',
              scopes: ['access:admin'],
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 100000).toISOString(),
            },
            bearerToken: token,
          }),
        )
      expect(req.headers.authorization).toBe('Bearer ' + token)
      if (req.url === '/api/v2/access/ws-ticket')
        return res.end(
          JSON.stringify({
            ticket: 'w'.repeat(43),
            expiresAt: new Date(Date.now() + 10000).toISOString(),
          }),
        )
      res.statusCode = revoked ? 401 : 200
      res.end('{}')
    })
    const ws = new WebSocketServer({
      server,
      path: '/api/v2/rpc',
      handleProtocols: () => 'forge.v2',
    })
    ws.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const request = JSON.parse(raw.toString())
        expect(request.method).toBe('access.devices.revoke')
        expect(request.input).toEqual({ deviceSessionId: id })
        revoked = true
        socket.send(
          JSON.stringify({
            type: 'result',
            requestId: request.requestId,
            output: {
              deviceSessionId: id,
              revokedAt: new Date().toISOString(),
            },
          }),
        )
      }),
    )
    cleanup.push(async () => {
      for (const socket of ws.clients) socket.terminate()
      await new Promise<void>((r) => ws.close(() => r()))
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const storePath = join(root, 'credentials.json')
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => {
        if (++writes === failingWrite)
          throw new Error('synthetic storage failure')
        return Buffer.from(text)
      },
      decryptString: (value: Buffer) => value.toString(),
    }
    const credentials = createEnvironmentCredentialService({
      storePath,
      safeStorage,
    })
    const result = await credentials.pair({
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      environmentId: id,
      deviceName: 'Forge Desktop',
      credential: { kind: 'code', code: 'ABCD-EFGH-JKMN' },
      requestedScopes: ['access:admin'],
    })
    expect(revoked).toBe(true)
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/Repair|pairing/i) },
    })
    expect(JSON.stringify(result)).not.toContain(token)
    expect(await credentials.list()).toMatchObject({ ok: true, value: [] })
    if (failingWrite === 2) {
      const reopened = createEnvironmentCredentialService({
        storePath,
        safeStorage,
      })
      expect(await reopened.list()).toMatchObject({ ok: true, value: [] })
    }
    expect(await readFile(storePath, 'utf8').catch(() => '')).not.toContain(
      token,
    )
  },
)
