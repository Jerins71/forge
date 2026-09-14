import { describe, expect, it, vi } from 'vitest'
import { BROWSER_PREVIEW_IPC } from '../browser-bridge-contract.js'
import { installBrowserPreviewIpc } from '../browser-preview-ipc.js'

function windowWithId(id: number) {
  const mainFrame = { detached: false }
  const webContents = { id, mainFrame }
  return { isDestroyed: () => false, webContents }
}

function eventFor(window: ReturnType<typeof windowWithId>) {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame }
}

describe('browser preview role-scoped IPC', () => {
  it('restricts automatic preview state and frames to the authoritative main frame', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    const main = windowWithId(10)
    const other = windowWithId(20)
    const snapshot = { previewGeneration: 2, cards: [] }
    const host = {
      getSnapshot: vi.fn(() => snapshot),
      pullFrame: vi.fn(() => null),
    }
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler)),
      removeHandler: vi.fn(),
    }
    const dispose = installBrowserPreviewIpc({
      ipcMain: ipcMain as never,
      getMainWindow: () => main as never,
      host: host as never,
    })

    await expect(handlers.get(BROWSER_PREVIEW_IPC.snapshot)!(eventFor(main))).resolves.toMatchObject({ ok: true, value: snapshot })
    await expect(handlers.get(BROWSER_PREVIEW_IPC.pullFrame)!(eventFor(main), {
      previewGeneration: 2, tabId: 'managed-1', sequence: 1,
    })).resolves.toMatchObject({ ok: true, value: null })
    expect(host.pullFrame).toHaveBeenCalledWith({ previewGeneration: 2, tabId: 'managed-1', sequence: 1 })

    for (const channel of [BROWSER_PREVIEW_IPC.snapshot, BROWSER_PREVIEW_IPC.pullFrame]) {
      await expect(handlers.get(channel)!(eventFor(other))).resolves.toMatchObject({
        ok: false, error: { code: 'invalid-input' },
      })
    }
    await expect(handlers.get(BROWSER_PREVIEW_IPC.snapshot)!({
      sender: main.webContents,
      senderFrame: { detached: false },
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed or over-broad frame requests before they reach the host', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    const main = windowWithId(10)
    const host = { getSnapshot: vi.fn(), pullFrame: vi.fn() }
    installBrowserPreviewIpc({
      ipcMain: { handle: (channel: string, handler: never) => handlers.set(channel, handler), removeHandler: vi.fn() } as never,
      getMainWindow: () => main as never,
      host: host as never,
    })

    await expect(handlers.get(BROWSER_PREVIEW_IPC.pullFrame)!(eventFor(main), {
      previewGeneration: 2, tabId: 'managed-1', sequence: -1,
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(handlers.get(BROWSER_PREVIEW_IPC.pullFrame)!(eventFor(main), {
      previewGeneration: 2, tabId: 'managed-1', sequence: 1, arbitrary: true,
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(host.pullFrame).not.toHaveBeenCalled()
  })
})
