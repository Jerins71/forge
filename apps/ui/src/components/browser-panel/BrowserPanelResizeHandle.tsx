import { useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import {
  BROWSER_PANEL_CHAT_MIN_WIDTH,
  BROWSER_PANEL_DEFAULT_WIDTH,
  BROWSER_PANEL_MIN_WIDTH,
  readBrowserPanelWidth,
  storeBrowserPanelWidth,
} from './browser-panel-layout'

/** The CSS variable the panel's width reads; unset means the default width. */
export const BROWSER_PANEL_WIDTH_VAR = '--browser-panel-width'
const KEY_STEP_PX = 16

/** The panel the handle sits on. */
function panel(handle: HTMLElement): HTMLElement {
  return handle.parentElement!
}

/** The widest the panel may be: its row minus the chat column's minimum. */
function maxWidth(handle: HTMLElement): number {
  const element = panel(handle)
  const row = element.parentElement
  const rowWidth = row ? row.getBoundingClientRect().width : window.innerWidth
  const siblings = row ? [...row.children].filter((child) => child !== element) : []
  // Fixed-width siblings (sidebars) are not the chat; only the flexible chat column may shrink.
  const fixed = siblings
    .filter((child) => child instanceof HTMLElement && getComputedStyle(child).flexGrow === '0')
    .reduce((sum, child) => sum + child.getBoundingClientRect().width, 0)
  return Math.max(BROWSER_PANEL_MIN_WIDTH, Math.floor(rowWidth - fixed - BROWSER_PANEL_CHAT_MIN_WIDTH))
}

function clampWidth(handle: HTMLElement, px: number): number {
  return Math.round(Math.min(maxWidth(handle), Math.max(BROWSER_PANEL_MIN_WIDTH, px)))
}

function apply(handle: HTMLElement, px: number | null): void {
  if (px === null) panel(handle).style.removeProperty(BROWSER_PANEL_WIDTH_VAR)
  else panel(handle).style.setProperty(BROWSER_PANEL_WIDTH_VAR, `${px}px`)
  handle.setAttribute('aria-valuenow', String(Math.round(panel(handle).getBoundingClientRect().width)))
  handle.setAttribute('aria-valuemax', String(maxWidth(handle)))
}

/**
 * The drag handle on the docked browser panel's left edge. Dragging writes the panel's CSS variable once
 * per animation frame, so neither the chat nor the page re-renders while resizing; the width persists
 * for this window.
 */
export function BrowserPanelResizeHandle() {
  const handleRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startX: number; startWidth: number; width: number; frame: number } | null>(null)

  // Restore the stored width before the first paint, so the panel never flashes at the default.
  useLayoutEffect(() => {
    apply(handleRef.current!, readBrowserPanelWidth())
  }, [])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startWidth = panel(handle).getBoundingClientRect().width
    drag.current = { startX: event.clientX, startWidth, width: startWidth, frame: 0 }
    document.body.classList.add('browser-panel-resizing')
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state) return
    const handle = event.currentTarget
    // The handle is on the left edge: dragging left widens the panel.
    state.width = clampWidth(handle, state.startWidth - (event.clientX - state.startX))
    if (state.frame) return
    state.frame = requestAnimationFrame(() => {
      state.frame = 0
      apply(handle, state.width)
    })
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state) return
    drag.current = null
    cancelAnimationFrame(state.frame)
    document.body.classList.remove('browser-panel-resizing')
    apply(event.currentTarget, state.width)
    if (state.width !== Math.round(state.startWidth)) storeBrowserPanelWidth(state.width)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const handle = event.currentTarget
    const current = panel(handle).getBoundingClientRect().width
    const step = event.shiftKey ? KEY_STEP_PX * 4 : KEY_STEP_PX
    const next = {
      ArrowLeft: current + step,
      ArrowRight: current - step,
      Home: maxWidth(handle),
      End: BROWSER_PANEL_MIN_WIDTH,
    }[event.key]
    if (next === undefined) return
    event.preventDefault()
    const width = clampWidth(handle, next)
    apply(handle, width)
    storeBrowserPanelWidth(width)
  }

  const reset = (handle: HTMLElement) => {
    apply(handle, null)
    storeBrowserPanelWidth(null)
  }

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize browser panel"
      aria-valuemin={BROWSER_PANEL_MIN_WIDTH}
      tabIndex={0}
      data-testid="browser-panel-resize-handle"
      title={`Drag to resize · double-click to reset (${BROWSER_PANEL_DEFAULT_WIDTH}px)`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={(event) => reset(event.currentTarget)}
      onKeyDown={onKeyDown}
      className="browser-panel-resize-handle"
    />
  )
}
