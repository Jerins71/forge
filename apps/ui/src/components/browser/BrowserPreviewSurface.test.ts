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
    windowRole: 'main',
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
  vi.useRealTimers()
})

async function render(onOpenManagedBrowser?: () => void): Promise<void> {
  await act(async () => {
    root?.render(createElement(BrowserPreviewSurface, { onOpenManagedBrowser }))
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
  it('stays subscribed while hidden and reveals a preview opened from the Browser workspace', async () => {
    getSnapshot.mockResolvedValueOnce(null)
    await act(async () => {
      root?.render(createElement(BrowserPreviewSurface, { hidden: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-browser-preview-layer]')).toBeNull()

    const withFrame = snapshot({
      cards: [{ ...snapshot().cards[0]!, state: 'updating', frameSequence: 1, hasFrame: true, width: 1, height: 1, ageMsAtDelivery: 0 }],
    })
    await publish(withFrame)
    expect(container.querySelector('[data-browser-preview-layer]')).toBeNull()
    expect(pullFrame).toHaveBeenCalledOnce()

    await act(async () => {
      root?.render(createElement(BrowserPreviewSurface, { hidden: false }))
      await Promise.resolve()
    })
    expect(container.querySelector('[data-browser-preview-layer]')).not.toBeNull()
    expect(container.textContent).toContain('Browser previews')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:preview-1')
  })

  it('does not overwrite a newer live preview with a delayed bootstrap snapshot', async () => {
    let resolveBootstrap!: (value: BrowserPreviewDeckSnapshot | null) => void
    getSnapshot.mockImplementationOnce(() => new Promise((resolve) => { resolveBootstrap = resolve }))
    await render()

    await publish(snapshot())
    await act(async () => {
      resolveBootstrap(null)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-browser-preview-layer]')).not.toBeNull()
    expect(container.textContent).toContain('Browser previews')
  })

  it('does not restore a stale bootstrap deck after a newer live close event', async () => {
    let resolveBootstrap!: (value: BrowserPreviewDeckSnapshot | null) => void
    getSnapshot.mockImplementationOnce(() => new Promise((resolve) => { resolveBootstrap = resolve }))
    await render()

    await publish(null)
    await act(async () => {
      resolveBootstrap(snapshot())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-browser-preview-layer]')).toBeNull()
  })

  it('mounts as a read-only overlay inside the main renderer and routes shell controls narrowly', async () => {
    await render()
    expect(container.querySelector('[data-browser-preview-layer]')).not.toBeNull()
    expect(container.querySelector('section[aria-label="Browser preview overlay"]')).not.toBeNull()
    expect(container.textContent).toContain('Chrome · Agent snapshots')
    expect(container.textContent).toContain('Waiting for agent snapshot · Read-only')
    expect(container.textContent).not.toContain('Live')
    expect(window.electronBridge!.windowRole).toBe('main')

    act(() => (container.querySelector('button[aria-label="Pause previews"]') as HTMLButtonElement).click())
    expect(sendCommand).toHaveBeenCalledWith({ type: 'set-paused', previewGeneration: 1, paused: true })
    expect(container.querySelector('button[aria-label*="Pin preview"]')).toBeNull()
    expect(pullFrame).not.toHaveBeenCalled()
  })

  it('is draggable by its handle and constrains the embedded overlay to the chat layer', async () => {
    await render()
    const surface = container.querySelector('[data-browser-preview-layer]') as HTMLDivElement
    const overlay = container.querySelector('section[aria-label="Browser preview overlay"]') as HTMLElement
    const handle = container.querySelector('button[aria-label="Drag browser preview"]') as HTMLButtonElement & {
      setPointerCapture(pointerId: number): void
      releasePointerCapture(pointerId: number): void
      hasPointerCapture(pointerId: number): boolean
    }
    surface.getBoundingClientRect = () => rect(0, 0, 1_000, 800)
    overlay.getBoundingClientRect = () => {
      const match = overlay.style.transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px/)
      return match ? rect(Number(match[1]), Number(match[2]), 500, 350) : rect(484, 16, 500, 350)
    }
    handle.setPointerCapture = vi.fn()
    handle.releasePointerCapture = vi.fn()
    handle.hasPointerCapture = vi.fn(() => true)

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 9, clientX: 900, clientY: 40, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 9, clientX: 700, clientY: 140, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointerup', { pointerId: 9, clientX: 700, clientY: 140, button: 0 }))
      await Promise.resolve()
    })

    expect(handle.setPointerCapture).toHaveBeenCalledWith(9)
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(9)
    expect(overlay.style.transform).toBe('translate3d(284px, 116px, 0)')
    expect(overlay.classList).toContain('top-0')
    expect(overlay.classList).not.toContain('top-4')

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 10, clientX: 700, clientY: 140, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 10, clientX: 750, clientY: 1_000, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointerup', { pointerId: 10, clientX: 750, clientY: 1_000, button: 0 }))
      await Promise.resolve()
    })
    expect(overlay.style.transform).toBe('translate3d(334px, 442px, 0)')
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

  it('does not create or retain a frame blob when an in-flight pull resolves after unmount', async () => {
    type Frame = {
      previewGeneration: number
      tabId: string
      sequence: number
      mimeType: 'image/png'
      data: string
      width: number
      height: number
      ageMsAtDelivery: number
    }
    let resolvePull!: (frame: Frame) => void
    const pull = new Promise<Frame>((resolve) => { resolvePull = resolve })
    pullFrame.mockImplementationOnce(() => pull)
    await render()
    const withFrame = snapshot({
      cards: [{ ...snapshot().cards[0]!, state: 'updating', frameSequence: 1, hasFrame: true, width: 1, height: 1, ageMsAtDelivery: 0 }],
    })
    await publish(withFrame)
    expect(pullFrame).toHaveBeenCalledOnce()

    act(() => root?.unmount())
    root = null
    resolvePull({ previewGeneration: 1, tabId: 'chrome.profile.7', sequence: 1, mimeType: 'image/png', data: 'eA==', width: 1, height: 1, ageMsAtDelivery: 0 })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('revokes a decoding frame immediately when the embedded overlay unmounts', async () => {
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
    expect(createObjectURL).toHaveBeenCalledOnce()

    act(() => root?.unmount())
    root = null
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
    resolveDecode()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
  })

  it('keeps image age advancing while frequent metadata snapshots arrive', async () => {
    vi.useFakeTimers()
    await render()
    const withFrame = snapshot({
      cards: [{ ...snapshot().cards[0]!, state: 'updating', frameSequence: 1, hasFrame: true, width: 1, height: 1, ageMsAtDelivery: 0 }],
    })
    await publish(withFrame)
    expect(container.textContent).toContain('Last agent snapshot')

    for (let index = 0; index < 61; index += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
        snapshotListener?.({ ...withFrame, cards: [{ ...withFrame.cards[0]! }] })
        await Promise.resolve()
      })
    }

    expect(container.textContent).toContain('Older agent snapshot')
    expect(container.textContent).toMatch(/received 3\d+s ago/)
  })

  it('shows hidden managed sources as background-updating and opens the interactive Browser on request', async () => {
    const onOpenManagedBrowser = vi.fn()
    pullFrame.mockImplementationOnce(async (request: BrowserPreviewFrameAvailable) => ({
      ...request,
      mimeType: 'image/png' as const,
      data: 'eA==',
      width: 1,
      height: 1,
      ageMsAtDelivery: 0,
    }))
    await render(onOpenManagedBrowser)
    await publish(snapshot({
      cards: [{
        tabId: 'managed-1',
        targetAffinity: 'managed-electron',
        label: 'Forge docs',
        lifecycle: 'ready',
        presented: false,
        state: 'updating',
        frameSequence: 1,
        hasFrame: true,
        width: 1,
        height: 1,
        ageMsAtDelivery: 0,
      }],
    }))

    expect(container.textContent).toContain('Managed · Native preview')
    expect(container.textContent).toContain('Updating in background · captured 0s ago · Read-only')
    const open = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Open browser'))!
    await act(async () => {
      open.click()
      await Promise.resolve()
    })
    expect(sendCommand).toHaveBeenCalledWith({ type: 'promote', previewGeneration: 1, tabId: 'managed-1' })
    expect(onOpenManagedBrowser).toHaveBeenCalledOnce()
  })

  it('removes the embedded overlay when main publishes an empty deck', async () => {
    await render()
    act(() => (container.querySelector('button[aria-label="Close browser previews"]') as HTMLButtonElement).click())
    await act(async () => { await Promise.resolve() })
    expect(sendCommand).toHaveBeenCalledWith({ type: 'remove', previewGeneration: 1, tabId: 'chrome.profile.7' })

    await publish(null)
    expect(container.querySelector('[data-browser-preview-layer]')).toBeNull()
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

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect
}

function pointerEvent(type: string, init: { pointerId: number; clientX: number; clientY: number; button: number }): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX: init.clientX, clientY: init.clientY, button: init.button })
  Object.defineProperty(event, 'pointerId', { value: init.pointerId })
  return event
}
