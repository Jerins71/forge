import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, FolderPlus, Search } from 'lucide-react'
import type { LogicalProjectGroup } from '@forge/client-runtime'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useLogicalProjects } from '@/hooks/use-environment-selector'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'
import { rankChatProjects } from '@/lib/new-chat-project'
import { cn } from '@/lib/utils'

const NEW_PROJECT = '\u0000new-project'

/** The new chat's project, as a heading word: recent projects first, type to find the rest. */
export function NewChatProjectPicker({ title, groupKey, onSelect, onNewProject }: {
  title: string
  groupKey: string
  onSelect: (groupKey: string) => void
  onNewProject?: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-testid="new-chat-project-picker"
        className="inline-flex max-w-full min-w-0 items-baseline gap-1 rounded-md border-b border-dotted border-muted-foreground/40 px-0.5 align-baseline transition-colors hover:border-foreground/60 hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="min-w-0 truncate">{title}</span>
        <ChevronDown className="size-5 shrink-0 self-center text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="center" collisionPadding={12} className="w-80 overflow-hidden p-0">
        {open ? (
          <ProjectList
            current={groupKey}
            onSelect={(key) => { setOpen(false); if (key !== groupKey) onSelect(key) }}
            onNewProject={onNewProject ? () => { setOpen(false); onNewProject() } : undefined}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function ProjectList({ current, onSelect, onNewProject }: {
  current: string
  onSelect: (groupKey: string) => void
  onNewProject?: () => void
}) {
  const groups = useLogicalProjects()
  const registry = useEnvironmentRegistry()
  // Ranked once per opening, so the list does not reorder under the pointer.
  const ranked = useMemo(() => rankChatProjects(groups.values(), registry), [groups, registry])
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const matches: LogicalProjectGroup[] = needle ? ranked.filter((group) => group.title.toLowerCase().includes(needle)) : ranked
  const rows = [...matches.map((group) => group.key), ...(onNewProject && !needle ? [NEW_PROJECT] : [])]
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => { setHighlight(0) }, [needle])
  useEffect(() => {
    listRef.current?.querySelector(`[data-project-index="${highlight}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [highlight])
  const choose = (key: string | undefined) => {
    if (key === NEW_PROJECT) onNewProject?.()
    else if (key) onSelect(key)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight((index) => Math.min(index + 1, rows.length - 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight((index) => Math.max(index - 1, 0)) }
    else if (event.key === 'Enter') { event.preventDefault(); choose(rows[highlight]) }
  }
  const rowClass = (index: number) => cn(
    'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]',
    index === highlight && 'bg-foreground/[0.06]',
  )

  return (
    <div className="flex max-h-[min(60vh,24rem)] flex-col" onKeyDown={onKeyDown}>
      <label className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2.5">
        <Search className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search projects..."
          aria-label="Search projects"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-subtle-foreground"
        />
      </label>
      <div ref={listRef} role="listbox" aria-label="Projects" className="min-h-0 flex-1 overflow-y-auto p-1.5 [scrollbar-width:thin]">
        {matches.map((group, index) => (
          <div
            key={group.key}
            role="option"
            aria-selected={group.key === current}
            data-project-index={index}
            onMouseEnter={() => setHighlight(index)}
            onClick={() => choose(group.key)}
            className={cn(rowClass(index), group.key === current && 'font-medium text-foreground')}
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-foreground/[0.07] text-[10.5px] font-semibold uppercase text-muted-foreground" aria-hidden="true">
              {group.title.slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1 truncate">{group.title}</span>
          </div>
        ))}
        {matches.length === 0 ? <p className="px-2.5 py-3 text-[12.5px] text-muted-foreground">No projects match.</p> : null}
        {onNewProject && !needle ? (
          <>
            <div className="mx-1 my-1 border-t border-hairline" />
            <div
              role="option"
              aria-selected={false}
              data-project-index={matches.length}
              onMouseEnter={() => setHighlight(matches.length)}
              onClick={() => choose(NEW_PROJECT)}
              className={cn(rowClass(matches.length), 'text-muted-foreground')}
            >
              <FolderPlus className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
              <span>New project</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
