import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { MousePointer2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  BrowserInputModifiers,
  BrowserPanelAgentCursor,
  BrowserPanelPort,
  BrowserScreencastViewport,
} from './browser-panel-port'

const RESIZE_SETTLE_MS = 120
const MULTI_CLICK_MS = 400
const MULTI_CLICK_SLOP_PX = 4
const AGENT_CURSOR_ACTIVE_MS = 700

interface FrameGeometry {
  /** Page CSS pixels the frame shows. */
  viewport: { width: number; height: number }
}

interface BrowserScreencastProps {
  port: BrowserPanelPort
  tabId: string
  agentCursor: BrowserPanelAgentCursor | null
  onFocusChange?: (focused: boolean) => void
}

/**
 * A remote tab: streamed frames painted on a canvas, letterboxed to fit, with the person's mouse, wheel,
 * keyboard and paste sent back in page coordinates. Keyboard focus lives in a hidden textarea so IME and
 * paste work; Shift+Escape gives focus back to Forge.
 */
export function BrowserScreencast({ port, tabId, agentCursor, onFocusChange }: BrowserScreencastProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const geometryRef = useRef<FrameGeometry | null>(null)
  const viewportRef = useRef<BrowserScreencastViewport | null>(null)
  const lastClickRef = useRef<{ button: string; time: number; x: number; y: number; count: number } | null>(null)
  const moveRef = useRef<{ frame: number; event: { x: number; y: number; modifiers: BrowserInputModifiers; buttons: number } | null }>({ frame: 0, event: null })
  /** The pointer that pressed on the page; only it releases there. */
  const pressedRef = useRef<number | null>(null)
  const [hasFrame, setHasFrame] = useState(false)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const [, setGeometryVersion] = useState(0)

  const measure = (): BrowserScreencastViewport | null => {
    const box = boxRef.current
    if (!box) return null
    const rect = box.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    return { width: Math.round(rect.width), height: Math.round(rect.height), deviceScaleFactor: window.devicePixelRatio || 1 }
  }

  // Subscribe at the panel's size, then follow resizes once they settle.
  useLayoutEffect(() => {
    const box = boxRef.current
    const canvas = canvasRef.current
    if (!box || !canvas || !port.subscribeFrames) return
    setHasFrame(false)
    setStreamError(null)
    geometryRef.current = null
    const initial = measure() ?? { width: 800, height: 600, deviceScaleFactor: window.devicePixelRatio || 1 }
    viewportRef.current = initial
    const context = canvas.getContext('2d')
    const unsubscribe = port.subscribeFrames(tabId, initial, (frame) => {
      if (!context) { frame.close?.(); return }
      if (canvas.width !== frame.image.width || canvas.height !== frame.image.height) {
        canvas.width = frame.image.width
        canvas.height = frame.image.height
      }
      context.drawImage(frame.image, 0, 0)
      frame.close?.()
      const previous = geometryRef.current
      geometryRef.current = { viewport: frame.viewport }
      if (!previous || previous.viewport.width !== frame.viewport.width || previous.viewport.height !== frame.viewport.height) {
        setGeometryVersion((version) => version + 1)
      }
      setHasFrame(true)
      setStreamError(null)
    }, setStreamError)
    let timer: ReturnType<typeof setTimeout> | null = null
    const onResize = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        const next = measure()
        const previous = viewportRef.current
        if (!next || (previous && previous.width === next.width && previous.height === next.height && previous.deviceScaleFactor === next.deviceScaleFactor)) return
        viewportRef.current = next
        port.resizeScreencast?.(tabId, next)
      }, RESIZE_SETTLE_MS)
    }
    const observer = new ResizeObserver(onResize)
    observer.observe(box)
    window.addEventListener('resize', onResize)
    return () => {
      if (timer) clearTimeout(timer)
      observer.disconnect()
      window.removeEventListener('resize', onResize)
      unsubscribe()
    }
  }, [port, tabId])

  /** Where the frame is drawn inside the canvas box (object-contain letterboxing). */
  const drawnRect = () => {
    const canvas = canvasRef.current
    if (!canvas || canvas.width < 1 || canvas.height < 1) return null
    const rect = canvas.getBoundingClientRect()
    const fit = Math.min(rect.width / canvas.width, rect.height / canvas.height)
    const width = canvas.width * fit
    const height = canvas.height * fit
    return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height, box: rect }
  }

  const pagePoint = (clientX: number, clientY: number, clamp: boolean) => {
    const geometry = geometryRef.current
    const drawn = drawnRect()
    if (!geometry || !drawn || drawn.width <= 0 || drawn.height <= 0) return null
    const x = ((clientX - drawn.left) / drawn.width) * geometry.viewport.width
    const y = ((clientY - drawn.top) / drawn.height) * geometry.viewport.height
    const inside = x >= 0 && y >= 0 && x <= geometry.viewport.width && y <= geometry.viewport.height
    if (!inside && !clamp) return null
    return {
      x: Math.min(Math.max(x, 0), geometry.viewport.width),
      y: Math.min(Math.max(y, 0), geometry.viewport.height),
    }
  }

  const send = port.sendInput ? (input: Parameters<NonNullable<BrowserPanelPort['sendInput']>>[1]) => port.sendInput!(tabId, input) : null

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!send) return
    const point = pagePoint(event.clientX, event.clientY, false)
    if (!point) return
    event.preventDefault()
    inputRef.current?.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    pressedRef.current = event.pointerId
    const button = mouseButton(event.button)
    const now = performance.now()
    const last = lastClickRef.current
    const clickCount = last && last.button === button && now - last.time < MULTI_CLICK_MS && Math.hypot(point.x - last.x, point.y - last.y) < MULTI_CLICK_SLOP_PX
      ? Math.min(3, last.count + 1)
      : 1
    lastClickRef.current = { button, time: now, x: point.x, y: point.y, count: clickCount }
    send({ type: 'mouse', action: 'down', ...point, button, clickCount, modifiers: modifiersOf(event) })
  }

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!send || pressedRef.current !== event.pointerId) return
    pressedRef.current = null
    const point = pagePoint(event.clientX, event.clientY, true)
    if (!point) return
    flushMove()
    send({ type: 'mouse', action: 'up', ...point, button: mouseButton(event.button), clickCount: lastClickRef.current?.count ?? 1, modifiers: modifiersOf(event) })
  }

  const flushMove = () => {
    const pending = moveRef.current
    if (pending.frame) cancelAnimationFrame(pending.frame)
    pending.frame = 0
    const move = pending.event
    pending.event = null
    if (!move || !send) return
    send({ type: 'mouse', action: 'move', x: move.x, y: move.y, button: move.buttons & 1 ? 'left' : 'none', clickCount: 0, modifiers: move.modifiers })
  }

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!send) return
    const point = pagePoint(event.clientX, event.clientY, event.buttons !== 0)
    if (!point) return
    moveRef.current.event = { ...point, modifiers: modifiersOf(event), buttons: event.buttons }
    if (!moveRef.current.frame) moveRef.current.frame = requestAnimationFrame(flushMove)
  }

  // Wheel needs a non-passive listener to keep the chat from scrolling; deltas are batched per frame.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !port.sendInput) return
    let pending: { x: number; y: number; deltaX: number; deltaY: number; modifiers: BrowserInputModifiers } | null = null
    let frame = 0
    const flush = () => {
      frame = 0
      if (pending) port.sendInput!(tabId, { type: 'wheel', ...pending })
      pending = null
    }
    const onWheel = (event: WheelEvent) => {
      const geometry = geometryRef.current
      const drawn = drawnRect()
      if (!geometry || !drawn) return
      const x = ((event.clientX - drawn.left) / drawn.width) * geometry.viewport.width
      const y = ((event.clientY - drawn.top) / drawn.height) * geometry.viewport.height
      if (x < 0 || y < 0 || x > geometry.viewport.width || y > geometry.viewport.height) return
      event.preventDefault()
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? drawn.height : 1
      pending = {
        x, y,
        deltaX: (pending?.deltaX ?? 0) + event.deltaX * scale,
        deltaY: (pending?.deltaY ?? 0) + event.deltaY * scale,
        modifiers: modifiersOf(event),
      }
      if (!frame) frame = requestAnimationFrame(flush)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [port, tabId])

  const onKey = (action: 'down' | 'up', event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!send || event.nativeEvent.isComposing) return
    if (action === 'down' && event.key === 'Escape' && event.shiftKey) {
      event.preventDefault()
      inputRef.current?.blur()
      return
    }
    const modifiers = modifiersOf(event)
    // Let the browser raise a paste event; the clipboard text is sent from there.
    if ((modifiers.meta || modifiers.ctrl) && event.key.toLowerCase() === 'v') return
    event.preventDefault()
    const printable = event.key.length === 1 && !modifiers.ctrl && !modifiers.meta
    send({ type: 'key', action, key: event.key, code: event.code, modifiers, ...(action === 'down' && printable ? { text: event.key } : {}) })
  }

  const setFocus = (next: boolean) => {
    setFocused(next)
    onFocusChange?.(next)
  }

  return (
    <div
      ref={boxRef}
      data-browser-panel-content="screencast"
      data-focused={focused ? 'true' : undefined}
      className={cn(
        'relative min-h-0 flex-1 overflow-hidden bg-[#0d0d12]/[0.03]',
        focused && 'shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--ring)_45%,transparent)]',
      )}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className={cn('block size-full touch-none object-contain transition-opacity duration-150', hasFrame ? 'opacity-100' : 'opacity-0')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onMouseDown={(event) => event.preventDefault()}
        onContextMenu={(event) => event.preventDefault()}
      />
      {!hasFrame && !streamError ? <ScreencastSkeleton /> : null}
      {streamError ? (
        <div role="alert" data-browser-stream-error className="absolute inset-x-3 bottom-3 rounded-lg border border-hairline bg-card/95 px-3 py-2 text-[12px] text-muted-foreground shadow-sm">
          Live view unavailable: {streamError}
        </div>
      ) : null}
      {hasFrame && agentCursor ? <AgentCursor cursor={agentCursor} toClient={(x, y) => {
        const geometry = geometryRef.current
        const drawn = drawnRect()
        if (!geometry || !drawn) return null
        return {
          left: drawn.left - drawn.box.left + (x / geometry.viewport.width) * drawn.width,
          top: drawn.top - drawn.box.top + (y / geometry.viewport.height) * drawn.height,
        }
      }} /> : null}
      <textarea
        ref={inputRef}
        aria-label="Browser page"
        aria-description="Typing goes to the page. Press Shift+Escape to leave it."
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={!send}
        className="sr-only left-0 top-0 text-base"
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onKeyDown={(event) => onKey('down', event)}
        onKeyUp={(event) => onKey('up', event)}
        onCompositionEnd={(event) => {
          if (event.data) send?.({ type: 'text', text: event.data })
          event.currentTarget.value = ''
        }}
        onInput={(event) => { if (!(event.nativeEvent as InputEvent).isComposing) event.currentTarget.value = '' }}
        onPaste={(event) => {
          event.preventDefault()
          const text = event.clipboardData.getData('text/plain')
          if (text) send?.({ type: 'text', text })
        }}
        onCopy={(event) => event.preventDefault()}
        onCut={(event) => event.preventDefault()}
      />
    </div>
  )
}

/** The agent's pointer on the page; it fades once the agent stops acting. */
function AgentCursor({ cursor, toClient }: {
  cursor: BrowserPanelAgentCursor
  toClient: (x: number, y: number) => { left: number; top: number } | null
}) {
  const [inactiveSequence, setInactiveSequence] = useState<number | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setInactiveSequence(cursor.sequence), AGENT_CURSOR_ACTIVE_MS)
    return () => clearTimeout(timer)
  }, [cursor.sequence])
  const position = toClient(cursor.x, cursor.y)
  if (!position) return null
  return (
    <div
      aria-hidden="true"
      data-agent-browser-cursor
      className="pointer-events-none absolute left-0 top-0 z-10 transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none"
      style={{ transform: `translate3d(${position.left}px, ${position.top}px, 0)`, opacity: inactiveSequence === cursor.sequence ? 0.35 : 1 }}
    >
      {cursor.phase === 'click' ? <span key={cursor.sequence} className="browser-agent-ping absolute -left-1.5 -top-1.5 size-5 rounded-full bg-primary/30" /> : null}
      <MousePointer2 className="relative size-5 -translate-x-0.5 -translate-y-0.5 fill-background text-primary drop-shadow-sm" strokeWidth={2} />
    </div>
  )
}

/** A page-shaped placeholder while the first frame is on its way. */
export function ScreencastSkeleton() {
  return (
    <div className="absolute inset-0 flex flex-col gap-4 p-6" aria-label="Loading page" role="status">
      <div className="h-6 w-1/3 animate-pulse rounded-md bg-foreground/[0.06]" />
      <div className="h-4 w-2/3 animate-pulse rounded-md bg-foreground/[0.05]" />
      <div className="h-4 w-1/2 animate-pulse rounded-md bg-foreground/[0.05]" />
      <div className="mt-2 grid flex-1 grid-cols-2 gap-4">
        <div className="animate-pulse rounded-xl bg-foreground/[0.045]" />
        <div className="animate-pulse rounded-xl bg-foreground/[0.045]" />
      </div>
    </div>
  )
}

function mouseButton(button: number): 'left' | 'middle' | 'right' {
  return button === 1 ? 'middle' : button === 2 ? 'right' : 'left'
}

function modifiersOf(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): BrowserInputModifiers {
  return { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey }
}
