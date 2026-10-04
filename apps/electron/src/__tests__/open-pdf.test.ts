import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OPEN_PDF_IN_DEFAULT_APP_CHANNEL, installOpenPdfIpc } from '../open-pdf.js'
import { handleMainRendererWindowOpen } from '../window-open-policy.js'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'forge-open-pdf-'))
  tempRoots.push(root)
  return root
}

function writePdf(root: string, name = 'spec.pdf', contents = '%PDF-1.4\n'): string {
  const filePath = path.join(root, name)
  writeFileSync(filePath, contents)
  return realpathSync(filePath)
}

describe('installOpenPdfIpc', () => {
  it('restricts PDF opening to the trusted renderer and only regular PDF files', async () => {
    const root = tempRoot()
    const pdfPath = writePdf(root)
    const handlers = new Map<string, (event: unknown, request: unknown) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, listener: (event: unknown, request: unknown) => unknown) => {
        handlers.set(channel, listener)
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    }
    const openPath = vi.fn(async () => '')
    const trustedEvent = { sender: 'trusted' }
    const dispose = installOpenPdfIpc({
      ipcMain,
      isTrustedSender: (event) => event === trustedEvent,
      openPath,
      tmpdir: root,
    })
    const invoke = handlers.get(OPEN_PDF_IN_DEFAULT_APP_CHANNEL)
    if (!invoke) throw new Error('Expected PDF open IPC handler')

    await expect(invoke({ sender: 'guest' }, { filePath: pdfPath })).resolves.toEqual({
      success: false,
      error: 'Unauthorized',
    })
    expect(openPath).not.toHaveBeenCalled()

    await expect(invoke(trustedEvent, { filePath: pdfPath })).resolves.toEqual({ success: true })
    expect(openPath).toHaveBeenCalledWith(pdfPath)

    openPath.mockClear()
    await expect(invoke(trustedEvent, { filePath: '/bin/sh' })).resolves.toEqual({
      success: false,
      error: 'Not a PDF file',
    })
    await expect(invoke(trustedEvent, { filePath: root })).resolves.toEqual({
      success: false,
      error: 'Not a PDF file',
    })
    expect(openPath).not.toHaveBeenCalled()

    dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(OPEN_PDF_IN_DEFAULT_APP_CHANNEL)
  })
})

describe('window-open PDF policy', () => {
  it('denies renderer blob, file, and javascript URLs and never forwards them to shell.openExternal', () => {
    const openExternal = vi.fn(async () => undefined)
    for (const url of [
      'blob:https://forge.example.test/pdf',
      'file:///tmp/spec.pdf',
      'javascript:alert(1)',
    ]) {
      expect(handleMainRendererWindowOpen(url, {
        openExternal,
        handleDeepLink: () => false,
      })).toEqual({ action: 'deny' })
    }
    expect(openExternal).not.toHaveBeenCalled()
  })
})
