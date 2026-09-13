/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPreviewDeckSnapshot, BrowserPreviewFrameAvailable } from '@forge/protocol'
import { BrowserPreviewSurface } from './BrowserPreviewSurface'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null
let snapshotListener: ((snapshot: BrowserPreviewDeckSnapshot) => void) | null
let frameListener: ((frame: BrowserPreviewFrameAvailable) => void) | null
let getSnapshot: ReturnType<typeof vi.fn>
let pullFrame: ReturnType<typeof vi.fn>
let sendCommand: ReturnType<typeof vi.fn>
let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>
const OriginalImage = globalThis.Image
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

function snapshot(overrides: Partial<BrowserPreviewDeckSnapshot> = {}): BrowserPreviewDeckSnapshot {
  return {
    previewGeneration: 1,
    workspaceEpoch: 7,
    sessionAgentId: 'session-1',
    profileId: 'profile-1',
    paused: false,
    hiddenContent: false,
    pinned: false,
    cards: [{
      tabId: 'chrome.profile.7',
      targetAffinity: 'external-chrome',
      label: null,
      lifecycle: 'ready',
      presented: false,
      state: 'waiting',
      frameSequence: 0,
      hasFrame: false,
      width: null,
      height: null,
      ageMsAtDelivery: null,
    }],
    ...overrides,
  }
}

beforeEach(() => {
  snapshotListener = null
  frameListener = null
  getSnapshot = vi.fn(async () => snapshot())
  pullFrame = vi.fn(async (request: BrowserPreviewFrameAvailable) => ({
    ...request,
    mimeType: 'image/png' as const,
    data: 'eA==',
    width: 1,
    height: 1,
    ageMsAtDelivery: 4_000,
  }))
  sendCommand = vi.fn(async () => undefined)
  createObjectURL = vi.fn(() => `blob:preview-${createObjectURL.mock.calls.length}`)
  revokeObjectURL = vi.fn()
  Object.assign(URL, { createObjectURL, revokeObjectURL })
  globalThis.Image = class {
    src = ''
    naturalWidth = 1
    naturalHeight = 1
    decode = vi.fn(async () => undefined)
  } as never
  window.electronBridge = {
    windowRole: 'browser-preview',
    platform: 'darwin',
    browserPreview: {
      getSnapshot,
      pullFrame,
      sendCommand,
      onSnapshotChanged: (listener) => { snapshotListener = listener; return vi.fn() },
      onFrameAvailable: (listener) => { frameListener = listener; return vi.fn() },
    },
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  container.remove()
  delete window.electronBridge
  globalThis.Image = OriginalImage
  Object.assign(URL, { createObjectURL: originalCreateObjectURL, revokeObjectURL: originalRevokeObjectURL })
  vi.clearAllMocks()
})

async function render(): Promise<void> {
  await act(async () => {
    root?.render(createElement(BrowserPreviewSurface))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function publish(next: BrowserPreviewDeckSnapshot): Promise<void> {
  await act(async () => {
    snapshotListener?.(next)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('BrowserPreviewSurface', () => {
  it('mounts as a local-only read-only Chrome placeholder and routes shell controls narrowly', async () => {
    await render()
    expect(container.querySelector('main[aria-label="Forge Browser Previews"]')).not.toBeNull()
    expect(container.textContent).toContain('Chrome · Agent snapshots')
    expect(container.textContent).toContain('Waiting for agent snapshot · Read-only')
    expect(container.textContent).not.toContain('Live')
    expect(window.electronBridge!.backendWsUrl).toBeUndefined()
    expect(window.electronBridge!.browserAutomation).toBeUndefined()

    act(() => (container.querySelector('button[aria-label="Pin preview window on top"]') as HTMLButtonElement).click())
    expect(sendCommand).toHaveBeenCalledWith({ type: 'set-pinned', previewGeneration: 1, pinned: true })
    expect(pullFrame).not.toHaveBeenCalled()
  })

  it('globally pulls and decodes current-generation frames, then revokes them on privacy clear', async () => {
    await render()
    const withFrame = snapshot({
      cards: [{ ...snapshot().cards[0]!, state: 'updating', frameSequence: 1, hasFrame: true, width: 1, height: 1, ageMsAtDelivery: 4_000 }],
    })
    await publish(withFrame)

    expect(pullFrame).toHaveBeenCalledOnce()
    expect(pullFrame).toHaveBeenCalledWith({ previewGeneration: 1, tabId: 'chrome.profile.7', sequence: 1 })
    const image = container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('blob:preview-1')
    expect(image?.getAttribute('alt')).toBe('Read-only last agent snapshot from Chrome')
    expect(container.textContent).toContain('Last agent snapshot · received 4s ago · Read-only')

    await publish({ ...withFrame, hiddenContent: true, cards: [{ ...withFrame.cards[0]!, hasFrame: false, frameSequence: 0, width: null, height: null, ageMsAtDelivery: null, state: 'paused' }] })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('Preview content hidden')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')

    frameListener?.({ previewGeneration: 1, tabId: 'chrome.profile.7', sequence: 2 })
    await act(async () => { await Promise.resolve() })
    expect(pullFrame).toHaveBeenCalledOnce()
  })

  it('never retains a same-tab image across preview generations and reports expired snapshots honestly', async () => {
    await render()
    const withFrame = snapshot({
      cards: [{ ...snapshot().cards[0]!, state: 'updating', frameSequence: 1, hasFrame: true, width: 1, height: 1, ageMsAtDelivery: 0 }],
    })
    await publish(withFrame)
    expect(container.querySelector('img')).not.toBeNull()

    await publish(snapshot({
      previewGeneration: 2,
      cards: [{ ...snapshot().cards[0]!, state: 'expired', frameSequence: 0, hasFrame: false }],
    }))
    expect(container.querySelector('img')).toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
    expect(container.textContent).toContain('Snapshot expired; waiting for agent snapshot')
    expect(container.textContent).toContain('Snapshot expired · waiting for agent snapshot · Read-only')
  })

  it('discards decoded pixels whose current metadata changed while decode was pending', async () => {
    let resolveDecode!: () => void
    const decode = new Promise<void>((resolve) => { resolveDecode = resolve })
    globalThis.Image = class {
      src = ''
      naturalWidth = 1
      naturalHeight = 1
      decode = vi.fn(() => decode)
    } as never
    await render()
    const withFrame = snapshot({
      cards: [{ ...snapshot().cards[0]!, state: 'updating', frameSequence: 1, hasFrame: true, width: 1, height: 1, ageMsAtDelivery: 0 }],
    })
    act(() => snapshotListener?.(withFrame))
    await act(async () => { await Promise.resolve() })
    act(() => snapshotListener?.({ ...withFrame, hiddenContent: true, cards: [{ ...withFrame.cards[0]!, hasFrame: false, frameSequence: 0, state: 'paused' }] }))
    resolveDecode()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(container.querySelector('img')).toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
  })
})
