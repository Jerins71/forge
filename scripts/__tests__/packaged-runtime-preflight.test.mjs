
import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateStagedBetterSqlite3PackageDir } from '../../apps/electron/scripts/build-all.mjs'
import { assertResolvedInsideStage } from '../../apps/electron/scripts/staged-native-runtime-smoke.mjs'

describe('staged Electron-as-Node native runtime smoke', () => {

  it('accepts only entries physically inside staged node_modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-native-stage-'))
    const stagedNodeModules = join(root, 'stage', 'node_modules')
    const stagedEntry = join(stagedNodeModules, 'sharp', 'index.js')
    const repoFallback = join(root, 'node_modules', 'sharp', 'index.js')
    await mkdir(dirname(stagedEntry), { recursive: true })
    await mkdir(dirname(repoFallback), { recursive: true })
    await writeFile(stagedEntry, 'module.exports = {}')
    await writeFile(repoFallback, 'module.exports = {}')

    expect(assertResolvedInsideStage(stagedEntry, stagedNodeModules, 'sharp')).toBe(realpathSync(stagedEntry))
    expect(() => assertResolvedInsideStage(repoFallback, stagedNodeModules, 'sharp')).toThrow(
      'sharp resolved outside staged node_modules',
    )
  })
})

describe('validateStagedBetterSqlite3PackageDir', () => {
  it('requires the package implementation and Electron native binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-better-sqlite3-'))

    await mkdir(join(root, 'lib'), { recursive: true })
    await mkdir(join(root, 'build', 'Release'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(root, 'lib', 'database.js'), 'module.exports = function Database() {}')
    await writeFile(join(root, 'build', 'Release', 'better_sqlite3.node'), 'fixture')

    expect(validateStagedBetterSqlite3PackageDir(root)).toBeNull()
  })

  it('rejects staged packages without the native binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-better-sqlite3-missing-'))

    await mkdir(join(root, 'lib'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(root, 'lib', 'database.js'), 'module.exports = function Database() {}')

    expect(validateStagedBetterSqlite3PackageDir(root)).toContain('better_sqlite3.node')
  })
})
