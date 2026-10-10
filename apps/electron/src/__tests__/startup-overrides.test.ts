import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyElectronStartupOverrides, resolveIsolatedUserDataDir } from '../startup-overrides.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('isolated Electron user data override', () => {
  it('sets absolute userData and nested sessionData paths before startup continues', () => {
    const root = makeTemporaryDirectory()
    const home = path.join(root, 'home')
    const currentUserData = path.join(home, 'Library', 'Application Support', 'Forge')
    const currentSessionData = path.join(currentUserData, 'Session Data')
    const isolatedUserData = path.join(root, 'isolated', 'electron-user-data')
    mkdirSync(currentSessionData, { recursive: true })
    const setPath = vi.fn()
    const app = {
      isPackaged: false,
      getPath: (name: 'home' | 'sessionData' | 'userData') => ({
        home,
        sessionData: currentSessionData,
        userData: currentUserData,
      })[name],
      setPath,
    }

    const env: NodeJS.ProcessEnv = {
      FORGE_ELECTRON_DEV_SERVER_URL: 'http://localhost:49111',
      FORGE_ELECTRON_USER_DATA_DIR: isolatedUserData,
      FORGE_DATA_DIR: path.join(root, 'forge-backend-data'),
    }
    const result = applyElectronStartupOverrides({ app, env })
    const canonicalIsolatedUserData = realpathSync.native(isolatedUserData)

    expect(result).toEqual({
      devServerUrl: 'http://localhost:49111/',
      userDataDir: canonicalIsolatedUserData,
      sessionDataDir: path.join(canonicalIsolatedUserData, 'session-data'),
    })
    expect(env.FORGE_INSTALLATION_STATE_DIR).toBe(path.join(canonicalIsolatedUserData, 'installation'))
    expect(setPath.mock.calls).toEqual([
      ['userData', canonicalIsolatedUserData],
      ['sessionData', path.join(canonicalIsolatedUserData, 'session-data')],
    ])
  })

  it('rejects relative, broad, default, and backend-overlapping directories', () => {
    const root = makeTemporaryDirectory()
    const home = path.join(root, 'home')
    const currentUserData = path.join(home, '.current-electron')
    const backendData = path.join(root, 'backend-data')

    expect(() => resolveIsolatedUserDataDir('relative/data', {
      homeDir: home,
      protectedPaths: [currentUserData, backendData],
    })).toThrow('must be an absolute isolated directory')
    expect(() => resolveIsolatedUserDataDir(path.parse(root).root, {
      homeDir: home,
      protectedPaths: [currentUserData, backendData],
    })).toThrow('must be an absolute isolated directory')
    expect(() => resolveIsolatedUserDataDir(currentUserData, {
      homeDir: home,
      protectedPaths: [currentUserData, backendData],
    })).toThrow('must not overlap existing Forge data')
    expect(() => resolveIsolatedUserDataDir(path.join(backendData, 'electron'), {
      homeDir: home,
      protectedPaths: [currentUserData, backendData],
    })).toThrow('must not overlap existing Forge data')
  })

  it('rejects user data overrides in packaged builds without mutating paths', () => {
    const root = makeTemporaryDirectory()
    const setPath = vi.fn()
    const app = {
      isPackaged: true,
      getPath: (name: 'home' | 'sessionData' | 'userData') => path.join(root, name),
      setPath,
    }

    expect(() => applyElectronStartupOverrides({
      app,
      env: {
        FORGE_ELECTRON_USER_DATA_DIR: path.join(root, 'isolated'),
      },
    })).toThrow('disabled in packaged builds')
    expect(setPath).not.toHaveBeenCalled()
  })
})

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'forge-electron-overrides-'))
  temporaryDirectories.push(directory)
  return directory
}
