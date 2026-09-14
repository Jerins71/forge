import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import {
  BROWSER_AUTOMATION_MAX_SCREENSHOT_HEIGHT,
  BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH,
  BROWSER_PREVIEW_TOTAL_IMAGE_BYTES,
  type BrowserPreviewCardSnapshot,
  type BrowserPreviewDeckSnapshot,
  type BrowserPreviewFrameAvailable,
  type BrowserPreviewFramePayload,
} from '@forge/protocol'
import { cn } from '@/lib/utils'

interface RenderedFrame {
  sequence: number
  url: string
}

interface OverlayPosition {
  x: number
  y: number
}

interface DragState extends OverlayPosition {
  pointerId: number
  clientX: number
  clientY: number
}

const STACK_STEP_PX = 14

export function BrowserPreviewSurface({ hidden = false }: { hidden?: boolean }) {
  const bridge = window.electronBridge?.browserPreview
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [position, setPosition] = useState<OverlayPosition | null>(null)
  const [snapshot, setSnapshot] = useState<BrowserPreviewDeckSnapshot | null>(null)
  const snapshotRef = useRef<BrowserPreviewDeckSnapshot | null>(null)
  const [frames, setFrames] = useState<Record<string, RenderedFrame>>({})
  const framesRef = useRef<Record<string, RenderedFrame>>({})
  const decodingUrls = useRef(new Set<string>())
  const pending = useRef(new Map<string, BrowserPreviewFrameAvailable>())
  const pulling = useRef<number | null>(null)
  const lifecycle = useRef(0)

  const replaceFrames = useCallback((next: Record<string, RenderedFrame>) => {
    framesRef.current = next
    setFrames(next)
  }, [])

  const applySnapshot = useCallback((next: BrowserPreviewDeckSnapshot | null) => {
    const previous = snapshotRef.current
    const generationChanged = previous?.previewGeneration !== next?.previewGeneration
    const cardsById = new Map(next?.cards.map((card) => [card.tabId, card]) ?? [])
    if (!next || generationChanged || next.hiddenContent) {
      pending.current.clear()
      for (const url of decodingUrls.current) URL.revokeObjectURL(url)
      decodingUrls.current.clear()
    } else {
      for (const [tabId, request] of pending.current) {
        if (request.previewGeneration !== next.previewGeneration || !cardsById.get(tabId)?.hasFrame) pending.current.delete(tabId)
      }
    }
    snapshotRef.current = next
    setSnapshot(next)
    if (!next || generationChanged) setPosition(null)
    const retained: Record<string, RenderedFrame> = {}
    for (const [tabId, frame] of Object.entries(framesRef.current)) {
      const card = cardsById.get(tabId)
      if (next && !generationChanged && !next.hiddenContent && card?.hasFrame && frame.sequence <= card.frameSequence) retained[tabId] = frame
      else URL.revokeObjectURL(frame.url)
    }
    replaceFrames(retained)
    if (!next || next.hiddenContent) return
    for (const card of next.cards) {
      if (card.hasFrame && card.frameSequence > (retained[card.tabId]?.sequence ?? 0)) {
        pending.current.set(card.tabId, {
          previewGeneration: next.previewGeneration,
          tabId: card.tabId,
          sequence: card.frameSequence,
        })
      }
    }
  }, [replaceFrames])

  const pump = useCallback(async () => {
    const lifecycleId = lifecycle.current
    if (lifecycleId === 0 || pulling.current === lifecycleId || !bridge?.pullFrame) return
    const request = pending.current.values().next().value as BrowserPreviewFrameAvailable | undefined
    if (!request) return
    pending.current.delete(request.tabId)
    pulling.current = lifecycleId
    try {
      const payload = await bridge.pullFrame(request)
      if (payload && lifecycle.current === lifecycleId) {
        await decodeAndStore(
          payload,
          snapshotRef,
          framesRef,
          decodingUrls,
          replaceFrames,
          () => lifecycle.current === lifecycleId,
        )
      }
    } catch {
      // A later frame notification retries; the compact preview has no error chrome.
    } finally {
      if (pulling.current === lifecycleId) pulling.current = null
      if (lifecycle.current === lifecycleId && pending.current.size > 0) void pump()
    }
  }, [bridge, replaceFrames])

  useEffect(() => {
    if (!bridge?.getSnapshot || !bridge.onSnapshotChanged || !bridge.onFrameAvailable) return
    const lifecycleId = ++lifecycle.current
    const pendingFrames = pending.current
    const decodingFrameUrls = decodingUrls.current
    let receivedLiveSnapshot = false
    const removeSnapshot = bridge.onSnapshotChanged((next) => {
      receivedLiveSnapshot = true
      applySnapshot(next)
      void pump()
    })
    const removeAvailable = bridge.onFrameAvailable((available) => {
      const current = snapshotRef.current
      const card = current?.cards.find((candidate) => candidate.tabId === available.tabId)
      if (available.previewGeneration !== current?.previewGeneration || current.hiddenContent
        || !card?.hasFrame || card.frameSequence !== available.sequence) return
      pending.current.set(available.tabId, available)
      void pump()
    })
    void bridge.getSnapshot().then((next) => {
      if (lifecycle.current !== lifecycleId || receivedLiveSnapshot) return
      applySnapshot(next)
      void pump()
    }).catch(() => undefined)
    return () => {
      if (lifecycle.current === lifecycleId) lifecycle.current += 1
      if (pulling.current === lifecycleId) pulling.current = null
      snapshotRef.current = null
      removeSnapshot()
      removeAvailable()
      pendingFrames.clear()
      for (const frame of Object.values(framesRef.current)) URL.revokeObjectURL(frame.url)
      for (const url of decodingFrameUrls) URL.revokeObjectURL(url)
      decodingFrameUrls.clear()
      framesRef.current = {}
    }
  }, [applySnapshot, bridge, pump])

  const hasCustomPosition = position !== null
  const cardCount = snapshot?.cards.length ?? 0
  useEffect(() => {
    if (!hasCustomPosition) return
    const constrain = (): void => setPosition((current) => {
      if (!current) return null
      const next = clampPosition(current, surfaceRef.current, overlayRef.current)
      return next.x === current.x && next.y === current.y ? current : next
    })
    constrain()
    window.addEventListener('resize', constrain)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(constrain)
    if (surfaceRef.current) observer?.observe(surfaceRef.current)
    if (overlayRef.current) observer?.observe(overlayRef.current)
    return () => {
      window.removeEventListener('resize', constrain)
      observer?.disconnect()
    }
  }, [cardCount, hasCustomPosition])

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    const start = currentPosition(surfaceRef.current, overlayRef.current)
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      ...start,
    }
    setPosition(start)
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setPosition(clampPosition({
      x: drag.x + event.clientX - drag.clientX,
      y: drag.y + event.clientY - drag.clientY,
    }, surfaceRef.current, overlayRef.current))
  }

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const nudge = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const delta = event.shiftKey ? 40 : 12
    const movement = event.key === 'ArrowLeft' ? { x: -delta, y: 0 }
      : event.key === 'ArrowRight' ? { x: delta, y: 0 }
        : event.key === 'ArrowUp' ? { x: 0, y: -delta }
          : event.key === 'ArrowDown' ? { x: 0, y: delta }
            : null
    if (!movement) return
    event.preventDefault()
    const start = position ?? currentPosition(surfaceRef.current, overlayRef.current)
    setPosition(clampPosition({ x: start.x + movement.x, y: start.y + movement.y }, surfaceRef.current, overlayRef.current))
  }

  if (hidden || !snapshot || snapshot.cards.length === 0) return null

  const stackDepth = Math.min(snapshot.cards.length - 1, 3)
  const stackInset = stackDepth * STACK_STEP_PX

  return (
    <div ref={surfaceRef} className="pointer-events-none absolute inset-0 z-40 overflow-hidden" data-browser-preview-layer>
      <section
        ref={overlayRef}
        aria-label="Browser preview stack"
        className={cn(
          'pointer-events-auto absolute top-3 max-w-[calc(100%-1.5rem)] select-none',
          position ? 'left-0 top-0' : 'right-3',
        )}
        style={{
          width: `calc(23rem + ${stackInset}px)`,
          ...(position ? { left: 0, transform: `translate3d(${position.x}px, ${position.y}px, 0)` } : {}),
        }}
        data-browser-preview-stack
        data-card-count={snapshot.cards.length}
        data-stack-depth={stackDepth}
      >
        <p className="sr-only" aria-live="polite">
          {snapshot.cards.map((card) => `${previewLabel(card)}: ${accessibilityState(card)}`).join('. ')}
        </p>
        <div
          className="relative aspect-video"
          style={{ marginLeft: stackInset, marginBottom: stackInset, width: `calc(100% - ${stackInset}px)` }}
        >
          {snapshot.cards.map((card, index) => {
            const depth = Math.min(index, 3)
            const frame = frames[card.tabId]
            const label = previewLabel(card)
            return (
              <article
                key={card.tabId}
                role="img"
                aria-label={`${label}: ${accessibilityState(card)}`}
                className={cn(
                  'absolute inset-0 overflow-hidden rounded-[10px] border border-white/10 bg-zinc-950 ring-1 ring-black/15',
                  index === 0
                    ? 'shadow-[0_16px_40px_rgba(0,0,0,0.34)]'
                    : 'shadow-[0_10px_26px_rgba(0,0,0,0.28)]',
                )}
                style={{
                  transform: `translate3d(${-depth * STACK_STEP_PX}px, ${depth * STACK_STEP_PX}px, 0)`,
                  zIndex: snapshot.cards.length - index,
                  opacity: Math.max(0.78, 1 - index * 0.06),
                }}
                data-browser-preview-card
                data-browser-preview-front={index === 0 ? 'true' : undefined}
                data-stack-index={index}
              >
                {!snapshot.hiddenContent && frame
                  ? <img src={frame.url} alt="" aria-hidden="true" className="h-full w-full object-contain" draggable={false} />
                  : (
                    <div className="flex h-full w-full items-center justify-center px-5 text-center text-[11px] text-zinc-300">
                      {snapshot.hiddenContent ? 'Preview hidden' : emptyMessage(card)}
                    </div>
                  )}
              </article>
            )
          })}
        </div>
        <button
          type="button"
          aria-label="Drag browser preview stack"
          title="Drag browser preview stack"
          className="absolute inset-0 z-50 touch-none cursor-grab rounded-[10px] bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={nudge}
        />
      </section>
    </div>
  )
}

async function decodeAndStore(
  payload: BrowserPreviewFramePayload,
  snapshotRef: RefObject<BrowserPreviewDeckSnapshot | null>,
  framesRef: RefObject<Record<string, RenderedFrame>>,
  decodingUrls: RefObject<Set<string>>,
  replaceFrames: (frames: Record<string, RenderedFrame>) => void,
  isCurrent: () => boolean,
): Promise<void> {
  const snapshot = snapshotRef.current
  const expectedCard = snapshot?.cards.find((card) => card.tabId === payload.tabId)
  if (payload.previewGeneration !== snapshot?.previewGeneration || snapshot.hiddenContent || !expectedCard?.hasFrame
    || expectedCard.frameSequence !== payload.sequence || payload.data.length === 0
    || payload.data.length > BROWSER_PREVIEW_TOTAL_IMAGE_BYTES
    || !Number.isSafeInteger(payload.width) || !Number.isSafeInteger(payload.height)
    || payload.width < 1 || payload.height < 1
    || payload.width > BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH
    || payload.height > BROWSER_AUTOMATION_MAX_SCREENSHOT_HEIGHT) return
  const binary = atob(payload.data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  if (!isCurrent()) return
  const url = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType }))
  decodingUrls.current.add(url)
  const image = new Image()
  image.src = url
  try {
    await image.decode()
  } catch {
    decodingUrls.current.delete(url)
    URL.revokeObjectURL(url)
    return
  }
  decodingUrls.current.delete(url)
  const currentSnapshot = snapshotRef.current
  const currentCard = currentSnapshot?.cards.find((card) => card.tabId === payload.tabId)
  if (!isCurrent() || payload.previewGeneration !== currentSnapshot?.previewGeneration || currentSnapshot.hiddenContent
    || !currentCard?.hasFrame || currentCard.frameSequence !== payload.sequence
    || image.naturalWidth !== payload.width || image.naturalHeight !== payload.height) {
    URL.revokeObjectURL(url)
    return
  }
  const previous = framesRef.current[payload.tabId]
  if (previous && previous.sequence >= payload.sequence) {
    URL.revokeObjectURL(url)
    return
  }
  if (previous) URL.revokeObjectURL(previous.url)
  replaceFrames({
    ...framesRef.current,
    [payload.tabId]: {
      sequence: payload.sequence,
      url,
    },
  })
}

function previewLabel(card: BrowserPreviewCardSnapshot): string {
  return card.label ?? 'Chrome tab'
}

function emptyMessage(card: BrowserPreviewCardSnapshot): string {
  if (card.targetAffinity === 'external-chrome') return card.state === 'expired'
    ? 'Snapshot expired'
    : 'Waiting for agent snapshot'
  return card.state === 'unavailable' ? 'Preview unavailable' : 'Waiting for preview'
}

function accessibilityState(card: BrowserPreviewCardSnapshot): string {
  if (card.state === 'expired') return 'snapshot expired'
  if (card.state === 'paused') return 'preview hidden'
  if (card.state === 'unavailable') return 'preview unavailable'
  if (card.state === 'waiting') return 'waiting for preview image'
  return 'read-only preview available'
}

function currentPosition(surface: HTMLElement | null, overlay: HTMLElement | null): OverlayPosition {
  if (!surface || !overlay) return { x: 12, y: 12 }
  const surfaceRect = surface.getBoundingClientRect()
  const overlayRect = overlay.getBoundingClientRect()
  return clampPosition({ x: overlayRect.left - surfaceRect.left, y: overlayRect.top - surfaceRect.top }, surface, overlay)
}

function clampPosition(position: OverlayPosition, surface: HTMLElement | null, overlay: HTMLElement | null): OverlayPosition {
  if (!surface || !overlay) return position
  const surfaceRect = surface.getBoundingClientRect()
  const overlayRect = overlay.getBoundingClientRect()
  const inset = 8
  return {
    x: Math.min(Math.max(inset, position.x), Math.max(inset, surfaceRect.width - overlayRect.width - inset)),
    y: Math.min(Math.max(inset, position.y), Math.max(inset, surfaceRect.height - overlayRect.height - inset)),
  }
}
