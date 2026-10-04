import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OPEN_HTML_IN_BROWSER_CHANNEL, installOpenHtmlIpc } from '../open-html.js'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'forge-open-html-')))
  tempRoots.push(root)
  return root
}

function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, request: unknown) => unknown>()
  return {
    handlers,
    handle: (channel: string, listener: (event: unknown, request: unknown) => unknown) => { handlers.set(channel, listener) },
    removeHandler: (channel: string) => { handlers.delete(channel) },
  }
}

describe('installOpenHtmlIpc', () => {
  it('opens a validated file for trusted senders only and reports open failures', async () => {
    const root = tempRoot()
    const filePath = path.join(root, 'report.html')
    writeFileSync(filePath, '<html></html>')
    const ipcMain = fakeIpcMain()
    const openPath = vi.fn(async () => '')
    const dispose = installOpenHtmlIpc({ ipcMain, isTrustedSender: (event) => event === 'trusted', openPath })
    const handler = ipcMain.handlers.get(OPEN_HTML_IN_BROWSER_CHANNEL)!

    expect(await handler('untrusted', filePath)).toEqual({ success: false, error: 'Unauthorized' })
    expect(openPath).not.toHaveBeenCalled()
    expect(await handler('trusted', path.join(root, 'missing.html'))).toEqual({ success: false, error: 'File not found' })
    expect(await handler('trusted', filePath)).toEqual({ success: true })
    expect(openPath).toHaveBeenCalledWith(filePath)

    openPath.mockResolvedValueOnce('No application')
    expect(await handler('trusted', filePath)).toEqual({ success: false, error: 'No application' })

    dispose()
    expect(ipcMain.handlers.has(OPEN_HTML_IN_BROWSER_CHANNEL)).toBe(false)
  })
})
