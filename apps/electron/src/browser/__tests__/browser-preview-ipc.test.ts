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
  it('exposes open only to main and state/frame/commands only to the exact preview main frame', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    const main = windowWithId(10)
    const preview = windowWithId(20)
    const snapshot = { previewGeneration: 2, cards: [] }
    const host = {
      open: vi.fn(async () => snapshot),
      getSnapshot: vi.fn(() => snapshot),
      pullFrame: vi.fn(() => null),
      handleCommand: vi.fn(async () => undefined),
    }
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler)),
      removeHandler: vi.fn(),
    }
    const dispose = installBrowserPreviewIpc({
      ipcMain: ipcMain as never,
      getMainWindow: () => main as never,
      getPreviewWindow: () => preview as never,
      host: host as never,
    })
    const openRequest = { workspaceEpoch: 7, sessionAgentId: 'session-1', profileId: 'profile-1', tabId: 'managed-1' }

    await expect(handlers.get(BROWSER_PREVIEW_IPC.open)!(eventFor(main), openRequest)).resolves.toEqual({
      __forgeBrowserPreviewIpcResult: true, ok: true, value: snapshot,
    })
    expect(host.open).toHaveBeenCalledWith(openRequest)
    await expect(handlers.get(BROWSER_PREVIEW_IPC.open)!(eventFor(preview), openRequest)).resolves.toMatchObject({
      ok: false, error: { code: 'invalid-input' },
    })
    await expect(handlers.get(BROWSER_PREVIEW_IPC.snapshot)!(eventFor(preview))).resolves.toMatchObject({ ok: true, value: snapshot })
    await expect(handlers.get(BROWSER_PREVIEW_IPC.pullFrame)!(eventFor(preview), {
      previewGeneration: 2, tabId: 'managed-1', sequence: 1,
    })).resolves.toMatchObject({ ok: true, value: null })
    expect(host.pullFrame).toHaveBeenCalledWith({ previewGeneration: 2, tabId: 'managed-1', sequence: 1 })
    await expect(handlers.get(BROWSER_PREVIEW_IPC.command)!(eventFor(preview), {
      type: 'set-pinned', previewGeneration: 2, pinned: true,
    })).resolves.toMatchObject({ ok: true })
    expect(host.handleCommand).toHaveBeenCalledWith({ type: 'set-pinned', previewGeneration: 2, pinned: true })

    await expect(handlers.get(BROWSER_PREVIEW_IPC.snapshot)!({
      sender: preview.webContents,
      senderFrame: { detached: false },
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(Object.keys(BROWSER_PREVIEW_IPC).filter((key) => ['open', 'snapshot', 'pullFrame', 'command'].includes(key)).length)
  })

  it('rejects malformed or over-broad request objects before they reach the host', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    const main = windowWithId(10)
    const preview = windowWithId(20)
    const host = { open: vi.fn(), getSnapshot: vi.fn(), pullFrame: vi.fn(), handleCommand: vi.fn() }
    installBrowserPreviewIpc({
      ipcMain: { handle: (channel: string, handler: never) => handlers.set(channel, handler), removeHandler: vi.fn() } as never,
      getMainWindow: () => main as never,
      getPreviewWindow: () => preview as never,
      host: host as never,
    })

    await expect(handlers.get(BROWSER_PREVIEW_IPC.open)!(eventFor(main), {
      workspaceEpoch: 7, sessionAgentId: 'session-1', profileId: 'profile-1', tabId: 'managed-1', url: 'https://forbidden.test',
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(handlers.get(BROWSER_PREVIEW_IPC.pullFrame)!(eventFor(preview), {
      previewGeneration: 2, tabId: 'managed-1', sequence: -1,
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(handlers.get(BROWSER_PREVIEW_IPC.command)!(eventFor(preview), {
      type: 'reveal', previewGeneration: 2, tabId: 'managed-1', arbitrary: true,
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(host.open).not.toHaveBeenCalled()
    expect(host.pullFrame).not.toHaveBeenCalled()
    expect(host.handleCommand).not.toHaveBeenCalled()
  })
})
