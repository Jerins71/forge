import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Bot, Globe2, Loader2, PanelRightClose, Plus, TriangleAlert, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { BrowserPanelTab } from './browser-panel-port'

interface BrowserTabStripProps {
  tabs: BrowserPanelTab[]
  activeTabId: string | null
  disabled: boolean
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onNewTab: () => void
  onClosePanel: () => void
}

/** The panel's top row: one tab per page, the agent's marked, then new-tab and close-panel. */
export function BrowserTabStrip({ tabs, activeTabId, disabled, onActivate, onClose, onNewTab, onClosePanel }: BrowserTabStripProps) {
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the active tab in view when an agent opens one off-screen.
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const index = tabs.findIndex((tab) => tab.tabId === activeTabId)
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
    if (!next) return
    event.preventDefault()
    onActivate(next.tabId)
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(next.tabId)}"] [role="tab"]`)?.focus())
  }

  return (
    <div className="flex h-[62px] shrink-0 items-center gap-1 border-b border-hairline pl-2 pr-1.5">
      <div
        ref={listRef}
        role="tablist"
        aria-label="Browser tabs"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => (
          <BrowserTabChip
            key={tab.tabId}
            tab={tab}
            active={tab.tabId === activeTabId}
            disabled={disabled}
            onActivate={() => onActivate(tab.tabId)}
            onClose={() => onClose(tab.tabId)}
          />
        ))}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="New tab"
            disabled={disabled}
            onClick={onNewTab}
            className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Plus className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>New tab</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Close browser panel"
            onClick={onClosePanel}
            className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <PanelRightClose className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>Close browser panel</TooltipContent>
      </Tooltip>
    </div>
  )
}

function BrowserTabChip({ tab, active, disabled, onActivate, onClose }: {
  tab: BrowserPanelTab
  active: boolean
  disabled: boolean
  onActivate: () => void
  onClose: () => void
}) {
  const title = tabTitle(tab)
  const agentDriving = tab.controller === 'agent'
  return (
    <div
      data-tab-id={tab.tabId}
      data-agent-tab={agentDriving ? 'driving' : undefined}
      className={cn(
        'group relative flex h-8 min-w-[7.5rem] max-w-[13rem] flex-1 basis-[11rem] items-center rounded-lg border text-[12.5px] transition-colors',
        active
          ? 'border-hairline bg-card text-foreground shadow-[inset_0_1px_0_var(--glass-highlight),0_1px_2px_rgb(18_18_28/0.06)]'
          : 'border-transparent text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
        agentDriving && 'border-primary/35',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        disabled={disabled}
        onClick={onActivate}
        title={agentDriving && tab.agentAction ? `${title} — Agent: ${tab.agentAction}` : title}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pl-2.5 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
      >
        <TabIcon tab={tab} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {agentDriving ? <AgentMark /> : null}
      </button>
      <button
        type="button"
        aria-label={`Close ${title}`}
        disabled={disabled}
        onClick={onClose}
        className={cn(
          'mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-foreground/[0.08] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

function TabIcon({ tab }: { tab: BrowserPanelTab }) {
  if (tab.loading) return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
  if (tab.crashed || tab.error) return <TriangleAlert className="size-3.5 shrink-0 text-[var(--status-attention)]" aria-hidden="true" />
  if (tab.faviconUrl) return <img src={tab.faviconUrl} alt="" className="size-3.5 shrink-0 rounded-sm object-contain" />
  return <Globe2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
}

/** The agent's mark on the tab it is driving. */
function AgentMark() {
  return (
    <span
      className="live-dot-animated inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
      aria-label="Agent is driving this tab"
      role="img"
    >
      <Bot className="size-2.5" strokeWidth={2.25} />
    </span>
  )
}

function tabTitle(tab: BrowserPanelTab): string {
  if (tab.title.trim()) return tab.title
  if (!tab.url || tab.url === 'about:blank') return 'New tab'
  try { return new URL(tab.url).host || tab.url } catch { return tab.url }
}
