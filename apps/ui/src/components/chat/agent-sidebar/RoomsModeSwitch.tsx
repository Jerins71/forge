import { cn } from '@/lib/utils'

const SELECTED = 'bg-foreground/[0.08] text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]'

export type RoomsMode = 'inbox' | 'projects'

export function RoomsModeSwitch({
  mode,
  needsYouCount,
  onChange,
}: {
  mode: RoomsMode
  needsYouCount?: number
  onChange: (mode: RoomsMode) => void
}) {
  return (
    <div
      className="glass-inset mt-1 inline-flex w-full gap-0.5 rounded-[10px] p-0.5"
      aria-label="New project view sidebar mode"
      data-testid="rooms-mode-switch"
    >
      <button
        type="button"
        aria-pressed={mode === 'inbox'}
        onClick={() => onChange('inbox')}
        className={cn(
          'flex min-h-7 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          mode === 'inbox' ? SELECTED : 'text-subtle-foreground hover:text-foreground',
        )}
      >
        Inbox
        {needsYouCount && needsYouCount > 0 ? (
          <span className="sidebar-room-unread-badge" aria-label={`${needsYouCount} sessions need you`}>
            {needsYouCount > 99 ? '99+' : needsYouCount}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-pressed={mode === 'projects'}
        onClick={() => onChange('projects')}
        className={cn(
          'min-h-7 flex-1 rounded-lg px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          mode === 'projects' ? SELECTED : 'text-subtle-foreground hover:text-foreground',
        )}
      >
        Projects
      </button>
    </div>
  )
}
