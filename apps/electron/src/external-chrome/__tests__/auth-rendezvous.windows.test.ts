import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ExternalChromeAuthStore,
  ExternalChromeAuthorityStore,
  ProcessCommandRunner,
  WindowsCurrentUserAccessController,
} from '../auth-rendezvous.js'
import { resolveExternalChromeDataPaths } from '../data-paths.js'

// Real NTFS/PowerShell qualification, using only disposable fixture data. No
// native registration, live Forge data directory, Chrome, or user credentials.
const roots: string[] = []
const runner = new ProcessCommandRunner()
const access = new WindowsCurrentUserAccessController(runner)
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "forge-acl-fixture's [test]-"))
  roots.push(value)
  return value
}
async function powershell(target: string, script: string[]): Promise<string> {
  return runner.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    "$ErrorActionPreference='Stop'",
    `$target='${target.replaceAll("'", "''")}'`,
    '$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    ...script,
  ].join(';')])
}
async function addGrant(file: string, sid: string, rights = 'ReadAndExecute'): Promise<void> {
  await powershell(file, [
    '$acl=Get-Acl -LiteralPath $target',
    `$sid=New-Object System.Security.Principal.SecurityIdentifier('${sid}')`,
    `$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'${rights}','Allow')))`,
    '(Get-Item -LiteralPath $target -Force).SetAccessControl($acl)',
  ])
}

// These tests must also run on Windows; a macOS mock pass is not ACL evidence.
describe.skipIf(process.platform !== 'win32')('External Chrome real Windows permission lifecycle', () => {

  it('rejects other users, broad groups, and insufficient owner access', async () => {
    const file = path.join(await root(), 'fixture.key')
    await writeFile(file, 'not-a-credential')
    for (const sid of ['S-1-1-0', 'S-1-5-32-545', 'S-1-5-21-111-222-333-1001']) {
      await access.securePrivateFile(file)
      await addGrant(file, sid)
      expect(await access.verifyPrivateFile(file)).toBe('insecure')
    }
    await access.securePrivateFile(file)
    await powershell(file, [
      '$acl=New-Object System.Security.AccessControl.FileSecurity',
      '$acl.SetAccessRuleProtection($true,$false)',
      "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me,'Read','Allow')))",
      '(Get-Item -LiteralPath $target -Force).SetAccessControl($acl)',
    ])
    expect(await access.verifyPrivateFile(file)).toBe('insecure')
    await access.securePrivateFile(file)
  }, 30_000)

  it('keeps keys and repeated atomic rendezvous/authority replacements private across store recreation', async () => {
    const fixture = await root()
    const dataRoot = path.join(fixture, 'data')
    const paths = resolveExternalChromeDataPaths(dataRoot, 'win32')
    const key = await new ExternalChromeAuthStore(dataRoot, 'win32', access).ensure()
    const retained = await new ExternalChromeAuthStore(dataRoot, 'win32', access).ensure()
    expect(retained.created).toBe(false)
    expect(retained.keyId).toBe(key.keyId)
    key.key.fill(0)
    retained.key.fill(0)
    const authority = new ExternalChromeAuthorityStore(
      dataRoot, 'win32', 'desktop_fixture_123', 101, access, () => true, () => 1_000,
      path.join(fixture, 'user-authority', 'owner.json'),
    )
    await authority.claim(new Date(20_000).toISOString())
    for (let index = 0; index < 3; index += 1) {
      await authority.refresh(new Date(20_000 + index).toISOString())
      await authority.publish({
        schemaVersion: 1, endpoint: '\\\\.\\pipe\\forge-fixture-only', epoch: `fixture_epoch_1234567890_${index}`,
        expiresAt: new Date(20_000 + index).toISOString(), keyId: key.keyId,
        userScope: 'user_fixture', desktopInstanceId: 'desktop_fixture_123', desktopPid: 101,
        protocolMin: 1, protocolMax: 1,
      })
      expect(await access.verifyPrivateFile(paths.authKey)).toBe('secure')
      expect(await access.verifyPrivateFile(authority.authorityPath)).toBe('secure')
      expect(await access.verifyPrivateFile(paths.rendezvous)).toBe('secure')
      expect((await authority.readRendezvous())?.epoch).toBe(`fixture_epoch_1234567890_${index}`)
      // A replacement must not depend on the previous destination's ACL.
      await addGrant(paths.rendezvous, 'S-1-5-5-0-55312928')
    }
    expect(await readdir(paths.run)).toEqual(['rendezvous.json'])
    await authority.withdraw()
  }, 60_000)
})
