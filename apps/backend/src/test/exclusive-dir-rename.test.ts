import { mkdir, mkdtemp, writeFile, rm, readFile, access, constants } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExclusiveRenameError, exclusiveRenameNoClobber } from '../versioning/exclusive-dir-rename.js'

describe('exclusive-dir-rename error mapping', () => {

  it('fail-closed when createBinding reports missing library/symbol', async () => {
    await expect(
      exclusiveRenameNoClobber('/tmp/src', '/tmp/dst', {
        platform: 'darwin',
        createBinding: () => {
          throw new ExclusiveRenameError('clone_failed', 'Missing renamex_np symbol')
        },
      }),
    ).rejects.toMatchObject({ code: 'clone_failed', message: /Missing renamex_np/ })
  })

  it('never deletes destination on native failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-excl-no-delete-'))
    const destination = join(root, 'dest')
    await mkdir(destination)
    await writeFile(join(destination, 'third-party'), 'keep')

    await expect(
      exclusiveRenameNoClobber(join(root, 'src'), destination, {
        platform: 'linux',
        createBinding: () => ({
          renameExclusive: () => {
            throw new ExclusiveRenameError('destination_exists', 'exists')
          },
        }),
      }),
    ).rejects.toMatchObject({ code: 'destination_exists' })

    await expect(readFile(join(destination, 'third-party'), 'utf8')).resolves.toBe('keep')
    await rm(root, { recursive: true, force: true })
  })
})

describe('exclusive-dir-rename current-host smoke', () => {
  let root = ''

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true })
      root = ''
    }
  })

  it('publishes with the real platform primitive into a temp path', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') {
      return
    }

    root = await mkdtemp(join(tmpdir(), 'forge-excl-smoke-'))
    const source = join(root, 'src')
    const destination = join(root, 'dst')
    await mkdir(source)
    await writeFile(join(source, 'README'), 'ok')

    await exclusiveRenameNoClobber(source, destination)
    await expect(readFile(join(destination, 'README'), 'utf8')).resolves.toBe('ok')
    await expect(access(source, constants.F_OK)).rejects.toBeTruthy()

    // Empty preexisting destination must not be replaced / deleted.
    const blocked = join(root, 'blocked')
    const otherSrc = join(root, 'other-src')
    await mkdir(blocked)
    await writeFile(join(blocked, 'mine'), 'safe')
    await mkdir(otherSrc)
    await writeFile(join(otherSrc, 'x'), 'x')
    await expect(exclusiveRenameNoClobber(otherSrc, blocked)).rejects.toMatchObject({
      code: 'destination_exists',
    })
    await expect(readFile(join(blocked, 'mine'), 'utf8')).resolves.toBe('safe')
  })
})
