import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXTERNAL_CHROME_EXTENSION_ORIGIN, EXTERNAL_CHROME_NATIVE_HOST_NAME } from '@forge/protocol'
import { resolveExternalChromeDataPaths } from '../data-paths.js'
import { sha256 } from '../package-manifest.js'
import { PlatformExecutableTrustVerifier, PosixNativeRegistration, WindowsHashPinnedExecutableTrustVerifier, type ExecutableTrustVerifier, type NativeProcessFacade } from '../registration.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))
async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'forge-external-registration-'))
  roots.push(value)
  return value
}
const trusted: ExecutableTrustVerifier = { verify: async () => 'trusted' }

async function prepareExecutable(dataRoot: string, platform: 'darwin' | 'win32'): Promise<void> {
  const executable = resolveExternalChromeDataPaths(dataRoot, platform).nativeHostExecutable
  await mkdir(path.dirname(executable), { recursive: true })
  await writeFile(executable, 'fixture', { mode: 0o755 })
}

describe('External Chrome native registration', () => {

  it('refuses to overwrite an unowned registration target', async () => {
    const dataRoot = await root()
    const registrationDirectory = path.join(dataRoot, 'fake-chrome', 'NativeMessagingHosts')
    await mkdir(registrationDirectory, { recursive: true })
    await prepareExecutable(dataRoot, 'darwin')
    await writeFile(path.join(registrationDirectory, `${EXTERNAL_CHROME_NATIVE_HOST_NAME}.json`), JSON.stringify({
      name: EXTERNAL_CHROME_NATIVE_HOST_NAME,
      description: 'other',
      path: '/other/host',
      type: 'stdio',
      allowed_origins: [EXTERNAL_CHROME_EXTENSION_ORIGIN],
    }))
    const registration = new PosixNativeRegistration({ platform: 'darwin', dataRoot, registrationDirectory, trustVerifier: trusted })
    expect(await registration.inspect()).toMatchObject({ registration: 'conflict' })
    await expect(registration.repair()).rejects.toThrow(/another installation/u)
    await expect(registration.remove()).rejects.toThrow(/without Forge ownership/u)
  })

  it('trusts an unsigned Windows release host only while its deployed SHA-256 stays pinned', async () => {
    const dataRoot = await root()
    await prepareExecutable(dataRoot, 'win32')
    const paths = resolveExternalChromeDataPaths(dataRoot, 'win32')
    await mkdir(paths.state, { recursive: true })
    await writeFile(paths.installState, JSON.stringify({ nativeSha256: sha256(await readFile(paths.nativeHostExecutable)) }))
    const verifier = new WindowsHashPinnedExecutableTrustVerifier(dataRoot)
    expect(await verifier.verify(paths.nativeHostExecutable)).toBe('trusted')
    await writeFile(paths.nativeHostExecutable, 'tampered')
    expect(await verifier.verify(paths.nativeHostExecutable)).toBe('untrusted')
    expect(await verifier.verify(`${paths.nativeHostExecutable}.other`)).toBe('untrusted')
  })

  it('rejects a macOS native host when strict code-signature verification fails', async () => {
    const dataRoot = await root()
    await prepareExecutable(dataRoot, 'darwin')
    const executable = resolveExternalChromeDataPaths(dataRoot, 'darwin').nativeHostExecutable
    const calls: Array<{ command: string; args: string[] }> = []
    const processFacade: NativeProcessFacade = {
      run: async (command, args) => {
        calls.push({ command, args })
        return { stdout: '', stderr: 'invalid signature', exitCode: 1 }
      },
    }
    expect(await new PlatformExecutableTrustVerifier('darwin', processFacade).verify(executable)).toBe('untrusted')
    expect(calls).toEqual([{
      command: '/usr/bin/codesign',
      args: ['--verify', '--strict', '--verbose=2', executable],
    }])
  })
})
