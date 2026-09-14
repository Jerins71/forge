import type { BrowserPreviewFramePullRequest } from '@forge/protocol'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { BROWSER_PREVIEW_IPC } from './browser-bridge-contract.js'
import { BrowserHostError, asBrowserHostError } from './browser-errors.js'
import type { BrowserPreviewHost } from './browser-preview-host.js'

export function installBrowserPreviewIpc(options: {
  ipcMain: IpcMain
  getMainWindow(): BrowserWindow | null
  host: BrowserPreviewHost
}): () => void {
  const channels: string[] = []
  const requireWindow = (event: IpcMainInvokeEvent, expected: BrowserWindow | null, message: string): void => {
    if (!expected || expected.isDestroyed() || event.sender !== expected.webContents
      || event.senderFrame === null || event.senderFrame !== event.sender.mainFrame) {
      throw new BrowserHostError('invalid-input', message)
    }
  }
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void => {
    const wrapped = async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        return { __forgeBrowserPreviewIpcResult: true, ok: true, value: await listener(event, ...args) }
      } catch (error) {
        return { __forgeBrowserPreviewIpcResult: true, ok: false, error: asBrowserHostError(error, `Browser Preview IPC ${channel} failed`).toFailure() }
      }
    }
    options.ipcMain.handle(channel, wrapped as Parameters<IpcMain['handle']>[1])
    channels.push(channel)
  }

  handle(BROWSER_PREVIEW_IPC.snapshot, (event) => {
    requireWindow(event, options.getMainWindow(), 'Browser Preview state is restricted to the authoritative Forge renderer')
    return options.host.getSnapshot()
  })
  handle(BROWSER_PREVIEW_IPC.pullFrame, (event, value) => {
    requireWindow(event, options.getMainWindow(), 'Browser Preview frames are restricted to the authoritative Forge renderer')
    return options.host.pullFrame(parsePullRequest(value))
  })

  return () => {
    for (const channel of channels) options.ipcMain.removeHandler(channel)
  }
}

function parsePullRequest(value: unknown): BrowserPreviewFramePullRequest {
  const record = exactRecord(value, ['previewGeneration', 'sequence', 'tabId'], 'Browser Preview frame request')
  return {
    previewGeneration: safeInteger(record.previewGeneration, 'Browser Preview generation'),
    tabId: boundedString(record.tabId, 'Browser Preview tab', 256),
    sequence: safeInteger(record.sequence, 'Browser Preview frame sequence'),
  }
}

function exactRecord(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrowserHostError('invalid-input', `${label} must be an object`)
  const record = value as Record<string, unknown>
  exactKeys(record, keys, label)
  return record
}

function exactKeys(record: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) throw new BrowserHostError('invalid-input', `${label} has unexpected fields`)
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new BrowserHostError('invalid-input', `${label} is invalid`)
  }
  return value
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new BrowserHostError('invalid-input', `${label} is invalid`)
  return Number(value)
}
