import type { LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type ActivityRailItemId =
  | 'chat'
  | 'artifacts'
  | 'schedules'
  | 'files'
  | 'terminal'
  | 'changes'

export interface ActivityRailItem {
  id: ActivityRailItemId
  label: string
  icon: LucideIcon
  active?: boolean
  disabled?: boolean
  badge?: number
  shortcutLabel?: string
  onClick: () => void
}

interface ActivityRailProps {
  items: ActivityRailItem[]
  /** Gates all Rooms rail styling. */
  roomsV2?: boolean
}

function formatTooltipLabel(label: string, shortcutLabel?: string): string {
  return shortcutLabel ? `${label} (${shortcutLabel})` : label
}

function ActivityRailButton({ item, roomsV2 = false }: { item: ActivityRailItem; roomsV2?: boolean }) {
  const { label, icon: Icon, active, disabled, badge, shortcutLabel, onClick } = item
  const tooltip = formatTooltipLabel(label, shortcutLabel)
  const ariaLabel = badge ? `${tooltip} (${badge})` : tooltip

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'relative inline-flex items-center justify-center text-muted-foreground transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            roomsV2 ? 'size-9 rounded-[11px] bg-transparent' : 'size-10 rounded-xl bg-transparent',
            active
              ? 'bg-foreground/[0.08] text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]'
              : 'hover:bg-foreground/[0.05] hover:text-foreground',
          )}
          onClick={onClick}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-pressed={active}
          aria-current={active ? 'true' : undefined}
        >
          <Icon className="size-[18px]" strokeWidth={1.75} />
          {badge && badge > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-primary px-1 font-mono text-[9.5px] font-medium leading-none tabular-nums text-primary-foreground ring-2 ring-sidebar"
            >
              {badge > 9 ? '9+' : badge}
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export function ActivityRail({ items, roomsV2 = false }: ActivityRailProps) {
  return (
    <TooltipProvider delayDuration={200}>
      <nav
        className={cn(
          'hidden h-full w-[52px] shrink-0 flex-col items-center gap-1.5 bg-sidebar py-2.5 md:flex',
          roomsV2 ? 'border-x border-sidebar-border' : 'border-r border-sidebar-border',
        )}
        aria-label="Activity rail"
      >
        {items.map((item) => (
          <div key={item.id} className="flex w-full flex-col items-center gap-1.5">
            <ActivityRailButton item={item} roomsV2={roomsV2} />
          </div>
        ))}
      </nav>
    </TooltipProvider>
  )
}
