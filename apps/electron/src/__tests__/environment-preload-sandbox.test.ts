import { expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
it.each(['main'])(
  'bundled %s preload exposes its role bridge in the Electron sandbox',
  async (role) => {
    const bundle = await build({
      entryPoints: [resolve('src/preload.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      write: false,
    })
    let exposed: Record<string, unknown> | undefined
    const ipc = {
      sendSync: () => ({
        windowRole: role,
        platform: 'darwin',
        appRuntime: 'installed',
        appStartedAt: new Date().toISOString(),
        backendUrl: 'http://127.0.0.1:49991',
        backendWsUrl: 'ws://127.0.0.1:49991',
        version: '0.26.1',
        secureControlToken: 'synthetic-control'.padEnd(43, 'x'),
      }),
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
    }
    expect(() =>
      runInNewContext(bundle.outputFiles[0].text, {
        require: (name: string) => {
          if (name !== 'electron')
            throw new Error('Unsupported sandbox module: ' + name)
          return {
            contextBridge: {
              exposeInMainWorld: (
                _name: string,
                value: Record<string, unknown>,
              ) => {
                exposed = value
              },
            },
            ipcRenderer: ipc,
          }
        },
        process: { env: {}, versions: process.versions, platform: 'darwin' },
        Buffer,
        URL,
        setTimeout,
        clearTimeout,
        console,
      }),
    ).not.toThrow()
    expect(exposed?.windowRole).toBe(role)
    expect(typeof (exposed?.managedHosts as { status: unknown }).status).toBe('function')
    expect(exposed).toHaveProperty('browserEngine')
    expect(exposed).not.toHaveProperty('externalChrome')
    expect(exposed).not.toHaveProperty('browserAutomation')
  },
)
