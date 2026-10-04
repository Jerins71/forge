import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExternalChromeDeployer, type DeployerFileSystem, type DeploymentPhase } from '../deployer.js'
import { EXTERNAL_CHROME_EXTENSION_ID, EXTERNAL_CHROME_PUBLIC_KEY_SHA256, sha256 } from '../package-manifest.js'

const roots: string[] = []
const publicKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoXYQaeqXPEqEz9pYFXGrV9qijfHvEuVdzt/1KGGvwy9HzyYMFv5e3tJUGpCGmo8Zxnzkbx0n/vjVRa6UPRPRMh/k2SxeF3QR0J1Ck2W69XtilMT0yGrgRmIrZ0oE0vJ7U6NEV1sN+z+rfWo8ue4SlTLBUHx9ZJ9BB++8IXKnwbLul/EOuFRdfTam+CAr8iqmTZzhp2P6TDCbYUwNln/nisLjvIVIs9nU/lFyqLid7LXfV2ax4ObSpYNyp2AjSsWczVEEFtp69CLTAFxVncczmlZQ9sXlIwArt1SVgsVK0wIbTeyAjcJ+GF9rAOQmzE9XCmncqhp0/U8NAR7Z4lT0ywIDAQAB'

function treeSha256(files: Record<string, Buffer>): string {
  const hash = createHash('sha256')
  for (const relative of Object.keys(files).sort()) {
    const bytes = files[relative]!
    hash.update(`${relative}\0${bytes.byteLength}\0`)
    hash.update(bytes)
  }
  return hash.digest('hex')
}

async function fixture(
  version = '1.0.0',
  payloadText = `payload-${version}`,
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
  shellText = 'shell',
  nativeText = `native-${version}`,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-external-deploy-'))
  roots.push(root)
  const dataRoot = path.join(root, 'custom-forge-data')
  const resourcesRoot = path.join(root, 'resources')
  const shellFiles: Record<string, string> = {}
  const payloadFiles: Record<string, string> = {}
  const manifestJson = `${JSON.stringify({ manifest_version: 3, key: publicKey })}\n`
  const shell = `${shellText}\n`
  const payloadContents = {
    'content-script.js': Buffer.from(`content-${payloadText}\n`),
    'service-worker.js': Buffer.from(`${payloadText}\n`),
  }
  const native = Buffer.from(nativeText)
  shellFiles['manifest.json'] = sha256(Buffer.from(manifestJson))
  shellFiles['shell/bootstrap.js'] = sha256(Buffer.from(shell))
  for (const [file, bytes] of Object.entries(payloadContents)) payloadFiles[file] = sha256(bytes)
  const payloadSha256 = treeSha256(payloadContents)
  const payloadDirectory = `${version}-${payloadSha256}`
  const executable = platform === 'win32' ? 'forge-external-chrome-native-host.exe' : 'forge-external-chrome-native-host'
  await fs.mkdir(path.join(resourcesRoot, 'extension-shell', 'shell'), { recursive: true })
  await fs.mkdir(path.join(resourcesRoot, 'payload', payloadDirectory), { recursive: true })
  await fs.mkdir(path.join(resourcesRoot, 'native-host', `${platform}-${arch}`), { recursive: true })
  await fs.writeFile(path.join(resourcesRoot, 'extension-shell', 'manifest.json'), manifestJson)
  await fs.writeFile(path.join(resourcesRoot, 'extension-shell', 'shell/bootstrap.js'), shell)
  await Promise.all(Object.entries(payloadContents).map(([file, bytes]) => fs.writeFile(path.join(resourcesRoot, 'payload', payloadDirectory, file), bytes)))
  await fs.writeFile(path.join(resourcesRoot, 'native-host', `${platform}-${arch}`, executable), native)
  const manifest = {
    schemaVersion: 1,
    packageVersion: version,
    extension: {
      extensionId: EXTERNAL_CHROME_EXTENSION_ID,
      publicKeySha256: EXTERNAL_CHROME_PUBLIC_KEY_SHA256,
      minimumChromeVersion: '125', shellAbi: 1, shellSha256: treeSha256({ 'manifest.json': Buffer.from(manifestJson), 'shell/bootstrap.js': Buffer.from(shell) }),
      payloadVersion: version, payloadSha256, payloadDirectory, shellFiles, payloadFiles,
    },
    nativeHost: {
      protocol: { min: 1, max: 1, maxMessageBytes: 1_048_576 }, version: '1', platform, architecture: arch,
      executable, sha256: sha256(native), required: true,
      signature: {
        scheme: platform === 'darwin' ? 'developer-id' : platform === 'win32' ? 'authenticode' : 'packaged-resource-hash',
        mode: 'release', verified: true,
        signer: platform === 'darwin' ? 'Developer ID Application: Fixture (TEAM123456)' : platform === 'win32' ? 'CN=Forge Fixture' : null,
        teamId: platform === 'darwin' ? 'TEAM123456' : null,
      },
    },
    compatibility: { desktop: { min: '0.22.0', max: '0.22.999' }, shellAbi: { min: 1, max: 1 } },
  }
  await fs.writeFile(path.join(resourcesRoot, 'package-manifest.json'), `${JSON.stringify(manifest)}\n`)
  return { root, dataRoot, resourcesRoot, manifest }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('ExternalChromeDeployer', () => {

  it('uses a custom backend data root, is idempotent, and retains current plus N-1 for rollback', async () => {
    const first = await fixture('1.0.0')
    const deployer = new ExternalChromeDeployer({ dataRoot: first.dataRoot, resourcesRoot: first.resourcesRoot })
    await deployer.deploy()
    await deployer.deploy()
    expect(await deployer.canRollback()).toBe(false)
    const stablePath = deployer.paths.extension

    const second = await fixture('1.1.0', 'payload-1.1.0', process.platform, process.arch, 'shell-v2')
    const upgraded = new ExternalChromeDeployer({ dataRoot: first.dataRoot, resourcesRoot: second.resourcesRoot })
    await upgraded.deploy()
    expect(upgraded.paths.extension).toBe(stablePath)
    expect((await fs.readdir(upgraded.paths.payloads)).sort()).toHaveLength(2)
    expect(await fs.access(path.join(upgraded.paths.integrationRoot, 'extension.previous'))).toBeUndefined()
    const selected = JSON.parse(await fs.readFile(path.join(stablePath, 'current.json'), 'utf8'))
    expect(selected.payloadVersion).toBe('1.1.0')
    expect(await upgraded.canRollback()).toBe(true)

    const rolledBack = await upgraded.rollback()
    expect(rolledBack.payloadVersion).toBe('1.0.0')
    expect(JSON.parse(await fs.readFile(path.join(stablePath, 'current.json'), 'utf8')).payloadVersion).toBe('1.0.0')
    expect(await fs.readFile(upgraded.paths.nativeHostExecutable, 'utf8')).toBe('native-1.0.0')

    await fs.writeFile(path.join(stablePath, 'current.json'), '{corrupt')
    await upgraded.recover()
    expect(JSON.parse(await fs.readFile(path.join(stablePath, 'current.json'), 'utf8')).payloadVersion).toBe('1.0.0')
  })

  it('rejects traversal and malformed current, previous, and install state before outside access', async () => {
    const first = await fixture('1.0.0')
    const deployer = new ExternalChromeDeployer({ dataRoot: path.resolve(first.dataRoot), resourcesRoot: first.resourcesRoot })
    await deployer.deploy()
    const second = await fixture('1.1.0')
    await new ExternalChromeDeployer({ dataRoot: path.resolve(first.dataRoot), resourcesRoot: second.resourcesRoot }).deploy()
    const outside = path.join(first.root, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'service-worker.js'), 'outside')
    let outsideTouched = false
    const guardedFs = {
      ...fs,
      readFile: async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
        if (path.resolve(String(target)).startsWith(path.resolve(outside))) outsideTouched = true
        return (fs.readFile as (...values: unknown[]) => Promise<Buffer>)(target, ...args)
      },
      lstat: async (target: Parameters<typeof fs.lstat>[0], ...args: unknown[]) => {
        if (path.resolve(String(target)).startsWith(path.resolve(outside))) outsideTouched = true
        return (fs.lstat as (...values: unknown[]) => ReturnType<typeof fs.lstat>)(target, ...args)
      },
      readdir: async (target: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
        if (path.resolve(String(target)).startsWith(path.resolve(outside))) outsideTouched = true
        return (fs.readdir as (...values: unknown[]) => Promise<string[]>)(target, ...args)
      },
    } as unknown as DeployerFileSystem
    const guarded = new ExternalChromeDeployer({
      dataRoot: path.resolve(first.dataRoot), resourcesRoot: second.resourcesRoot, fs: guardedFs,
    })
    const malicious = {
      schemaVersion: 1, shellAbi: 1, payloadVersion: '1.0.0', payloadSha256: 'a'.repeat(64),
      payloadDirectory: '../../outside', payloadFiles: {
        'content-script.js': sha256(Buffer.from('outside')),
        'service-worker.js': sha256(Buffer.from('outside')),
      },
    }
    await fs.writeFile(path.join(guarded.paths.extension, 'current.json'), JSON.stringify(malicious))
    expect(await guarded.verifyDeployment()).toEqual({ state: 'mismatch' })
    await guarded.recover()
    expect(outsideTouched).toBe(false)

    await fs.writeFile(guarded.paths.previousState, JSON.stringify(malicious))
    expect(await guarded.canRollback()).toBe(false)
    await expect(guarded.rollback()).rejects.toThrow('No valid')
    expect(outsideTouched).toBe(false)

    const install = JSON.parse(await fs.readFile(guarded.paths.installState, 'utf8'))
    install.payloadDirectory = '../../outside'
    await fs.writeFile(guarded.paths.installState, JSON.stringify(install))
    expect(await guarded.verifyDeployment()).toEqual({ state: 'mismatch' })
    await guarded.recover()
    expect(outsideTouched).toBe(false)
  })

  it('recovers an atomic valid selector after a restart at every journal phase', async () => {
    const phases: DeploymentPhase[] = ['validated', 'payload-staged', 'payload-installed', 'shell-staged', 'shell-swapped', 'selector-written', 'native-written', 'complete']
    for (const crashPhase of phases) {
      const index = phases.indexOf(crashPhase)
      const base = await fixture(`0.9.${index}`)
      await new ExternalChromeDeployer({ dataRoot: path.resolve(base.dataRoot), resourcesRoot: base.resourcesRoot }).deploy()
      const input = await fixture(`1.0.${index}`, `payload-1.0.${index}`, process.platform, process.arch, `shell-v2-${index}`)
      const crashing = new ExternalChromeDeployer({
        dataRoot: path.resolve(base.dataRoot), resourcesRoot: input.resourcesRoot,
        afterPhase: (phase) => { if (phase === crashPhase) throw new Error(`crash:${phase}`) },
      })
      await expect(crashing.deploy()).rejects.toThrow(`crash:${crashPhase}`)
      const restarted = new ExternalChromeDeployer({ dataRoot: path.resolve(base.dataRoot), resourcesRoot: input.resourcesRoot })
      await restarted.recover()
      expect(JSON.parse(await fs.readFile(path.join(restarted.paths.extension, 'current.json'), 'utf8'))).toMatchObject({ payloadVersion: `0.9.${index}` })
      expect(await restarted.verifyDeployment()).toMatchObject({ state: 'ready', install: { payloadVersion: `0.9.${index}` } })
      await restarted.deploy()
      const selector = JSON.parse(await fs.readFile(path.join(restarted.paths.extension, 'current.json'), 'utf8'))
      expect(selector.payloadVersion).toBe(`1.0.${index}`)
      await expect(restarted.rollback()).resolves.toMatchObject({ payloadVersion: `0.9.${index}` })
    }
  }, 20_000)

  it('preserves the sole valid payload on ENOSPC and rejects mismatched platform metadata', async () => {
    const input = await fixture('1.0.0')
    const deployed = new ExternalChromeDeployer({ dataRoot: path.resolve(input.dataRoot), resourcesRoot: input.resourcesRoot })
    await deployed.deploy()
    const before = await fs.readdir(deployed.paths.payloads)
    const update = await fixture('1.1.0')
    const failingFs = { ...fs, copyFile: vi.fn(async () => { const error = new Error('full') as NodeJS.ErrnoException; error.code = 'ENOSPC'; throw error }) } as DeployerFileSystem
    await expect(new ExternalChromeDeployer({ dataRoot: path.resolve(input.dataRoot), resourcesRoot: update.resourcesRoot, fs: failingFs }).deploy())
      .rejects.toMatchObject({ code: 'ENOSPC' })
    expect(await fs.readdir(deployed.paths.payloads)).toEqual(before)

    const wrong = await fixture('1.0.0', 'payload', process.platform, 'not-this-arch')
    await expect(new ExternalChromeDeployer({ dataRoot: path.resolve(wrong.dataRoot), resourcesRoot: wrong.resourcesRoot }).deploy())
      .rejects.toThrow('not')
  })
})
