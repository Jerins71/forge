import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { BrowserNativeSlot } from './BrowserNativeSlot'
import { BrowserAvailabilityState, BrowserEmptyState, BrowserTabErrorState } from './BrowserPanelStates'
import { BrowserPanelResizeHandle, BROWSER_PANEL_WIDTH_VAR } from './BrowserPanelResizeHandle'
import { BrowserScreencast } from './BrowserScreencast'
import { BrowserTabStrip } from './BrowserTabStrip'
import { BrowserToolbar } from './BrowserToolbar'
import { BROWSER_PANEL_DEFAULT_WIDTH, BROWSER_PANEL_MIN_WIDTH } from './browser-panel-layout'
import type { BrowserPanelPort, BrowserPanelSnapshot, BrowserPanelTab } from './browser-panel-port'

interface BrowserPanelProps {
  port: BrowserPanelPort
  snapshot: BrowserPanelSnapshot
  /** Docked beside the chat (resizable) or floating over it on narrow windows. */
  docked: boolean
  onClose: () => void
}

/** The right-side browser: tabs shared with the agent, a navigation bar, and the live page. */
export function BrowserPanel({ port, snapshot, docked, onClose }: BrowserPanelProps) {
  const [error, setError] = useState<string | null>(null)
  const [focusAddressNonce, setFocusAddressNonce] = useState(0)
  // A machine without a browser yet still takes addresses: opening a page installs it.
  const ready = usable(snapshot)
  const activeTab = snapshot.tabs.find((tab) => tab.tabId === snapshot.activeTabId) ?? null

  const run = (action: () => Promise<unknown>) => {
    setError(null)
    action().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
  }
  const withTab = (action: (tab: BrowserPanelTab) => Promise<unknown>) => () => { if (activeTab) run(() => action(activeTab)) }

  const newTab = () => {
    run(() => port.open())
    setFocusAddressNonce((nonce) => nonce + 1)
  }

  // Esc from anywhere in the floating panel closes it, like other sheets.
  useEffect(() => {
    if (docked) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && document.activeElement?.closest('[data-browser-panel]')) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [docked, onClose])

  return (
    <TooltipProvider delayDuration={300}>
      <aside
        data-browser-panel={docked ? 'docked' : 'floating'}
        aria-label="Browser"
        className={cn(
          'flex h-full min-h-0 flex-col',
          docked
            ? 'relative shrink border-l border-hairline bg-card/50'
            : 'fixed inset-y-0 right-0 z-40 w-[min(100vw,32rem)] border-l border-hairline bg-card shadow-[0_0_0_1px_var(--hairline),-24px_0_60px_-28px_rgb(18_18_28/0.35)]',
        )}
        style={docked ? {
          width: `var(${BROWSER_PANEL_WIDTH_VAR}, ${BROWSER_PANEL_DEFAULT_WIDTH}px)`,
          minWidth: BROWSER_PANEL_MIN_WIDTH,
        } : undefined}
      >
        {docked ? <BrowserPanelResizeHandle /> : null}
        <BrowserTabStrip
          tabs={snapshot.tabs}
          activeTabId={activeTab?.tabId ?? null}
          disabled={!ready}
          onActivate={(tabId) => run(() => port.activate(tabId))}
          onClose={(tabId) => run(() => port.close(tabId))}
          onNewTab={newTab}
          onClosePanel={onClose}
        />
        <BrowserToolbar
          tab={ready ? activeTab : null}
          disabled={!ready}
          focusAddressNonce={focusAddressNonce}
          onBack={withTab((tab) => port.history(tab.tabId, 'back'))}
          onForward={withTab((tab) => port.history(tab.tabId, 'forward'))}
          onReload={withTab((tab) => port.reload(tab.tabId))}
          onNavigate={(url) => { if (activeTab) run(() => port.navigate(activeTab.tabId, url)) }}
          onOpenExternal={withTab((tab) => port.openExternal(tab.tabId))}
        />
        {ready && activeTab?.controller === 'agent' ? <AgentStrip tab={activeTab} /> : null}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <BrowserContent port={port} snapshot={snapshot} activeTab={activeTab} onNewTab={newTab} onReload={withTab((tab) => port.reload(tab.tabId))} />
        </div>
        {error ? (
          <div role="alert" className="flex items-start gap-2 border-t border-destructive/20 bg-destructive/[0.06] px-3 py-2 text-[12px] text-destructive">
            <span className="min-w-0 flex-1">{error}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setError(null)} className="rounded p-0.5 hover:bg-destructive/10"><X className="size-3" /></button>
          </div>
        ) : null}
      </aside>
    </TooltipProvider>
  )
}

function BrowserContent({ port, snapshot, activeTab, onNewTab, onReload }: {
  port: BrowserPanelPort
  snapshot: BrowserPanelSnapshot
  activeTab: BrowserPanelTab | null
  onNewTab: () => void
  onReload: () => void
}) {
  const { availability } = snapshot
  // Without a browser yet, an empty panel offers setup; tabs already open still show.
  if (availability.kind !== 'ready' && (!usable(snapshot) || !activeTab)) {
    return <BrowserAvailabilityState availability={availability} onSetup={port.setup ? () => void port.setup!() : undefined} />
  }
  if (!activeTab) return <BrowserEmptyState onNewTab={onNewTab} disabled={false} />
  if (activeTab.crashed) return <BrowserTabErrorState crashed message={activeTab.error} onReload={onReload} />
  if (snapshot.surface === 'native') return <BrowserNativeSlot key={activeTab.tabId} port={port} tabId={activeTab.tabId} />
  return <BrowserScreencast key={activeTab.tabId} port={port} tabId={activeTab.tabId} agentCursor={activeTab.agentCursor ?? null} />
}

/** Says the agent is driving the active tab, what it is doing, and how to step in. */
function AgentStrip({ tab }: { tab: BrowserPanelTab }) {
  return (
    <div
      data-browser-agent-strip
      className="flex h-8 shrink-0 items-center gap-2 border-b border-primary/15 bg-primary/[0.06] px-3 text-[12px]"
      role="status"
      aria-live="polite"
    >
      <span className="live-dot live-dot-animated" aria-hidden="true" />
      <span className="shrink-0 font-medium text-primary">Agent is driving</span>
      {tab.agentAction ? <span className="min-w-0 truncate text-muted-foreground">· {tab.agentAction}</span> : null}
      <span className="ml-auto shrink-0 pl-2 text-[11.5px] text-subtle-foreground">Click or type to take over</span>
    </div>
  )
}

function usable({ availability }: BrowserPanelSnapshot): boolean {
  return availability.kind === 'ready' || (availability.kind === 'setup' && availability.state === 'missing')
}
