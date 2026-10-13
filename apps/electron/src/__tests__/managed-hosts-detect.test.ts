// "Add over SSH" first looks for a Forge already on the host, so it does not install a second one.
// Ways this could fail, each pinned below with a fake SSH runner:
// - a running Forge is missed, or a stopped/older one is offered as pairable;
// - a loopback-only Forge is offered although this app cannot reach it;
// - hostile or malformed output (relative paths, control characters, bad URLs) becomes a target;
// - a data directory path reaches the link script unquoted;
// - a link that names a different address than the detected one is accepted;
// - an SSH failure is mistaken for "nothing installed".
import { describe, expect, it, vi } from 'vitest'
import type { ManagedHostDriver } from '../managed-hosts.js'
import { detectExistingForge, issueExistingForgeLink } from '../managed-hosts-detect.js'

const env = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const grant = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const secret = 's'.repeat(43)

function runner(outputs: Record<string, string | Error>) {
  const scripts: string[] = []
  const run = vi.fn(async (_alias: string, script: string) => {
    scripts.push(script)
    const marker = Object.keys(outputs).find((key) => script.includes(key))
    const value = marker ? outputs[marker]! : ''
    if (value instanceof Error) throw value
    return value
  })
  return { driver: { run } as unknown as Pick<ManagedHostDriver, 'run'>, scripts, run }
}

describe('detectExistingForge', () => {
  it('finds nothing on a host without Forge', async () => {
    const { driver } = runner({ '# forge:detect': '' })
    await expect(detectExistingForge(driver, 'dev1')).resolves.toEqual([])
  })

  it('reports a running Forge with its own HTTPS address as pairable and reachable', async () => {
    const { driver, scripts } = runner({ '# forge:detect': 'FORGE_FOUND\t1\t1\thttps://dev1.tailnet.ts.net\t/home/adam/.forge-v2\n' })
    await expect(detectExistingForge(driver, 'dev1')).resolves.toEqual([
      { dataDir: '/home/adam/.forge-v2', running: true, pairable: true, publicUrl: 'https://dev1.tailnet.ts.net', reachable: true },
    ])
    // Candidates come from the default data directory, the host's installation registry and managed installs.
    expect(scripts[0]).toContain('$HOME/.forge')
    expect(scripts[0]).toContain('forge/installation/registry.json')
    expect(scripts[0]).toContain('runtime.lock')
    expect(scripts[0]).toContain('shared/state/environment/local-pairing.json')
  })

  it('tells loopback-only, older and stopped installs apart', async () => {
    const { driver } = runner({
      '# forge:detect': [
        'FORGE_FOUND\t1\t1\thttp://127.0.0.1:47687\t/home/adam/loopback',
        'FORGE_FOUND\t1\t0\t\t/home/adam/older',
        'FORGE_FOUND\t0\t0\t\t/home/adam/.forge',
      ].join('\n'),
    })
    expect(await detectExistingForge(driver, 'dev1')).toEqual([
      { dataDir: '/home/adam/loopback', running: true, pairable: true, publicUrl: 'http://127.0.0.1:47687', reachable: false },
      { dataDir: '/home/adam/older', running: true, pairable: false, publicUrl: null, reachable: false },
      { dataDir: '/home/adam/.forge', running: false, pairable: false, publicUrl: null, reachable: false },
    ])
  })

  it('ignores malformed and hostile lines', async () => {
    const { driver } = runner({
      '# forge:detect': [
        'noise',
        'FORGE_FOUND\t1\t1\thttps://ok.example\trelative/dir',
        'FORGE_FOUND\t1\t1\tjavascript:alert(1)\t/home/adam/x',
        'FORGE_FOUND\t2\t1\thttps://ok.example\t/home/adam/y',
        'FORGE_FOUND\t1\t1\thttps://ok.example/path?q\t/home/adam/z',
        'FORGE_FOUND\t1\t1\thttps://ok.example\t/home/adam/\u0007bell',
        'FORGE_FOUND\t1\t1\thttps://ok.example\t/home/adam/ok',
        'FORGE_FOUND\t1\t1\thttps://ok.example\t/home/adam/ok',
      ].join('\n'),
    })
    const found = await detectExistingForge(driver, 'dev1')
    expect(found.map((item) => item.dataDir)).toEqual(['/home/adam/ok'])
  })

  it('surfaces an SSH failure instead of reporting nothing installed', async () => {
    const { driver } = runner({ '# forge:detect': new Error('SSH connection failed') })
    await expect(detectExistingForge(driver, 'dev1')).rejects.toThrow(/SSH/)
  })
})

describe('issueExistingForgeLink', () => {
  const forge = { dataDir: "/home/adam/it's here", publicUrl: 'https://dev1.tailnet.ts.net' }

  it('asks the running Forge for a link through its local pairing channel, with the path quoted', async () => {
    const link = `https://dev1.tailnet.ts.net/pair#v=1&environmentId=${env}&grantId=${grant}&secret=${secret}`
    const { driver, scripts } = runner({ '# forge:pair-link': `${link}\n` })
    await expect(issueExistingForgeLink(driver, 'dev1', forge)).resolves.toBe(link)
    expect(scripts[0]).toContain(`'/home/adam/it'\\''s here'`)
    expect(scripts[0]).toContain('/proc/')
    expect(scripts[0]).not.toContain(secret)
  })

  it('refuses a link that names another address or is not a pairing link', async () => {
    for (const output of [
      `https://elsewhere.example/pair#v=1&environmentId=${env}&grantId=${grant}&secret=${secret}`,
      'https://dev1.tailnet.ts.net/pair#v=1',
      'not a url',
      '',
    ]) {
      const { driver } = runner({ '# forge:pair-link': output })
      await expect(issueExistingForgeLink(driver, 'dev1', forge)).rejects.toThrow(/pairing link/i)
    }
  })

  it('explains a refused request from the running Forge', async () => {
    const { driver } = runner({ '# forge:pair-link': new Error('FORGE_PAIRING') })
    await expect(issueExistingForgeLink(driver, 'dev1', forge)).rejects.toThrow(/could not issue/i)
  })
})

describe.skipIf(process.platform === 'win32')('the detection script in a real POSIX shell', () => {
  it('finds the default, registry and managed data directories and reads their state', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { spawnSync } = await import('node:child_process')
    const home = await mkdtemp(join(tmpdir(), 'forge-detect-home-'))
    try {
      const make = async (dir: string, state: { pid?: number; publicBaseUrl?: string } = {}) => {
        await mkdir(join(dir, 'shared/state/environment'), { recursive: true })
        await writeFile(join(dir, 'shared/state/environment/identity.json'), '{}')
        if (state.pid) await writeFile(join(dir, 'runtime.lock'), `${state.pid}\n2026-10-12T00:00:00.000Z\n`)
        if (state.publicBaseUrl) await writeFile(join(dir, 'shared/state/environment/local-pairing.json'), JSON.stringify({ formatVersion: 1, endpoint: '/x', token: 't', pid: state.pid, publicBaseUrl: state.publicBaseUrl }, null, 2))
      }
      await make(join(home, '.forge'))
      const source = join(home, 'src checkout data')
      await make(source, { pid: process.pid, publicBaseUrl: 'https://dev1.tailnet.ts.net' })
      await make(join(home, '.local/share/forge/managed/forge-managed/data'), { pid: 999_999_9 })
      const registry = process.platform === 'darwin' ? join(home, 'Library/Application Support/Forge/installation') : join(home, '.local/state/forge/installation')
      await mkdir(registry, { recursive: true })
      await writeFile(join(registry, 'registry.json'), JSON.stringify({ formatVersion: 1, installationNonce: 'n', instances: { [source]: 'i' } }, null, 2))
      const driver = { run: async (_alias: string, script: string) => {
        const result = spawnSync('sh', ['-s'], { input: script, env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8' })
        if (result.status !== 0) throw new Error(result.stderr)
        return result.stdout
      } } as unknown as Pick<ManagedHostDriver, 'run'>
      expect(await detectExistingForge(driver, 'local')).toEqual([
        { dataDir: join(home, '.forge'), running: false, pairable: false, publicUrl: null, reachable: false },
        { dataDir: source, running: true, pairable: true, publicUrl: 'https://dev1.tailnet.ts.net', reachable: true },
        { dataDir: join(home, '.local/share/forge/managed/forge-managed/data'), running: false, pairable: false, publicUrl: null, reachable: false },
      ])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.platform === 'win32')('the pair-link script against a real local pairing channel', () => {
  it('returns the running Forge\'s link using that Forge\'s own Node', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { execFile } = await import('node:child_process')
    const { startLocalPairingChannel } = await import('../../../backend/src/environment/access/local-pairing.js')
    const dataDir = await mkdtemp(join(tmpdir(), "forge-detect-it's-"))
    const link = `https://dev1.tailnet.ts.net/pair#v=1&environmentId=${env}&grantId=${grant}&secret=${secret}`
    const requests: unknown[] = []
    const channel = await startLocalPairingChannel({ dataDir, publicBaseUrl: 'https://dev1.tailnet.ts.net', createGrant: async (request) => {
      requests.push(request)
      return { baseUrl: 'https://dev1.tailnet.ts.net', loopbackOnly: false, grant: { grantId: grant, environmentId: env, expiresAt: new Date().toISOString(), scopes: ['session:read'], pairingUrl: link, code: null } }
    } })
    try {
      await writeFile(join(dataDir, 'runtime.lock'), `${process.pid}\n`)
      // Asynchronous: the channel answers from this same process.
      const driver = { run: (_alias: string, script: string) => new Promise<string>((resolve, reject) => {
        const child = execFile('sh', ['-s'], { env: { PATH: '/usr/bin:/bin' } }, (error, stdout, stderr) => (error ? reject(new Error(stderr)) : resolve(stdout)))
        child.stdin!.end(script)
      }) } as unknown as Pick<ManagedHostDriver, 'run'>
      await expect(issueExistingForgeLink(driver, 'local', { dataDir, publicUrl: 'https://dev1.tailnet.ts.net' })).resolves.toBe(link)
      expect(requests).toEqual([{ kind: 'link', label: 'Forge Desktop' }])
    } finally {
      await channel.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
