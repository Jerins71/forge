import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { macReleaseEntitlementsPath, prepareReleaseExecutable, verifyReleaseSignature } from '../../../native-messaging-host/scripts/release-signing.mjs'

const roots = []

async function executableFixture(name = 'host') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'external-sign-'))
  roots.push(root)
  const executable = path.join(root, name)
  await writeFile(executable, 'synthetic executable fixture')
  return { root, executable }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('External Chrome release signing policy', () => {

  it('signs macOS before staging and verifies the exact Developer ID identity and team', async () => {
    const { executable } = await executableFixture()
    const identity = 'Developer ID Application: Forge Fixture (TEAM123456)'
    const runCommand = vi.fn(async (_command, args) => {
      if (args.includes('--display')) return { stdout: '', stderr: `Authority=${identity}\nTeamIdentifier=TEAM123456\n` }
      return { stdout: '', stderr: '' }
    })
    const signature = await prepareReleaseExecutable(executable, {
      platform: 'darwin', runCommand,
      env: {
        FORGE_EXTERNAL_CHROME_BUILD_MODE: 'release', FORGE_SEA_NODE: process.execPath,
        APPLE_ID: 'fixture@example.test', APPLE_APP_SPECIFIC_PASSWORD: 'synthetic',
        APPLE_TEAM_ID: 'TEAM123456', FORGE_MACOS_SIGNING_IDENTITY: identity,
      },
    })
    expect(signature).toEqual({ scheme: 'developer-id', mode: 'release', verified: true, signer: identity, teamId: 'TEAM123456' })
    expect(runCommand.mock.calls[0][1]).toEqual(expect.arrayContaining([
      '--sign', identity, '--entitlements', macReleaseEntitlementsPath,
    ]))
  })

  it('rejects a structurally valid macOS signature from the wrong team', async () => {
    const { executable } = await executableFixture()
    const identity = 'Developer ID Application: Forge Fixture (TEAM123456)'
    const runCommand = vi.fn(async (_command, args) => args.includes('--display')
      ? { stdout: '', stderr: `Authority=${identity}\nTeamIdentifier=OTHERTEAM00\n` }
      : { stdout: '', stderr: '' })
    await expect(prepareReleaseExecutable(executable, {
      platform: 'darwin', runCommand,
      env: {
        FORGE_EXTERNAL_CHROME_BUILD_MODE: 'release', FORGE_SEA_NODE: process.execPath,
        APPLE_ID: 'fixture@example.test', APPLE_APP_SPECIFIC_PASSWORD: 'synthetic',
        APPLE_TEAM_ID: 'TEAM123456', FORGE_MACOS_SIGNING_IDENTITY: identity,
      },
    })).rejects.toThrow('team mismatch')
  })

  it('marks validation hosts unusable for release but permits explicit validation smoke', async () => {
    const { executable } = await executableFixture()
    const signature = { scheme: 'developer-id', mode: 'validation', verified: false, signer: null, teamId: null }
    await expect(verifyReleaseSignature(executable, signature, { platform: 'darwin' }))
      .rejects.toThrow('not release signed')
    await expect(verifyReleaseSignature(executable, signature, { platform: 'darwin', allowValidation: true }))
      .resolves.toEqual(signature)
  })
})
