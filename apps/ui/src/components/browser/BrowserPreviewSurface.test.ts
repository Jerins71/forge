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

function card(tabId: string, index: number) {
  return {
    ...snapshot().cards[0]!,
    tabId,
    targetAffinity: index === 0 ? 'managed-electron' as const : 'external-chrome' as const,
    label: index === 0 ? 'Managed tab' : null,
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

async function render(hidden = false): Promise<void> {
  await act(async () => {
    root?.render(createElement(BrowserPreviewSurface, { hidden }))
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
  it('stays subscribed while the Browser workspace hides it and reveals the current automatic preview in Chat', async () => {
    getSnapshot.mockResolvedValueOnce(null)
    await render(true)
    expect(container.querySelector('[data-browser-preview-layer]')).toBeNull()

    const withFrame = snapshot({
      cards: [{ ...snapshot().cards[0]!, state: 'updating', frameSequence: 1, hasFrame: true, width: 1, height: 1, ageMsAtDelivery: 0 }],
    })
    await publish(withFrame)
    expect(container.querySelector('[data-browser-preview-layer]')).toBeNull()
    expect(pullFrame).toHaveBeenCalledOnce()

    await render(false)
    expect(container.querySelector('[data-browser-preview-layer]')).not.toBeNull()
    expect(container.querySelector('[data-browser-preview-stack]')).not.toBeNull()
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
    expect(container.querySelector('[data-browser-preview-stack]')).not.toBeNull()
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

  it('renders a compact frameless cascade instead of a dashboard shell', async () => {
    await render()
    await publish(snapshot({ cards: [card('managed-1', 0), card('chrome-1', 1), card('chrome-2', 2)] }))

    const stack = container.querySelector('section[aria-label="Browser preview stack"]') as HTMLElement
    const cards = [...container.querySelectorAll<HTMLElement>('[data-browser-preview-card]')]
    expect(stack.dataset.cardCount).toBe('3')
    expect(stack.dataset.stackDepth).toBe('2')
    expect(stack.style.width).toContain('23rem')
    expect(stack.style.width).toContain('28px')
    expect(stack.querySelector('header')).toBeNull()
    expect(stack.querySelector('footer')).toBeNull()
    expect(container.querySelector('button[aria-label="Pause previews"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Close browser previews"]')).toBeNull()
    expect(cards).toHaveLength(3)
    expect(cards[0]?.dataset.browserPreviewFront).toBe('true')
    expect(cards.map((element) => element.style.transform)).toEqual([
      'translate3d(0px, 0px, 0)',
      'translate3d(-14px, 14px, 0)',
      'translate3d(-28px, 28px, 0)',
    ])
  })

  it('drags the entire compact stack and constrains it to the Chat layer', async () => {
    await render()
    const surface = container.querySelector('[data-browser-preview-layer]') as HTMLDivElement
    const overlay = container.querySelector('section[aria-label="Browser preview stack"]') as HTMLElement
    const handle = container.querySelector('button[aria-label="Drag browser preview stack"]') as HTMLButtonElement & {
      setPointerCapture(pointerId: number): void
      releasePointerCapture(pointerId: number): void
      hasPointerCapture(pointerId: number): boolean
    }
    surface.getBoundingClientRect = () => rect(0, 0, 1_000, 800)
    overlay.getBoundingClientRect = () => {
      const match = overlay.style.transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px/)
      return match ? rect(Number(match[1]), Number(match[2]), 368, 220) : rect(620, 12, 368, 220)
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
    expect(overlay.style.transform).toBe('translate3d(420px, 112px, 0)')
    expect(overlay.classList).toContain('top-0')

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 10, clientX: 700, clientY: 140, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 10, clientX: 750, clientY: 1_000, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointerup', { pointerId: 10, clientX: 750, clientY: 1_000, button: 0 }))
      await Promise.resolve()
    })
    expect(overlay.style.transform).toBe('translate3d(470px, 572px, 0)')
  })

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
    await publish(snapshot({
      cards: [{ ...snapshot().cards[0]!, state: 'updating', frameSequence: 1, hasFrame: true, width: 1, height: 1, ageMsAtDelivery: 0 }],
    }))
    expect(pullFrame).toHaveBeenCalledOnce()

    act(() => root?.unmount())
    root = null
    resolvePull({ previewGeneration: 1, tabId: 'chrome.profile.7', sequence: 1, mimeType: 'image/png', data: 'eA==', width: 1, height: 1, ageMsAtDelivery: 0 })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('revokes a decoding frame immediately when the embedded surface unmounts', async () => {
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

  it('never retains a same-tab image across preview generations', async () => {
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
    expect(container.textContent).toContain('Snapshot expired')
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
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
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
