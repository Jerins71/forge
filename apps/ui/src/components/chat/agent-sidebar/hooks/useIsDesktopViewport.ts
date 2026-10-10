import { useSyncExternalStore } from 'react'

// Tailwind's `md` breakpoint, where the sidebar becomes an inline column instead of an overlay.
const DESKTOP_QUERY = '(min-width: 48rem)'

function subscribe(listener: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(DESKTOP_QUERY)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

const getSnapshot = () => typeof window.matchMedia !== 'function' || window.matchMedia(DESKTOP_QUERY).matches
const getServerSnapshot = () => true

/** Whether the sidebar is shown as the inline desktop column rather than the mobile overlay. */
export function useIsDesktopViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
