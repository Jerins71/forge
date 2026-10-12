import { useCallback, useState } from 'react'

const COLLAPSED_INBOX_SECTIONS_KEY = 'forge-sidebar-collapsed-inbox-sections'

function readStoredCollapsedSections(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSED_INBOX_SECTIONS_KEY) ?? '[]')
    return Array.isArray(parsed) ? new Set(parsed.filter((value) => typeof value === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

/** Which Inbox sections (Needs you, Active, Recent) the user collapsed, persisted across reloads. */
export function useCollapsedInboxSections(): {
  collapsedSections: ReadonlySet<string>
  toggleSectionCollapsed: (section: string) => void
} {
  const [collapsedSections, setCollapsedSections] = useState(readStoredCollapsedSections)

  const toggleSectionCollapsed = useCallback((section: string) => {
    // Toggle the stored value (not React state in an updater) so StrictMode's double call can't flip it twice.
    const next = readStoredCollapsedSections()
    if (!next.delete(section)) next.add(section)
    try {
      localStorage.setItem(COLLAPSED_INBOX_SECTIONS_KEY, JSON.stringify([...next]))
    } catch {
      // Ignore localStorage write failures (quota, etc.)
    }
    setCollapsedSections(next)
  }, [])

  return { collapsedSections, toggleSectionCollapsed }
}
