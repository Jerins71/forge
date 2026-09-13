import type {
  BrowserPreviewFramePullRequest,
  BrowserPreviewOpenRequest,
  BrowserPreviewShellCommand,
} from '@forge/protocol'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { BROWSER_PREVIEW_IPC } from './browser-bridge-contract.js'
import { BrowserHostError, asBrowserHostError } from './browser-errors.js'
import type { BrowserPreviewHost } from './browser-preview-host.js'

export function installBrowserPreviewIpc(options: {
  ipcMain: IpcMain
  getMainWindow(): BrowserWindow | null
  getPreviewWindow(): BrowserWindow | null
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

  handle(BROWSER_PREVIEW_IPC.open, (event, value) => {
    requireWindow(event, options.getMainWindow(), 'Opening Browser Preview is restricted to the authoritative Forge renderer')
    return options.host.open(parseOpenRequest(value))
  })
  handle(BROWSER_PREVIEW_IPC.snapshot, (event) => {
    requireWindow(event, options.getPreviewWindow(), 'Browser Preview state is restricted to the current preview renderer')
    return options.host.getSnapshot()
  })
  handle(BROWSER_PREVIEW_IPC.pullFrame, (event, value) => {
    requireWindow(event, options.getPreviewWindow(), 'Browser Preview frames are restricted to the current preview renderer')
    return options.host.pullFrame(parsePullRequest(value))
  })
  handle(BROWSER_PREVIEW_IPC.command, (event, value) => {
    requireWindow(event, options.getPreviewWindow(), 'Browser Preview commands are restricted to the current preview renderer')
    return options.host.handleCommand(parseCommand(value))
  })

  return () => {
    for (const channel of channels) options.ipcMain.removeHandler(channel)
  }
}

function parseOpenRequest(value: unknown): BrowserPreviewOpenRequest {
  const record = exactRecord(value, ['profileId', 'sessionAgentId', 'tabId', 'workspaceEpoch'], 'Browser Preview open request')
  return {
    workspaceEpoch: safeInteger(record.workspaceEpoch, 'Browser Preview workspace epoch'),
    sessionAgentId: boundedString(record.sessionAgentId, 'Browser Preview session', 128),
    profileId: boundedString(record.profileId, 'Browser Preview profile', 128),
    tabId: boundedString(record.tabId, 'Browser Preview tab', 256),
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

function parseCommand(value: unknown): BrowserPreviewShellCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrowserHostError('invalid-input', 'Browser Preview command must be an object')
  const record = value as Record<string, unknown>
  const type = record.type
  const previewGeneration = safeInteger(record.previewGeneration, 'Browser Preview generation')
  if (type === 'remove' || type === 'promote' || type === 'reveal') {
    exactKeys(record, ['previewGeneration', 'tabId', 'type'], 'Browser Preview command')
    return { type, previewGeneration, tabId: boundedString(record.tabId, 'Browser Preview tab', 256) }
  }
  if (type === 'set-paused') {
    exactKeys(record, ['paused', 'previewGeneration', 'type'], 'Browser Preview command')
    if (typeof record.paused !== 'boolean') throw new BrowserHostError('invalid-input', 'Browser Preview paused value is invalid')
    return { type, previewGeneration, paused: record.paused }
  }
  if (type === 'set-hidden-content') {
    exactKeys(record, ['hidden', 'previewGeneration', 'type'], 'Browser Preview command')
    if (typeof record.hidden !== 'boolean') throw new BrowserHostError('invalid-input', 'Browser Preview hidden-content value is invalid')
    return { type, previewGeneration, hidden: record.hidden }
  }
  if (type === 'set-pinned') {
    exactKeys(record, ['pinned', 'previewGeneration', 'type'], 'Browser Preview command')
    if (typeof record.pinned !== 'boolean') throw new BrowserHostError('invalid-input', 'Browser Preview pin value is invalid')
    return { type, previewGeneration, pinned: record.pinned }
  }
  throw new BrowserHostError('invalid-input', 'Browser Preview command type is invalid')
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
