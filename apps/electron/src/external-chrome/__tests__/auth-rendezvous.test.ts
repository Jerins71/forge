import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExternalChromeAuthStore, ExternalChromeAuthorityStore, createCurrentUserAccessController, externalChromeUserScope, type CurrentUserAccessController } from '../auth-rendezvous.js'
import { resolveExternalChromeDataPaths } from '../data-paths.js'

const roots: string[] = []
afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'forge-external-auth-'))
  roots.push(value)
  return value
}

const access = createCurrentUserAccessController(process.platform)

describe('External Chrome authentication and authority stores', () => {
  it.skipIf(process.platform === 'win32')('creates and rotates a private 256-bit key without placing it in rendezvous', async () => {
    const dataRoot = await root()
    const store = new ExternalChromeAuthStore(dataRoot, 'darwin', access)
    const first = await store.ensure()
    expect(first.key).toHaveLength(32)
    expect(first.created).toBe(true)
    const paths = resolveExternalChromeDataPaths(dataRoot, 'darwin')
    expect((await stat(paths.authKey)).mode & 0o777).toBe(0o600)
    expect(await store.status()).toBe('secure')

    const second = await store.rotate()
    expect(second.keyId).not.toBe(first.keyId)
    expect(Buffer.from(second.key).toString('base64')).toBe((await readFile(paths.authKey, 'utf8')).trim())
    first.key.fill(0)
    second.key.fill(0)
  }, 60_000)

  it('secures and verifies empty temporary files before writing or publishing credentials', async () => {
    const dataRoot = await root()
    const paths = resolveExternalChromeDataPaths(dataRoot, process.platform)
    const observed: string[] = []
    let rejectVerification = false
    const checkedAccess: CurrentUserAccessController = {
      preparePrivateDirectory: (directory) => access.preparePrivateDirectory(directory),
      securePrivateFile: async (file, prepareDirectory) => {
        expect(file).toContain('.new-')
        expect((await stat(file)).size).toBe(0)
        expect(prepareDirectory).toBe(true)
        observed.push(file)
        // securePrivateFile's contract includes verification, not just mutation.
        await access.securePrivateFile(file, prepareDirectory)
        if (rejectVerification) throw new Error('fixture permissions could not be verified')
      },
      verifyPrivateFile: (file) => access.verifyPrivateFile(file),
    }
    const store = new ExternalChromeAuthStore(dataRoot, process.platform, checkedAccess)
    const first = await store.ensure()
    const restarted = new ExternalChromeAuthStore(dataRoot, process.platform, checkedAccess)
    const retained = await restarted.ensure()
    expect(retained.created).toBe(false)
    expect(retained.keyId).toBe(first.keyId)
    rejectVerification = true
    await expect(restarted.rotate()).rejects.toThrow('permissions could not be verified')
    expect(await restarted.status()).toBe('secure')
    expect(await readdir(paths.auth)).toEqual([path.basename(paths.authKey)])
    expect(observed).toHaveLength(2)
    first.key.fill(0)
    retained.key.fill(0)
  }, 60_000)

  it('enforces one live Desktop authority and permits deterministic stale takeover', async () => {
    const dataRoot = await root()
    let firstAlive = true
    const first = new ExternalChromeAuthorityStore(
      dataRoot, 'linux', 'desktop_first_123', 101, access, (pid) => pid === 101 && firstAlive, () => 1_000,
    )
    const second = new ExternalChromeAuthorityStore(
      dataRoot, 'linux', 'desktop_second_12', 202, access, (pid) => pid === 101 && firstAlive, () => 1_000,
    )
    expect((await first.claim(new Date(10_000).toISOString())).state).toBe('owned')
    expect((await second.claim(new Date(10_000).toISOString())).state).toBe('other-live')
    firstAlive = false
    expect((await second.inspect()).state).toBe('stale')
    expect((await second.claim(new Date(20_000).toISOString())).state).toBe('owned')

    await second.publish({
      schemaVersion: 1,
      endpoint: '/tmp/forge-test.sock',
      epoch: 'epoch_1234567890abcdef',
      expiresAt: new Date(20_000).toISOString(),
      keyId: 'key-test',
      userScope: externalChromeUserScope('linux', 'tester', 501),
      desktopInstanceId: 'desktop_second_12',
      desktopPid: 202,
      protocolMin: 1,
      protocolMax: 1,
    })
    const rendezvous = await second.readRendezvous()
    expect(rendezvous).toMatchObject({ desktopPid: 202, protocolMin: 1, protocolMax: 1 })
    expect(JSON.stringify(rendezvous)).not.toContain('secret')
    expect(JSON.stringify(rendezvous)).not.toContain('base64')
    for (let index = 0; index < 3; index += 1) {
      await second.refresh(new Date(20_000 + index).toISOString())
      await second.publish({ ...rendezvous!, epoch: `epoch_1234567890abcdef_${index}` })
      expect(await access.verifyPrivateFile(second.authorityPath)).toBe('secure')
      expect(await access.verifyPrivateFile(second.rendezvousPath)).toBe('secure')
      expect((await second.readRendezvous())?.epoch).toBe(`epoch_1234567890abcdef_${index}`)
    }
    expect((await readdir(path.dirname(second.rendezvousPath))).sort()).toEqual(['authority.json', 'rendezvous.json'])
  }, 60_000)
})
