import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Eye, EyeOff, Pin, PinOff, Play, Pause, SquareArrowOutUpRight, X } from 'lucide-react'
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

export function BrowserPreviewSurface() {
  const bridge = window.electronBridge?.browserPreview
  const [snapshot, setSnapshot] = useState<BrowserPreviewDeckSnapshot | null>(null)
  const snapshotRef = useRef<BrowserPreviewDeckSnapshot | null>(null)
  const [frames, setFrames] = useState<Record<string, RenderedFrame>>({})
  const framesRef = useRef<Record<string, RenderedFrame>>({})
  const pending = useRef(new Map<string, BrowserPreviewFrameAvailable>())
  const pulling = useRef(false)
  const disposed = useRef(false)
  const [now, setNow] = useState(() => performance.now())
  const [error, setError] = useState<string | null>(null)

  const replaceFrames = useCallback((next: Record<string, RenderedFrame>) => {
    framesRef.current = next
    setFrames(next)
  }, [])

  const applySnapshot = useCallback((next: BrowserPreviewDeckSnapshot) => {
    const generationChanged = snapshotRef.current?.previewGeneration !== next.previewGeneration
    const cardsById = new Map(next.cards.map((card) => [card.tabId, card]))
    if (generationChanged || next.hiddenContent) pending.current.clear()
    else {
      for (const [tabId, request] of pending.current) {
        if (request.previewGeneration !== next.previewGeneration || !cardsById.get(tabId)?.hasFrame) pending.current.delete(tabId)
      }
    }
    snapshotRef.current = next
    setSnapshot(next)
    const retained: Record<string, RenderedFrame> = {}
    for (const [tabId, frame] of Object.entries(framesRef.current)) {
      const card = cardsById.get(tabId)
      if (!generationChanged && !next.hiddenContent && card?.hasFrame && frame.sequence <= card.frameSequence) retained[tabId] = frame
      else URL.revokeObjectURL(frame.url)
    }
    replaceFrames(retained)
    if (next.hiddenContent) return
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
    if (pulling.current || disposed.current || !bridge?.pullFrame) return
    const request = pending.current.values().next().value as BrowserPreviewFrameAvailable | undefined
    if (!request) return
    pending.current.delete(request.tabId)
    pulling.current = true
    try {
      const payload = await bridge.pullFrame(request)
      if (payload) await decodeAndStore(payload, snapshotRef, framesRef, replaceFrames)
    } catch (caught) {
      if (!disposed.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      pulling.current = false
      if (!disposed.current && pending.current.size > 0) void pump()
    }
  }, [bridge, replaceFrames])

  useEffect(() => {
    if (!bridge?.getSnapshot || !bridge.onSnapshotChanged || !bridge.onFrameAvailable) {
      setError('Browser Preview bridge is unavailable')
      return
    }
    disposed.current = false
    const pendingFrames = pending.current
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
      if (!next || disposed.current) return
      applySnapshot(next)
      void pump()
    }).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
    return () => {
      disposed.current = true
      removeSnapshot()
      removeAvailable()
      pendingFrames.clear()
      for (const frame of Object.values(framesRef.current)) URL.revokeObjectURL(frame.url)
      framesRef.current = {}
    }
  }, [applySnapshot, bridge, pump])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const command = async (value: BrowserPreviewShellCommandInput): Promise<void> => {
    if (!snapshot || !bridge?.sendCommand) return
    setError(null)
    try {
      await bridge.sendCommand({ ...value, previewGeneration: snapshot.previewGeneration } as BrowserPreviewShellCommand)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  if (!snapshot) {
    return <main className="flex min-h-screen items-center justify-center bg-background p-6 text-sm text-muted-foreground">{error ?? 'Opening Browser Preview…'}</main>
  }

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground" aria-label="Forge Browser Previews">
      <header className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">Forge Browser Previews</h1>
          <p className="text-xs text-muted-foreground">Read-only · Session {shortId(snapshot.sessionAgentId)} · {snapshot.cards.length} of 4 cards</p>
        </div>
        <ShellButton label={snapshot.paused ? 'Resume previews' : 'Pause previews'} onClick={() => void command({ type: 'set-paused', paused: !snapshot.paused })}>
          {snapshot.paused ? <Play /> : <Pause />}
        </ShellButton>
        <ShellButton label={snapshot.hiddenContent ? 'Show preview content' : 'Hide preview content'} onClick={() => void command({ type: 'set-hidden-content', hidden: !snapshot.hiddenContent })}>
          {snapshot.hiddenContent ? <Eye /> : <EyeOff />}
        </ShellButton>
        <ShellButton label={snapshot.pinned ? 'Unpin preview window' : 'Pin preview window on top'} onClick={() => void command({ type: 'set-pinned', pinned: !snapshot.pinned })}>
          {snapshot.pinned ? <PinOff /> : <Pin />}
        </ShellButton>
      </header>
      {error ? <div role="alert" className="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div> : null}
      <p className="sr-only" aria-live="polite">{snapshot.cards.map((card) => `${card.label ?? 'Chrome tab'}: ${accessibilityState(card)}`).join('. ')}</p>
      <section className={cn('grid min-h-0 flex-1 gap-3 overflow-auto p-3', snapshot.cards.length > 1 && 'sm:grid-cols-2')}>
        {snapshot.cards.map((card) => (
          <PreviewCard
            key={card.tabId}
            card={card}
            frame={frames[card.tabId]}
            now={now}
            hidden={snapshot.hiddenContent}
            onCommand={(value) => void command(value)}
          />
        ))}
      </section>
    </main>
  )
}

function PreviewCard({
  card,
  frame,
  now,
  hidden,
  onCommand,
}: {
  card: BrowserPreviewCardSnapshot
  frame?: RenderedFrame
  now: number
  hidden: boolean
  onCommand(command: BrowserPreviewShellCommandInput): void
}) {
  const age = frame ? frame.ageMsAtDelivery + Math.max(0, now - frame.deliveredAt) : card.ageMsAtDelivery
  const source = card.targetAffinity === 'managed-electron' ? 'Managed · Native viewport' : 'Chrome · Agent snapshots'
  return (
    <article className="flex min-h-56 min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{card.label ?? `Chrome tab · ${shortId(card.tabId)}`}</h2>
          <p className="text-xs text-muted-foreground">{source}</p>
        </div>
        <button type="button" className="rounded p-1.5 hover:bg-muted focus-visible:ring-2" aria-label={`Remove ${card.label ?? 'Chrome tab'} preview`} onClick={() => onCommand({ type: 'remove', tabId: card.tabId })}><X className="size-4" /></button>
      </header>
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-zinc-950">
        {!hidden && frame ? <img src={frame.url} alt={card.targetAffinity === 'managed-electron' ? 'Read-only managed browser native viewport' : 'Read-only last agent snapshot from Chrome'} className="h-full w-full object-contain" /> : null}
        {hidden || !frame ? <div className="px-5 text-center text-sm text-zinc-300">{hidden ? 'Preview content hidden' : emptyMessage(card)}</div> : null}
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 text-muted-foreground">{statusText(card, age)}</span>
        {card.targetAffinity === 'managed-electron'
          ? <button type="button" className="inline-flex items-center gap-1 rounded border px-2 py-1 hover:bg-muted focus-visible:ring-2" onClick={() => onCommand({ type: 'promote', tabId: card.tabId })}><SquareArrowOutUpRight className="size-3" />Open browser</button>
          : <button type="button" className="inline-flex items-center gap-1 rounded border px-2 py-1 hover:bg-muted focus-visible:ring-2" onClick={() => onCommand({ type: 'reveal', tabId: card.tabId })}><SquareArrowOutUpRight className="size-3" />Show in Chrome</button>}
      </footer>
    </article>
  )
}

function ShellButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return <button type="button" title={label} aria-label={label} onClick={onClick} className="inline-flex size-8 items-center justify-center rounded hover:bg-muted focus-visible:ring-2 [&_svg]:size-4">{children}</button>
}

async function decodeAndStore(
  payload: BrowserPreviewFramePayload,
  snapshotRef: RefObject<BrowserPreviewDeckSnapshot | null>,
  framesRef: RefObject<Record<string, RenderedFrame>>,
  replaceFrames: (frames: Record<string, RenderedFrame>) => void,
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
  const url = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType }))
  const image = new Image()
  image.src = url
  try {
    await image.decode()
  } catch {
    URL.revokeObjectURL(url)
    return
  }
  const currentSnapshot = snapshotRef.current
  const currentCard = currentSnapshot?.cards.find((card) => card.tabId === payload.tabId)
  if (payload.previewGeneration !== currentSnapshot?.previewGeneration || currentSnapshot.hiddenContent
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
  if (!card.presented) return 'Source paused · open this tab in Forge to update its preview'
  return card.state === 'unavailable' ? 'Preview unavailable' : 'Waiting for native viewport capture'
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
  if (!card.presented) return `Source paused · captured ${age} ago · Read-only`
  if (card.state === 'unavailable') return `Preview unavailable · last capture ${age} ago · Read-only`
  return `${card.state === 'delayed' || ageMs >= BROWSER_PREVIEW_DELAYED_AFTER_MS ? 'Delayed' : 'Updating'} · captured ${age} ago · Read-only`
}

function accessibilityState(card: BrowserPreviewCardSnapshot): string {
  if (card.state === 'expired') return 'snapshot expired'
  if (card.state === 'paused') return 'preview paused'
  if (card.state === 'unavailable') return 'preview unavailable'
  if (card.state === 'waiting') return 'waiting for preview image'
  if (!card.presented && card.targetAffinity === 'managed-electron') return 'source paused'
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
