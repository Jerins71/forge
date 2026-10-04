/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPreviewDeckSnapshot, BrowserPreviewFrameAvailable } from '@forge/protocol'
import { BrowserPreviewSurface } from './BrowserPreviewSurface'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null
let snapshotListener: ((snapshot: BrowserPreviewDeckSnapshot | null) => void) | null
let frameListener: ((frame: BrowserPreviewFrameAvailable) => void) | null
let getSnapshot: ReturnType<typeof vi.fn>
let pullFrame: ReturnType<typeof vi.fn>
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
    hiddenContent: false,
    cards: [{
      tabId: 'chrome.profile.7',
      targetAffinity: 'managed-electron',
      label: 'Managed tab',
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
    windowRole: 'main',
    platform: 'darwin',
    browserPreview: {
      getSnapshot,
      pullFrame,
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

async function render(hidden = false, onOpenManagedTab?: (tabId: string) => void | Promise<void>): Promise<void> {
  await act(async () => {
    root?.render(createElement(BrowserPreviewSurface, { hidden, onOpenManagedTab }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function publish(next: BrowserPreviewDeckSnapshot | null): Promise<void> {
  await act(async () => {
    snapshotListener?.(next)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('BrowserPreviewSurface', () => {
  it('pulls and decodes current-generation frames, then revokes them on privacy clear', async () => {
    await render()
    const withFrame = snapshot({
      cards: [{ ...snapshot().cards[0]!, state: 'updating', frameSequence: 1, hasFrame: true, width: 1, height: 1, ageMsAtDelivery: 4_000 }],
    })
    await publish(withFrame)

    expect(pullFrame).toHaveBeenCalledWith({ previewGeneration: 1, tabId: 'chrome.profile.7', sequence: 1 })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:preview-1')

    await publish({ ...withFrame, hiddenContent: true, cards: [{ ...withFrame.cards[0]!, hasFrame: false, frameSequence: 0, width: null, height: null, ageMsAtDelivery: null, state: 'paused' }] })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('Preview hidden')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')

    frameListener?.({ previewGeneration: 1, tabId: 'chrome.profile.7', sequence: 2 })
    await act(async () => { await Promise.resolve() })
    expect(pullFrame).toHaveBeenCalledOnce()
  })

})
