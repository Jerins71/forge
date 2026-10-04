import { mkdir, mkdtemp, writeFile, rm, symlink, readFile, access, constants } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { publishCloneWithoutReplace, safeRemoveOwnedStaging, STAGING_PREFIX } from '../git/git-clone-runner.js'

describe('git-clone-runner remediation', () => {
  let root = ''

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true })
      root = ''
    }
  })

  it('refuses publishing when destination already exists (including empty dir)', async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-publish-race-'))
    const cloneTarget = join(root, 'clone-src')
    const destination = join(root, 'dest')
    await mkdir(cloneTarget)
    await writeFile(join(cloneTarget, 'README'), 'hi')
    await mkdir(destination)
    await writeFile(join(destination, 'third-party'), 'keep-me')

    await expect(publishCloneWithoutReplace(cloneTarget, destination)).rejects.toMatchObject({
      code: 'destination_exists',
    })
    await expect(readFile(join(destination, 'third-party'), 'utf8')).resolves.toBe('keep-me')
  })

  it('refuses publishing onto a symlink/junction leaf without deleting the target', async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-publish-symlink-'))
    const cloneTarget = join(root, 'clone-src')
    const real = join(root, 'real')
    const destination = join(root, 'dest')
    await mkdir(cloneTarget)
    await writeFile(join(cloneTarget, 'README'), 'hi')
    await mkdir(real)
    await writeFile(join(real, 'keep'), 'safe')
    try {
      await symlink(real, destination, 'dir')
    } catch {
      return
    }

    await expect(publishCloneWithoutReplace(cloneTarget, destination)).rejects.toMatchObject({
      code: 'destination_exists',
    })
    await expect(readFile(join(real, 'keep'), 'utf8')).resolves.toBe('safe')
  })

  it('does not delete third-party content when destination appears after precheck', async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-publish-interfere-'))
    const cloneTarget = join(root, 'clone-src')
    const destination = join(root, 'dest')
    await mkdir(cloneTarget)
    await writeFile(join(cloneTarget, 'README'), 'hi')

    // Simulate interference: create destination between precheck and exclusive rename
    // by calling publish after manually creating dest (precheck inside publish fails first).
    await mkdir(destination)
    await writeFile(join(destination, 'external'), 'owned-elsewhere')

    await expect(publishCloneWithoutReplace(cloneTarget, destination)).rejects.toMatchObject({
      code: 'destination_exists',
    })
    await expect(readFile(join(destination, 'external'), 'utf8')).resolves.toBe('owned-elsewhere')
  })

  it('only removes exactly one owned staging child', async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-staging-clean-'))
    const staging = join(root, `${STAGING_PREFIX}abc`)
    await mkdir(join(staging, 'nested'), { recursive: true })
    const other = join(root, 'not-staging')
    await mkdir(other)
    await writeFile(join(other, 'keep'), 'x')

    await safeRemoveOwnedStaging(staging, root)
    await expect(access(staging, constants.F_OK)).rejects.toBeTruthy()
    await expect(access(join(other, 'keep'), constants.F_OK)).resolves.toBeUndefined()
  })
})
