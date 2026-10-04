import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readCliConfig, saveCliConfig, updateCliConfigValue } from './config.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }))
  }))
})

describe('CLI config resolution', () => {

  it('stores local config with restricted POSIX permissions and graceful Windows behavior', async () => {
    const root = await makeTempDir()
    const configPath = path.join(root, 'config.json')
    const posix = await saveCliConfig({ apiKey: 'secret' }, { configPath, platform: 'linux' })
    expect(posix.warnings).toEqual([])
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    await expect(readCliConfig(configPath)).resolves.toMatchObject({ apiKey: 'secret' })

    const windowsPath = path.join(root, 'windows-config.json')
    const windows = await saveCliConfig({ apiKey: 'secret' }, { configPath: windowsPath, platform: 'win32' })
    expect(windows.warnings).toEqual([])
  })

  it('updates and unsets config values', async () => {
    const root = await makeTempDir()
    const configPath = path.join(root, 'config.json')
    await updateCliConfigValue('url', 'http://forge', { configPath })
    await updateCliConfigValue('apiKey', 'key', { configPath })
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({ url: 'http://forge', apiKey: 'key' })
    await updateCliConfigValue('apiKey', undefined, { configPath })
    expect(await readCliConfig(configPath)).toMatchObject({ url: 'http://forge' })
    expect((await readCliConfig(configPath)).apiKey).toBeUndefined()
  })
})

async function makeTempDir(): Promise<string> {
  const dir = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'forge-cli-config-')))
  tempDirs.push(dir)
  return dir
}
