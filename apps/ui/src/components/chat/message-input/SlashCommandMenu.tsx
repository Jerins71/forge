import { type RefObject } from 'react'
import { cn } from '@/lib/utils'
import type { SlashCommand } from '@/components/settings/slash-commands-api'

interface SlashCommandMenuProps {
  menuRef: RefObject<HTMLDivElement | null>
  commands: SlashCommand[]
  selectedIndex: number
  onSelect: (command: SlashCommand) => void
  onHover: (index: number) => void
  /** True when the menu is open but filtered results are empty. */
  showEmpty: boolean
}

export function SlashCommandMenu({
  menuRef,
  commands,
  selectedIndex,
  onSelect,
  onHover,
  showEmpty,
}: SlashCommandMenuProps) {
  if (commands.length > 0) {
    return (
      <div
        ref={menuRef}
        className="glass-strong mb-2 max-h-52 overflow-y-auto rounded-xl p-1"
      >
        {commands.map((cmd, idx) => (
          <button
            key={cmd.id}
            type="button"
            className={cn(
              'flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors duration-150',
              idx === selectedIndex
                ? 'bg-foreground/[0.07] text-foreground'
                : 'text-popover-foreground hover:bg-foreground/[0.05]',
            )}
            onMouseEnter={() => onHover(idx)}
            onMouseDown={(e) => {
              e.preventDefault() // prevent textarea blur
              onSelect(cmd)
            }}
          >
            <code className="shrink-0 font-mono text-[12px] font-medium text-foreground">/{cmd.name}</code>
            <span className="line-clamp-1 text-xs text-muted-foreground">{cmd.description ?? cmd.prompt}</span>
          </button>
        ))}
      </div>
    )
  }

  if (showEmpty) {
    return (
      <div
        ref={menuRef}
        className="glass-strong mb-2 rounded-xl px-3 py-2"
      >
        <p className="text-xs text-muted-foreground">No matching commands</p>
      </div>
    )
  }

  return null
}
