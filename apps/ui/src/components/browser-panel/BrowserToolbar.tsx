import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Lock, Monitor, PanelRight, RotateCw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { BrowserPanelTab } from './browser-panel-port'

interface BrowserToolbarProps {
  tab: BrowserPanelTab | null
  disabled: boolean
  focusAddressNonce: number
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onNavigate: (url: string) => void
  onOpenExternal: () => void
  onViewportMode: (mode: 'desktop' | 'panel') => void
}

/** Back, forward, reload and the address bar, with a loading bar on the bottom edge. */
export function BrowserToolbar({
  tab, disabled, focusAddressNonce, onBack, onForward, onReload, onNavigate, onOpenExternal, onViewportMode,
}: BrowserToolbarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const url = tab && tab.url !== 'about:blank' ? tab.url : ''

  useEffect(() => {
    if (focusAddressNonce === 0) return
    inputRef.current?.focus()
  }, [focusAddressNonce])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next = draft.trim()
    if (!next) return
    onNavigate(next)
    inputRef.current?.blur()
  }

  const secure = url.startsWith('https://')

  return (
    <div className="relative shrink-0 border-b border-hairline">
      <form onSubmit={submit} className="flex h-10 items-center gap-0.5 px-1.5" aria-label="Browser navigation">
        <ToolbarButton label="Back" disabled={disabled || !tab?.canGoBack} onClick={onBack}><ArrowLeft /></ToolbarButton>
        <ToolbarButton label="Forward" disabled={disabled || !tab?.canGoForward} onClick={onForward}><ArrowRight /></ToolbarButton>
        <ToolbarButton label="Reload" disabled={disabled || !tab} onClick={onReload}>
          <RotateCw className={cn(tab?.loading && 'animate-spin [animation-duration:1.2s]')} />
        </ToolbarButton>
        <div className="group/address relative mx-1 flex h-7 min-w-0 flex-1 items-center rounded-lg bg-foreground/[0.045] transition-colors focus-within:bg-card focus-within:ring-2 focus-within:ring-ring/50 hover:bg-foreground/[0.07] focus-within:hover:bg-card">
          {secure && !editing ? <Lock className="ml-2.5 size-3 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
          <label htmlFor="browser-panel-address" className="sr-only">Address</label>
          <input
            ref={inputRef}
            id="browser-panel-address"
            value={editing ? draft : url}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => {
              setDraft(url)
              setEditing(true)
              const input = event.currentTarget
              queueMicrotask(() => input.select())
            }}
            onBlur={() => setEditing(false)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              setDraft(url)
              inputRef.current?.blur()
            }}
            placeholder="Search or enter address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={disabled || !tab}
            className="h-full min-w-0 flex-1 bg-transparent px-2.5 font-mono text-[12px] text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          {!editing && url ? (
            <button
              type="button"
              aria-label="Open in your browser"
              title="Open in your browser"
              disabled={disabled}
              onClick={onOpenExternal}
              className="mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/[0.08] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 group-hover/address:opacity-100"
            >
              <ExternalLink className="size-3" />
            </button>
          ) : null}
        </div>
        {/* Pages render at desktop size, scaled to fit, so agents see the layout people do. Fit to
            panel lays the page out at the panel's own size instead, which reads better up close. */}
        {tab?.viewportMode ? (
          tab.viewportMode === 'panel'
            ? <ToolbarButton label="Desktop size" disabled={disabled} onClick={() => onViewportMode('desktop')}><Monitor /></ToolbarButton>
            : <ToolbarButton label="Fit to panel" disabled={disabled} onClick={() => onViewportMode('panel')}><PanelRight /></ToolbarButton>
        ) : null}
      </form>
      {tab?.loading ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-[-1px] h-0.5 overflow-hidden" aria-hidden="true">
          <div className="browser-panel-progress h-full w-full rounded-full bg-primary" />
        </div>
      ) : null}
    </div>
  )
}

function ToolbarButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  )
}
