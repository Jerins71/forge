import { useLayoutEffect, useRef } from 'react'
import type { BrowserPanelPort } from './browser-panel-port'

/** An open modal or menu: the native view draws above the page's DOM, so it steps aside for these. */
const OVERLAY_SELECTOR = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]'

/**
 * Where the desktop app places the real tab. The slot reports its window bounds whenever it moves or
 * resizes, and hides the view while it is hidden, collapsed, or covered by a dialog or menu.
 */
export function BrowserNativeSlot({ port, tabId }: { port: BrowserPanelPort; tabId: string }) {
  const slotRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const slot = slotRef.current
    if (!slot || !port.setNativeBounds) return
    let frame = 0
    let last = ''
    const report = () => {
      frame = 0
      const rect = slot.getBoundingClientRect()
      const covered = document.querySelector(OVERLAY_SELECTOR) !== null
      const visible = !covered && rect.width >= 1 && rect.height >= 1 && slot.checkVisibility?.() !== false
      const bounds = visible
        ? { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
        : null
      const key = JSON.stringify(bounds)
      if (key === last) return
      last = key
      port.setNativeBounds!(tabId, bounds)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(report) }
    report()
    const resize = new ResizeObserver(schedule)
    resize.observe(slot)
    // The slot also moves without resizing when the sidebar or panel beside it changes width.
    if (slot.parentElement) resize.observe(slot.parentElement)
    // Dialogs and menus portal into <body>, so watching its children is enough (and cheap).
    const overlays = new MutationObserver(schedule)
    overlays.observe(document.body, { childList: true })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      resize.disconnect()
      overlays.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      port.setNativeBounds!(tabId, null)
    }
  }, [port, tabId])

  return <div ref={slotRef} data-browser-panel-content="native" className="min-h-0 flex-1 bg-card" aria-label="Browser page" />
}
