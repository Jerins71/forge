import { describe, expect, it } from 'vitest'
import {
  createElectronDevelopmentSetupCommands,
  createElectronDevelopmentWorkspaceEnvironment,
} from '../dev-electron.mjs'

describe('Electron development backend routing', () => {
  it('lets every renderer derive the Electron backend host from its own page', () => {
    const environment = createElectronDevelopmentWorkspaceEnvironment({
      environment: { PRESERVED: 'yes' },
    })

    expect(environment).toEqual({
      PRESERVED: 'yes',
      VITE_FORGE_WS_PORT: '47287',
    })
    expect(environment).not.toHaveProperty('VITE_FORGE_WS_URL')
  })

  it('keeps remote mode as a thin network-exposure wrapper around the same routing', () => {
    const environment = createElectronDevelopmentWorkspaceEnvironment({
      environment: { PRESERVED: 'yes' },
      remote: true,
    })

    expect(environment).toEqual({
      PRESERVED: 'yes',
      VITE_FORGE_WS_PORT: '47287',
      FORGE_HOST: '0.0.0.0',
      FORGE_DISABLE_TANSTACK_DEVTOOLS: 'true',
      VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS: 'true',
    })
    expect(environment).not.toHaveProperty('VITE_FORGE_WS_URL')
  })

  it('uses a JavaScript package-manager launcher directly', () => {
    const commands = createElectronDevelopmentSetupCommands({
      environment: { npm_execpath: '/opt/pnpm/bin/pnpm.cjs', FORGE_STREAM_DECK_SETUP_ENABLED: 'true' },
      platform: 'darwin',
    })
    const command = commands.find(({ label }) => label === 'Stream Deck build')

    expect(command.command).toBe(process.execPath)
    expect(command.args).toEqual([
      '/opt/pnpm/bin/pnpm.cjs',
      'run',
      'streamdeck:build',
    ])
  })

  it('does not ask Node to parse a native package-manager executable', () => {
    const commands = createElectronDevelopmentSetupCommands({
      environment: { npm_execpath: '/opt/pnpm/bin/pnpm', FORGE_STREAM_DECK_SETUP_ENABLED: 'true' },
      platform: 'darwin',
    })
    const command = commands.find(({ label }) => label === 'Stream Deck build')

    expect(command.command).toBe('pnpm')
    expect(command.args).toEqual(['run', 'streamdeck:build'])
  })

  it('keeps the Windows command-wrapper path for a native package-manager executable', () => {
    const commands = createElectronDevelopmentSetupCommands({
      environment: {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        npm_execpath: 'C:\\pnpm\\pnpm.exe',
        FORGE_STREAM_DECK_SETUP_ENABLED: 'true',
      },
      platform: 'win32',
    })
    const command = commands.find(({ label }) => label === 'Stream Deck build')

    expect(command.command).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(command.args).toEqual([
      '/d',
      '/s',
      '/c',
      'pnpm.cmd',
      'run',
      'streamdeck:build',
    ])
  })

  it('does not prepare Stream Deck unless explicitly enabled', () => {
    const defaultCommands = createElectronDevelopmentSetupCommands({
      environment: {},
      platform: 'darwin',
    })
    const enabledCommands = createElectronDevelopmentSetupCommands({
      environment: { FORGE_STREAM_DECK_SETUP_ENABLED: ' TrUe ' },
      platform: 'darwin',
    })

    expect(defaultCommands.map(({ label }) => label)).not.toContain('Stream Deck build')
    expect(defaultCommands.map(({ label }) => label)).not.toContain('Stream Deck package')
    expect(enabledCommands.map(({ label }) => label)).toEqual(expect.arrayContaining([
      'Stream Deck build',
      'Stream Deck package',
    ]))
  })

  it('synchronizes the frozen workspace before any build or runtime starts', () => {
    const [command] = createElectronDevelopmentSetupCommands({
      environment: {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        npm_execpath: 'C:\\pnpm\\pnpm.exe',
      },
      platform: 'win32',
    })

    expect(command).toEqual({
      label: 'Workspace dependency sync',
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'pnpm.cmd',
        'install',
        '--frozen-lockfile',
        '--prefer-offline',
      ],
      cwd: expect.any(String),
    })
  })
})
