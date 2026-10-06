import type { ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'

interface SidebarSearchProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  /** Optional element rendered to the right of the classic search input. */
  rightAction?: ReactNode
  /** Project View chip inserted into the Rooms command row. */
  commandAction?: ReactNode
  /** Gates the consolidated Rooms command row. */
  roomsV2?: boolean
}

export function SidebarSearch({
  searchQuery,
  onSearchChange,
  searchInputRef,
  rightAction,
  commandAction,
  roomsV2 = false,
}: SidebarSearchProps) {
  if (roomsV2) {
    return (
      <div className="py-2" data-testid="sidebar-command-row">
        <div className="glass-inset flex h-9 items-center gap-1.5 rounded-[10px] px-2.5 transition-colors focus-within:border-ring/50">
          <Search className="pointer-events-none size-3.5 shrink-0 text-subtle-foreground" strokeWidth={1.75} aria-hidden="true" />
          {commandAction}
          <div className="relative min-w-0 flex-1">
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Filter sessions"
              className="h-7 rounded-none border-0 bg-transparent px-0 pr-5 text-[13px] shadow-none placeholder:text-subtle-foreground focus-visible:ring-0 dark:bg-transparent"
            />
            {searchQuery.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  onSearchChange('')
                  searchInputRef.current?.focus()
                }}
                className="absolute right-0 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                aria-label="Clear search"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>
          {rightAction}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" aria-hidden="true" />
        <Input
          ref={searchInputRef}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Filter sessions"
          className="h-7 pl-7 pr-7 text-xs placeholder:text-muted-foreground/50"
        />
        {searchQuery.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              onSearchChange('')
              searchInputRef.current?.focus()
            }}
            className="absolute right-1.5 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            aria-label="Clear search"
          >
            <X className="size-3" />
          </button>
        ) : null}
      </div>
      {rightAction}
    </div>
  )
}
