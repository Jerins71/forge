// `forge pair-link` against a real local pairing channel: the link goes to stdout, the expiry and
// a loopback-only warning to stderr; flags reach the grant; a stopped backend fails plainly.
import type { Writable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startLocalPairingChannel, type LocalPairingRequest } from '../../../../apps/backend/src/environment/access/local-pairing.js'
import { EXIT_CODES } from '../version.js'
import { runCli } from './index.js'
import { parseExpiry } from './pair-link.js'

const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

function io() {
  const sink = () => { const chunks: string[] = []; return { chunks, write: (c: string) => { chunks.push(String(c)); return true }, toString: () => chunks.join('') } }
  return { stdout: sink() as unknown as Writable & { toString(): string }, stderr: sink() as unknown as Writable & { toString(): string } }
}

async function running(baseUrl: string) {
  const dataDir = await mkdtemp(join(tmpdir(), 'forge-pair-link-'))
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }))
  const requests: LocalPairingRequest[] = []
  const channel = await startLocalPairingChannel({
    dataDir,
    publicBaseUrl: baseUrl,
    createGrant: async (request) => {
      requests.push(request)
      const kind = request.kind ?? 'link'
      return {
        baseUrl,
        loopbackOnly: baseUrl.startsWith('http://127.0.0.1'),
        grant: {
          grantId: 'a6a8cae8-1291-4bc5-ab1f-a574c4e6fbd0', environmentId: 'a6a8cae8-1291-4bc5-ab1f-a574c4e6fbd9',
          expiresAt: new Date(Date.now() + (request.expiresInSeconds ?? 600) * 1000).toISOString(), scopes: request.scopes ?? ['session:read'],
          pairingUrl: kind === 'link' ? `${baseUrl}/pair#v=1&secret=s` : null, code: kind === 'code' ? 'ABCD-EFGH-JKMN' : null,
        },
      }
    },
  })
  cleanup.push(() => channel.close())
  return { dataDir, requests, close: () => channel.close() }
}

it('parses expiry durations from 1 to 60 minutes', () => {
  expect(parseExpiry(undefined)).toBe(600)
  expect(parseExpiry('10m')).toBe(600)
  expect(parseExpiry('90s')).toBe(90)
  expect(parseExpiry('1h')).toBe(3600)
  expect(parseExpiry('30')).toBe(1800)
  for (const bad of ['0m', '61m', '2h', '30s', 'soon', '-5m']) expect(() => parseExpiry(bad)).toThrow(/expires/)
})

it('prints a link for a running environment to stdout, with its expiry on stderr', async () => {
  const env = await running('https://dev1.tailnet.ts.net')
  const out = io()
  const exit = await runCli(['pair-link', '--data-dir', env.dataDir], { io: out, env: {} })
  expect(exit).toBe(EXIT_CODES.success)
  expect(out.stdout.toString()).toBe('https://dev1.tailnet.ts.net/pair#v=1&secret=s\n')
  expect(out.stderr.toString()).toMatch(/expires in 10 minutes/i)
  expect(out.stderr.toString()).not.toMatch(/only works on/i)
  expect(env.requests).toEqual([{ kind: 'link' }])
})

it('passes scopes, label, expiry and --code, emits JSON, and warns about a loopback-only address', async () => {
  const env = await running('http://127.0.0.1:47187')
  const out = io()
  const exit = await runCli(['pair-link', '--code', '--scopes', 'session:read,session:operate', '--label', 'Phone', '--expires', '30m', '--json'], { io: out, env: { FORGE_DATA_DIR: env.dataDir } })
  expect(exit).toBe(EXIT_CODES.success)
  expect(env.requests).toEqual([{ kind: 'code', scopes: ['session:read', 'session:operate'], label: 'Phone', expiresInSeconds: 1800 }])
  expect(JSON.parse(out.stdout.toString())).toMatchObject({ code: 'ABCD-EFGH-JKMN', baseUrl: 'http://127.0.0.1:47187', loopbackOnly: true })
  expect(out.stderr.toString()).toMatch(/only works on this machine/i)
})

it('says plainly when no Forge is running for the data directory', async () => {
  const env = await running('https://dev1.tailnet.ts.net')
  await env.close()
  const out = io()
  const exit = await runCli(['pair-link', '--data-dir', env.dataDir], { io: out, env: {} })
  expect(exit).not.toBe(EXIT_CODES.success)
  expect(out.stdout.toString()).toBe('')
  expect(out.stderr.toString()).toMatch(/No running Forge found/)
  expect(await runCli(['pair-link', '--data-dir', 'relative'], { io: io(), env: {} })).toBe(EXIT_CODES.usage)
})
