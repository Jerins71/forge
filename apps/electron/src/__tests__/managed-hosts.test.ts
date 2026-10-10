import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createManagedHostService,
  type ManagedHostDriver,
} from '../managed-hosts.js'
import {
  installManagedHostsIpc,
  createManagedHostsBridge,
} from '../managed-hosts-ipc.js'
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const hash = 'a'.repeat(64)
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'forge-managed-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  let hostFailure: Error | null = null,
    timeout = false,
    revoked = false,
    interrupted = false
  let uploads = 0,
    grants = 0,
    tunnels = 0,
    busy = false
  const scripts: string[] = []
  const driver: ManagedHostDriver = {
    run: vi.fn(async (_host, script) => {
      scripts.push(script)
      if (hostFailure) throw hostFailure
      if (script.includes('# forge:preflight')) return '/home/test\n'
      if (script.includes('# forge:install')) {
        if (interrupted) {
          interrupted = false
          throw new Error('Connection lost')
        }
        return ''
      }
      if (script.includes('# forge:grant')) {
        grants++
        return timeout
          ? ''
          : `http://127.0.0.1:47788/pair?environmentId=${id}&grantId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb#secret=${'a'.repeat(43)}`
      }
      return ''
    }),
    upload: vi.fn(async () => {
      uploads++
    }),
    tunnel: vi.fn(async () => {
      tunnels++
      const port = 51000 + tunnels
      return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: vi.fn(),
        exited: new Promise(() => {}),
      }
    }),
  }
  const credentials = {
    pair: vi.fn(async () => ({
      ok: true as const,
      value: {
        environment: { environmentId: id },
        deviceSession: { deviceSessionId: id },
      },
    })),
    refreshManagedEndpoint: vi.fn(async () => ({
      ok: true as const,
      value: { environmentId: id },
    })),
    session: vi.fn(async () =>
      revoked
        ? {
            ok: false as const,
            error: {
              code: 'UNAUTHENTICATED' as const,
              message: 'Needs pairing',
              retryable: false,
            },
          }
        : {
            ok: true as const,
            value: { deviceSession: { deviceSessionId: id } },
          },
    ),
    remove: vi.fn(async () => ({
      ok: true as const,
      value: { removed: true },
    })),
  }
  const storePath = join(root, 'hosts.json')
  const managedSession = credentials.session.getMockImplementation()!
  Object.assign(credentials, { managedTransport: { session: managedSession } })
  const options = {
    storePath,
    driver,
    credentials: credentials as any,
    clientOrigin: 'app://forge',
    artifact: async () => ({
      version: '0.26.1',
      sha256: hash,
      source: '/test/artifact.tar.gz',
    }),
    verifyArtifact: async () => '/test/artifact.tar.gz',
    health: async () => ({ environmentId: id, forgeVersion: '0.26.1' }),
    assertIdle: async () => {
      if (busy) throw new Error('busy or unknown')
    },
    grantTimeoutMs: 5,
    retry: false,
  }
  const service = createManagedHostService(options)
  cleanups.push(() => service.dispose())
  return {
    service,
    options,
    credentials,
    driver,
    scripts,
    storePath,
    counts: () => ({ uploads, grants, tunnels }),
    failHost: () => {
      hostFailure = new Error('Host key verification failed')
    },
    grantTimeout: () => {
      timeout = true
    },
    revoke: () => {
      revoked = true
    },
    interrupt: () => {
      interrupted = true
    },
    busy: () => {
      busy = true
    },
  }
}
describe('SSH managed host failure acceptance', () => {
  it('rejects host-key mismatch before upload or pairing', async () => {
    const f = await fixture()
    f.failHost()
    const r = await f.service.add({ hostAlias: 'dev1', remotePort: 47788 })
    expect(r).toMatchObject({ ok: false, error: { code: 'HOST_KEY' } })
    expect(f.counts()).toMatchObject({ uploads: 0, grants: 0 })
  })
  it('resumes an interrupted owned install via explicit repair and survives Desktop restart', async () => {
    const f = await fixture()
    f.interrupt()
    expect(
      (await f.service.add({ hostAlias: 'dev1', remotePort: 47788 })).ok,
    ).toBe(false)
    expect((await f.service.repair('dev1')).ok).toBe(true)
    await f.service.dispose()
    const reopened = createManagedHostService(f.options)
    cleanups.push(() => reopened.dispose())
    await reopened.start()
    expect(await reopened.status()).toMatchObject({
      ok: true,
      value: [{ environmentId: id, phase: 'ready' }],
    })
    expect(f.counts().grants).toBe(1)
    expect(
      JSON.parse(await readFile(f.storePath, 'utf8'))[0],
    ).not.toHaveProperty('baseUrl')
  })
  it('cleans private grant and override after grant timeout', async () => {
    const f = await fixture()
    f.grantTimeout()
    expect(
      await f.service.add({ hostAlias: 'dev1', remotePort: 47788 }),
    ).toMatchObject({ ok: false, error: { code: 'GRANT_TIMEOUT' } })
    expect(f.scripts.some((s) => s.includes('# forge:steady'))).toBe(true)
    expect(await readFile(f.storePath, 'utf8')).not.toContain('secret')
  })
  it('revocation shows Needs pairing and tunnel reconnect never creates a grant', async () => {
    const f = await fixture()
    await f.service.add({ hostAlias: 'dev1', remotePort: 47788 })
    f.revoke()
    await f.service.dispose()
    const reopened = createManagedHostService(f.options)
    cleanups.push(() => reopened.dispose())
    await reopened.start()
    expect(await reopened.status()).toMatchObject({
      ok: true,
      value: [{ phase: 'needs-pairing' }],
    })
    expect(f.counts().grants).toBe(1)
  })
  it('updates only on explicit idle check and remove never stops the host', async () => {
    const f = await fixture()
    await f.service.add({ hostAlias: 'dev1', remotePort: 47788 })
    f.busy()
    expect(await f.service.update('dev1')).toMatchObject({
      ok: false,
      error: { code: 'BUSY_OR_UNKNOWN' },
    })
    f.scripts.length = 0
    expect(await f.service.removeConnection('dev1')).toEqual({
      ok: true,
      value: { removed: true },
    })
    expect(f.scripts).toEqual([])
    expect(f.credentials.remove).toHaveBeenCalledWith(id)
  })
  it('updates through SSH when the ordinary v2 credential bridge blocks the v1 remote', async () => {
    const f = await fixture()
    await f.service.add({ hostAlias: 'dev1', remotePort: 47788 })
    f.credentials.session.mockImplementation(async () => ({ ok: false, error: { code: 'PROTOCOL_MISMATCH', message: 'Update required', retryable: false } }) as never)
    f.scripts.length = 0
    expect(await f.service.update('dev1')).toMatchObject({ ok: true, value: { phase: 'ready' } })
    expect(f.scripts.some(script => script.includes('# forge:install'))).toBe(true)
    expect(f.counts().grants).toBe(1)
  })
  it('rejects untrusted IPC and gives preload the same typed contract', async () => {
    const f = await fixture()
    const handlers = new Map<string, Function>()
    const ipcMain = {
      handle: (name: string, fn: Function) => handlers.set(name, fn),
      removeHandler: (name: string) => handlers.delete(name),
    }
    const dispose = installManagedHostsIpc({
      ipcMain,
      service: f.service,
      isTrustedSender: () => false,
    })
    const bridge = createManagedHostsBridge({
      invoke: async (channel, input) => handlers.get(channel)!({}, input),
      on: vi.fn(),
      removeListener: vi.fn(),
    })
    expect(
      await bridge.add({ hostAlias: 'dev1', remotePort: 47788 }),
    ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(f.counts().uploads).toBe(0)
    dispose()
  })
})
it('retries local port conflict with a new loopback endpoint before pairing', async () => {
  const f = await fixture()
  const original = f.driver.tunnel
  let calls = 0
  f.driver.tunnel = async (...args) => {
    if (++calls === 1)
      throw new Error('bind [127.0.0.1]: Address already in use')
    return original(...args)
  }
  expect(
    await f.service.add({ hostAlias: 'dev1', remotePort: 47788 }),
  ).toMatchObject({
    ok: true,
    value: { phase: 'ready', baseUrl: 'http://127.0.0.1:51001' },
  })
  expect(calls).toBe(2)
  expect(f.credentials.pair).toHaveBeenCalledOnce()
})
it('repair restores a stopped owned service without creating another grant', async () => {
  const f = await fixture()
  await f.service.add({ hostAlias: 'dev1', remotePort: 47788 })
  f.scripts.length = 0
  expect((await f.service.repair('dev1')).ok).toBe(true)
  expect(f.scripts.some((s) => s.includes('# forge:ensure-service'))).toBe(true)
  expect(f.counts().grants).toBe(1)
})
it('explicit repair of a revoked unused host can create one grant, while ordinary reconnect cannot', async () => {
  const f = await fixture()
  await f.service.add({ hostAlias: 'dev1', remotePort: 47788 })
  f.revoke()
  f.credentials.pair.mockImplementationOnce(
    async () =>
      ({
        ok: false as const,
        error: {
          code: 'UNAVAILABLE' as const,
          message: 'exchange failed',
          retryable: false,
        },
      }) as any,
  )
  expect((await f.service.repair('dev1')).ok).toBe(false)
  expect(f.counts().grants).toBe(2)
})

it('restores the installed unit after an update restart failure and can repair to the desired artifact', async () => {
  const f = await fixture()
  await f.service.add({ hostAlias: 'dev1', remotePort: 47788 })
  f.options.artifact = async () => ({
    version: '0.26.2',
    sha256: 'b'.repeat(64),
    source: '/test/new.tar.gz',
  })
  const original = f.driver.run
  let failed = false
  f.driver.run = async (...args) => {
    if (
      !failed &&
      args[1].includes('# forge:steady') &&
      args[1].includes('forge-server-0.26.2') &&
      args[1].includes('systemctl --user restart')
    ) {
      failed = true
      f.scripts.push(args[1])
      throw new Error('restart failed')
    }
    return original(...args)
  }
  f.scripts.length = 0
  expect((await f.service.update('dev1')).ok).toBe(false)
  expect(
    f.scripts
      .filter((s) => s.includes('# forge:steady'))
      .map((s) => s.includes('forge-server-0.26.2')),
  ).toEqual([true, false])
  expect(
    JSON.parse(await readFile(f.storePath, 'utf8'))[0].installedVersion,
  ).toBe('0.26.1')
  f.options.health = async () => ({
    environmentId: id,
    forgeVersion: '0.26.2',
  })
  expect(await f.service.repair('dev1')).toMatchObject({
    ok: true,
    value: { phase: 'ready', installedVersion: '0.26.2' },
  })
})
it('repairs from the verified installed artifact when no desired archive is configured', async () => {
  const f = await fixture()
  await f.service.add({ hostAlias: 'dev1', remotePort: 47788 })
  f.options.artifact = async () => null as any
  expect(await f.service.repair('dev1')).toMatchObject({
    ok: true,
    value: { phase: 'ready', installedVersion: '0.26.1' },
  })
})
it('awaits an in-flight reconnect before repair and closes every resulting tunnel on dispose', async () => {
  const f = await fixture()
  await f.service.add({ hostAlias: 'dev1', remotePort: 47788 })
  await f.service.dispose()
  const original = f.driver.tunnel
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let opens = 0
  const created: Awaited<ReturnType<typeof original>>[] = []
  f.driver.tunnel = async (...args) => {
    if (++opens === 1) await gate
    const t = await original(...args)
    created.push(t)
    return t
  }
  const reopened = createManagedHostService(f.options)
  cleanups.push(() => reopened.dispose())
  const starting = reopened.start()
  await vi.waitFor(() => expect(opens).toBe(1))
  const repairing = reopened.repair('dev1')
  await new Promise((resolve) => setTimeout(resolve, 10))
  const openedDuringReconnect = opens
  release()
  await starting
  await repairing
  await reopened.dispose()
  expect(openedDuringReconnect).toBe(1)
  expect(created.every((t) => vi.mocked(t.close).mock.calls.length === 1)).toBe(
    true,
  )
})
it.each([1, 2])(
  'retries final pairing cleanup once and names Repair if %i cleanup attempt(s) fail',
  async (failures) => {
    const f = await fixture()
    const original = f.driver.run
    let attempts = 0
    f.driver.run = async (...args) => {
      if (
        f.credentials.pair.mock.calls.length &&
        args[1].includes('# forge:steady') &&
        args[1].includes('systemctl --user restart')
      ) {
        if (++attempts <= failures) throw new Error('cleanup transport failed')
      }
      return original(...args)
    }
    const result = await f.service.add({
      hostAlias: 'dev1',
      remotePort: 47788,
    })
    expect(attempts).toBe(2)
    if (failures === 1)
      expect(result).toMatchObject({ ok: true, value: { phase: 'ready' } })
    else {
      expect(result).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('Repair') },
      })
      expect(await f.service.status()).toMatchObject({
        ok: true,
        value: [{ message: expect.stringContaining('Repair') }],
      })
    }
  },
)
