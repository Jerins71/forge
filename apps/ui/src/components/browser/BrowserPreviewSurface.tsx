import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { Eye, EyeOff, GripHorizontal, Play, Pause, SquareArrowOutUpRight, X } from 'lucide-react'
import {
  BROWSER_AUTOMATION_MAX_SCREENSHOT_HEIGHT,
  BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH,
  BROWSER_PREVIEW_DELAYED_AFTER_MS,
  BROWSER_PREVIEW_TOTAL_IMAGE_BYTES,
  type BrowserPreviewCardSnapshot,
  type BrowserPreviewDeckSnapshot,
  type BrowserPreviewFrameAvailable,
  type BrowserPreviewFramePayload,
  type BrowserPreviewShellCommand,
} from '@forge/protocol'
import { cn } from '@/lib/utils'

type BrowserPreviewShellCommandInput = BrowserPreviewShellCommand extends infer Command
  ? Command extends BrowserPreviewShellCommand ? Omit<Command, 'previewGeneration'> : never
  : never

interface RenderedFrame {
  sequence: number
  url: string
  ageMsAtDelivery: number
  deliveredAt: number
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

export function BrowserPreviewSurface({ onOpenManagedBrowser }: { onOpenManagedBrowser?(): void }) {
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
  const [now, setNow] = useState(() => performance.now())
  const [error, setError] = useState<string | null>(null)

  const replaceFrames = useCallback((next: Record<string, RenderedFrame>) => {
    framesRef.current = next
    setFrames(next)
  }, [])

  const applySnapshot = useCallback((next: BrowserPreviewDeckSnapshot | null) => {
    const previous = snapshotRef.current
    const generationChanged = previous?.previewGeneration !== next?.previewGeneration
    const cardsById = new Map(next?.cards.map((card) => [card.tabId, card]) ?? [])
    if (!next || generationChanged || next.hiddenContent) pending.current.clear()
    else {
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
    } catch (caught) {
      if (lifecycle.current === lifecycleId) setError(caught instanceof Error ? caught.message : String(caught))
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
    const removeSnapshot = bridge.onSnapshotChanged((next) => {
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
      if (lifecycle.current !== lifecycleId) return
      applySnapshot(next)
      void pump()
    }).catch((caught) => {
      if (lifecycle.current === lifecycleId) setError(caught instanceof Error ? caught.message : String(caught))
    })
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

  const deckOpen = snapshot !== null
  useEffect(() => {
    if (!deckOpen) return
    const timer = window.setInterval(() => setNow(performance.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [deckOpen])

  useEffect(() => {
    if (!position) return
    const constrain = (): void => setPosition((current) => current ? clampPosition(current, surfaceRef.current, overlayRef.current) : null)
    window.addEventListener('resize', constrain)
    return () => window.removeEventListener('resize', constrain)
  }, [position])

  const command = async (value: BrowserPreviewShellCommandInput): Promise<boolean> => {
    const current = snapshotRef.current
    if (!current || !bridge?.sendCommand) return false
    setError(null)
    try {
      await bridge.sendCommand({ ...value, previewGeneration: current.previewGeneration } as BrowserPreviewShellCommand)
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      return false
    }
  }

  const dismiss = async (): Promise<void> => {
    const current = snapshotRef.current
    if (!current || !bridge?.sendCommand) return
    setError(null)
    try {
      for (const card of current.cards) {
        await bridge.sendCommand({ type: 'remove', previewGeneration: current.previewGeneration, tabId: card.tabId })
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

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

  if (!snapshot) return null

  return (
    <div ref={surfaceRef} className="pointer-events-none absolute inset-0 z-40 overflow-hidden" data-browser-preview-layer>
      <section
        ref={overlayRef}
        aria-label="Browser preview overlay"
        className={cn(
          'pointer-events-auto absolute top-4 flex max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] flex-col overflow-hidden rounded-2xl border border-border/80 bg-background/95 text-foreground shadow-2xl ring-1 ring-black/5 backdrop-blur-xl',
          snapshot.cards.length > 1 ? 'max-w-3xl' : 'max-w-lg',
          position ? 'left-0 top-0' : 'right-4 top-4',
        )}
        style={position ? { left: 0, transform: `translate3d(${position.x}px, ${position.y}px, 0)` } : undefined}
      >
        <header className="flex min-h-11 items-center gap-1.5 border-b bg-muted/35 px-2">
          <button
            type="button"
            aria-label="Drag browser preview"
            title="Drag browser preview"
            className="inline-flex size-8 shrink-0 touch-none cursor-grab items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
            onPointerDown={beginDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={nudge}
          >
            <GripHorizontal />
          </button>
          <div className="min-w-0 flex-1 px-1">
            <h2 className="truncate text-sm font-semibold">Browser previews</h2>
            <p className="truncate text-[11px] text-muted-foreground">Read-only · {snapshot.cards.length} of 4</p>
          </div>
          <ShellButton label={snapshot.paused ? 'Resume previews' : 'Pause previews'} onClick={() => void command({ type: 'set-paused', paused: !snapshot.paused })}>
            {snapshot.paused ? <Play /> : <Pause />}
          </ShellButton>
          <ShellButton label={snapshot.hiddenContent ? 'Show preview content' : 'Hide preview content'} onClick={() => void command({ type: 'set-hidden-content', hidden: !snapshot.hiddenContent })}>
            {snapshot.hiddenContent ? <Eye /> : <EyeOff />}
          </ShellButton>
          <ShellButton label="Close browser previews" onClick={() => void dismiss()}><X /></ShellButton>
        </header>
        {error ? <div role="alert" className="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div> : null}
        <p className="sr-only" aria-live="polite">{snapshot.cards.map((card) => `${card.label ?? 'Chrome tab'}: ${accessibilityState(card)}`).join('. ')}</p>
        <div className={cn('grid min-h-0 gap-2 overflow-auto p-2', snapshot.cards.length > 1 && 'sm:grid-cols-2')}>
          {snapshot.cards.map((card) => (
            <PreviewCard
              key={card.tabId}
              card={card}
              frame={frames[card.tabId]}
              now={now}
              hidden={snapshot.hiddenContent}
              onCommand={(value) => void command(value)}
              onOpenManaged={async () => {
                if (await command({ type: 'promote', tabId: card.tabId })) onOpenManagedBrowser?.()
              }}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function PreviewCard({
  card,
  frame,
  now,
  hidden,
  onCommand,
  onOpenManaged,
}: {
  card: BrowserPreviewCardSnapshot
  frame?: RenderedFrame
  now: number
  hidden: boolean
  onCommand(command: BrowserPreviewShellCommandInput): void
  onOpenManaged(): void
}) {
  const age = frame ? frame.ageMsAtDelivery + Math.max(0, now - frame.deliveredAt) : card.ageMsAtDelivery
  const source = card.targetAffinity === 'managed-electron' ? 'Managed · Native preview' : 'Chrome · Agent snapshots'
  const label = card.label ?? `Chrome tab · ${shortId(card.tabId)}`
  return (
    <article className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="flex items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{label}</h3>
          <p className="text-[11px] text-muted-foreground">{source}</p>
        </div>
        <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Remove ${label} preview`} onClick={() => onCommand({ type: 'remove', tabId: card.tabId })}><X className="size-3.5" /></button>
      </header>
      <div className="relative flex aspect-video min-h-36 items-center justify-center overflow-hidden bg-zinc-950">
        {!hidden && frame ? <img src={frame.url} alt={card.targetAffinity === 'managed-electron' ? 'Read-only managed browser native viewport' : 'Read-only last agent snapshot from Chrome'} className="h-full w-full object-contain" draggable={false} /> : null}
        {hidden || !frame ? <div className="px-5 text-center text-xs text-zinc-300">{hidden ? 'Preview content hidden' : emptyMessage(card)}</div> : null}
      </div>
      <footer className="flex min-h-10 items-center gap-2 border-t px-3 py-2 text-[11px]">
        <span className="min-w-0 flex-1 text-muted-foreground">{statusText(card, age)}</span>
        {card.targetAffinity === 'managed-electron'
          ? <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onOpenManaged}><SquareArrowOutUpRight className="size-3" />Open browser</button>
          : <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onCommand({ type: 'reveal', tabId: card.tabId })}><SquareArrowOutUpRight className="size-3" />Show in Chrome</button>}
      </footer>
    </article>
  )
}

function ShellButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return <button type="button" title={label} aria-label={label} onClick={onClick} className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4">{children}</button>
}

function currentPosition(surface: HTMLElement | null, overlay: HTMLElement | null): OverlayPosition {
  if (!surface || !overlay) return { x: 16, y: 16 }
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
      ageMsAtDelivery: payload.ageMsAtDelivery,
      deliveredAt: performance.now(),
    },
  })
}

function emptyMessage(card: BrowserPreviewCardSnapshot): string {
  if (card.targetAffinity === 'external-chrome') return card.state === 'expired'
    ? 'Snapshot expired; waiting for agent snapshot'
    : 'Waiting for the next agent snapshot'
  return card.state === 'unavailable' ? 'Preview unavailable' : 'Waiting for native preview capture'
}

function statusText(card: BrowserPreviewCardSnapshot, ageMs: number | null): string {
  if (card.state === 'expired') return 'Snapshot expired · waiting for agent snapshot · Read-only'
  if (card.state === 'paused') return ageMs === null ? 'Paused · Read-only' : `Paused · last ${card.targetAffinity === 'external-chrome' ? 'snapshot received' : 'capture'} ${formatAge(ageMs)} ago · Read-only`
  if (ageMs === null) {
    if (card.state === 'unavailable') return 'Preview unavailable · Read-only'
    return card.targetAffinity === 'external-chrome' ? 'Waiting for agent snapshot · Read-only' : 'Waiting for capture · Read-only'
  }
  const age = formatAge(ageMs)
  if (card.targetAffinity === 'external-chrome') return `${ageMs >= 30_000 ? 'Older agent snapshot' : 'Last agent snapshot'} · received ${age} ago · Read-only`
  if (card.state === 'unavailable') return `Preview unavailable · last capture ${age} ago · Read-only`
  return `${card.state === 'delayed' || ageMs >= BROWSER_PREVIEW_DELAYED_AFTER_MS ? 'Delayed' : card.presented ? 'Updating' : 'Updating in background'} · captured ${age} ago · Read-only`
}

function accessibilityState(card: BrowserPreviewCardSnapshot): string {
  if (card.state === 'expired') return 'snapshot expired'
  if (card.state === 'paused') return 'preview paused'
  if (card.state === 'unavailable') return 'preview unavailable'
  if (card.state === 'waiting') return 'waiting for preview image'
  return 'read-only preview available'
}

function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1_000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function shortId(tabId: string): string {
  const suffix = tabId.split('.').at(-1) ?? tabId
  return suffix.slice(-8)
}
