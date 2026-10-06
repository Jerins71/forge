import { useEffect, useId, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Check, CornerDownLeft, Search } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export type CommandPaletteSessionStatus = 'live' | 'attention' | 'error' | 'idle'

export interface CommandPaletteSession {
  id: string
  title: string
  projectName: string
  status: CommandPaletteSessionStatus
  /** ISO timestamp used for recency ordering and the relative-time hint. */
  updatedAt: string
}

export interface CommandPaletteCommand {
  id: string
  label: string
  icon: LucideIcon
  shortcut?: string
  disabled?: boolean
  run: () => void
}

type Scope = 'all' | 'sessions' | 'commands'

const SCOPES: Array<{ id: Scope; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'commands', label: 'Commands' },
]

const EMPTY_QUERY_SESSION_LIMIT = 6
const SESSION_RESULT_LIMIT = 30

type Result =
  | { kind: 'session'; key: string; session: CommandPaletteSession }
  | { kind: 'command'; key: string; command: CommandPaletteCommand }

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: CommandPaletteSession[]
  commands: CommandPaletteCommand[]
  activeSessionId?: string | null
  onSelectSession: (sessionId: string) => void
}

/** Every whitespace-separated term must appear somewhere in the haystack. */
function matches(haystack: string, terms: string[]): boolean {
  const value = haystack.toLowerCase()
  return terms.every((term) => value.includes(term))
}

function formatRelative(iso: string, now: number): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const minutes = Math.max(0, Math.round((now - time) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function HighlightedText({ text, terms }: { text: string; terms: string[] }) {
  const term = terms.find((candidate) => candidate && text.toLowerCase().includes(candidate))
  if (!term) return <>{text}</>
  const start = text.toLowerCase().indexOf(term)
  return (
    <>
      {text.slice(0, start)}
      <mark className="bg-transparent text-primary">{text.slice(start, start + term.length)}</mark>
      {text.slice(start + term.length)}
    </>
  )
}

function SessionStatusGlyph({ status }: { status: CommandPaletteSessionStatus }) {
  if (status === 'live') return <span className="live-dot" aria-label="Running" />
  if (status === 'attention') {
    return <span className="size-[7px] flex-none rounded-full bg-attention shadow-[0_0_0_3px_var(--status-attention-surface)]" aria-label="Needs you" />
  }
  if (status === 'error') return <span className="size-[7px] flex-none rounded-full bg-danger" aria-label="Failed" />
  return <span className="size-[7px] flex-none rounded-full border border-subtle-foreground/60" aria-label="Idle" />
}

export function CommandPalette({
  open,
  onOpenChange,
  sessions,
  commands,
  activeSessionId,
  onSelectSession,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  // Snapshot of "now" taken when the palette opens, for relative times.
  const [now, setNow] = useState(0)

  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    setQuery('')
    setScope('all')
    setActiveIndex(0)
  }, [open])

  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query])

  const { sessionResults, commandResults } = useMemo(() => {
    const byRecency = [...sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    const sessionMatches = terms.length === 0
      ? byRecency.slice(0, EMPTY_QUERY_SESSION_LIMIT)
      : byRecency.filter((session) => matches(`${session.title} ${session.projectName}`, terms)).slice(0, SESSION_RESULT_LIMIT)
    const commandMatches = commands.filter((command) => terms.length === 0 || matches(command.label, terms))
    return {
      sessionResults: scope === 'commands' ? [] : sessionMatches,
      commandResults: scope === 'sessions' ? [] : commandMatches,
    }
  }, [commands, scope, sessions, terms])

  const results = useMemo<Result[]>(() => [
    ...sessionResults.map((session): Result => ({ kind: 'session', key: `s:${session.id}`, session })),
    ...commandResults.map((command): Result => ({ kind: 'command', key: `c:${command.id}`, command })),
  ], [commandResults, sessionResults])

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, results.length - 1)))
  }, [results.length])

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const runResult = (result: Result | undefined) => {
    if (!result) return
    if (result.kind === 'command' && result.command.disabled) return
    onOpenChange(false)
    // Let the dialog release focus before the target surface takes it.
    window.requestAnimationFrame(() => {
      if (result.kind === 'session') onSelectSession(result.session.id)
      else result.command.run()
    })
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => (results.length === 0 ? 0 : (index + 1) % results.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => (results.length === 0 ? 0 : (index - 1 + results.length) % results.length))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      runResult(results[activeIndex])
    } else if (event.key === 'Tab') {
      event.preventDefault()
      const current = SCOPES.findIndex((candidate) => candidate.id === scope)
      const step = event.shiftKey ? SCOPES.length - 1 : 1
      setScope(SCOPES[(current + step) % SCOPES.length].id)
      setActiveIndex(0)
    }
  }

  const activeKey = results[activeIndex]?.key
  const optionId = (key: string) => `${listId}-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`

  const renderSection = (label: string, items: Result[]) => items.length === 0 ? null : (
    <div role="group" aria-label={label} className="flex flex-col">
      <div className="eyebrow px-3 pb-1 pt-3">{label}</div>
      {items.map((result) => {
        const index = results.indexOf(result)
        const isActive = result.key === activeKey
        if (result.kind === 'session') {
          const { session } = result
          return (
            <div
              key={result.key}
              id={optionId(result.key)}
              role="option"
              aria-selected={isActive}
              data-active={isActive}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => runResult(result)}
              className={cn(
                'flex cursor-default items-center gap-3 rounded-[11px] px-3 py-2.5 transition-colors',
                isActive && 'bg-foreground/[0.07] shadow-[inset_0_1px_0_var(--glass-highlight)]',
              )}
            >
              <SessionStatusGlyph status={session.status} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-foreground"><HighlightedText text={session.title} terms={terms} /></span>
                <span className="truncate font-mono text-[11.5px] text-subtle-foreground">
                  <HighlightedText text={session.projectName} terms={terms} />
                  {session.id === activeSessionId ? ' · current' : ''}
                </span>
              </span>
              <span className="font-mono text-[11px] tabular-nums text-subtle-foreground">{formatRelative(session.updatedAt, now)}</span>
              {isActive ? <CornerDownLeft className="size-3.5 text-muted-foreground" aria-hidden="true" /> : null}
            </div>
          )
        }
        const { command } = result
        const Icon = command.icon
        return (
          <div
            key={result.key}
            id={optionId(result.key)}
            role="option"
            aria-selected={isActive}
            aria-disabled={command.disabled || undefined}
            data-active={isActive}
            onMouseMove={() => setActiveIndex(index)}
            onClick={() => runResult(result)}
            className={cn(
              'flex cursor-default items-center gap-3 rounded-[11px] px-3 py-2 transition-colors',
              isActive && 'bg-foreground/[0.07] shadow-[inset_0_1px_0_var(--glass-highlight)]',
              command.disabled && 'opacity-45',
            )}
          >
            <Icon className="size-[15px] flex-none text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
            <span className="flex-1 truncate text-sm text-foreground/90"><HighlightedText text={command.label} terms={terms} /></span>
            {command.shortcut ? <span className="font-mono text-[11px] text-subtle-foreground">{command.shortcut}</span> : null}
          </div>
        )
      })}
    </div>
  )

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[3px] data-[state=open]:animate-in data-[state=open]:fade-in-0 dark:bg-black/55" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="glass-strong fixed left-1/2 top-[14vh] z-50 flex max-h-[min(560px,72vh)] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-[20px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <div className="flex items-center gap-3 border-b border-hairline px-[18px] py-4">
            <Search className="size-[18px] flex-none text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={handleKeyDown}
              placeholder="Search sessions and commands…"
              aria-label="Search sessions and commands"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
              className="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-subtle-foreground"
            />
            <kbd className="rounded-md border border-hairline px-1.5 py-0.5 font-mono text-[11px] text-subtle-foreground">esc</kbd>
          </div>

          <div role="tablist" aria-label="Scope" className="flex gap-1 px-3 pb-1 pt-2.5">
            {SCOPES.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                aria-selected={scope === candidate.id}
                onClick={() => {
                  setScope(candidate.id)
                  setActiveIndex(0)
                }}
                className={cn(
                  'h-7 rounded-lg px-3 text-[12.5px] transition-colors',
                  scope === candidate.id
                    ? 'border border-hairline bg-foreground/[0.08] text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {candidate.label}
              </button>
            ))}
          </div>

          <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {results.length === 0 ? (
              <div className="flex flex-col items-center gap-1 px-6 py-10 text-center">
                <Check className="size-4 text-subtle-foreground" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">No matches for “{query.trim()}”</p>
              </div>
            ) : (
              <>
                {renderSection(terms.length === 0 ? 'Recent sessions' : 'Sessions', results.filter((result) => result.kind === 'session'))}
                {renderSection('Commands', results.filter((result) => result.kind === 'command'))}
              </>
            )}
          </div>

          <div className="flex flex-wrap gap-4 border-t border-hairline bg-foreground/[0.02] px-[18px] py-2.5 font-mono text-[11px] text-subtle-foreground">
            <span>↑↓ navigate</span>
            <span>⏎ open</span>
            <span>tab scope</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
