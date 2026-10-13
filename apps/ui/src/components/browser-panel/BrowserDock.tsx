import { useCallback } from 'react'
import { Globe2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { BrowserPanel, useBrowserPanelSnapshot, useRevealOnAgentTab } from './BrowserPanel'
import { useBrowserPanelDocked } from './browser-panel-layout'
import type { BrowserPanelPort } from './browser-panel-port'

interface BrowserDockProps {
  port: BrowserPanelPort
  /** The session in view; tabs present when it is first shown never open the panel by themselves. */
  sessionKey: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** The browser panel beside the chat: shown when open, and opened when the agent opens a page. */
export function BrowserDock({ port, sessionKey, open, onOpenChange }: BrowserDockProps) {
  const snapshot = useBrowserPanelSnapshot(port)
  const docked = useBrowserPanelDocked()
  const reveal = useCallback(() => onOpenChange(true), [onOpenChange])
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  useRevealOnAgentTab(snapshot, sessionKey, reveal)
  if (!open) return null
  return <BrowserPanel port={port} snapshot={snapshot} docked={docked} onClose={close} />
}

/** The chat header's Browser button: the open tab count, and a live dot while the agent drives one. */
export function BrowserPanelToggle({ port, open, onToggle }: { port: BrowserPanelPort; open: boolean; onToggle: () => void }) {
  const snapshot = useBrowserPanelSnapshot(port)
  const tabCount = snapshot.tabs.length
  const agentDriving = snapshot.tabs.some((tab) => tab.controller === 'agent')
  const label = open ? 'Close browser' : 'Browser'
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'relative size-9 shrink-0 rounded-lg transition-colors md:size-[30px]',
              open
                ? 'bg-foreground/[0.07] text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]'
                : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
            )}
            onClick={onToggle}
            aria-label={tabCount > 0 ? `${label} (${tabCount} ${tabCount === 1 ? 'tab' : 'tabs'})` : label}
            aria-pressed={open}
            data-testid="browser-panel-toggle"
          >
            <Globe2 className="size-3.5" />
            {agentDriving ? (
              <span className="live-dot live-dot-animated absolute right-1 top-1 !size-1.5" aria-hidden="true" />
            ) : !open && tabCount > 0 ? (
              <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground" aria-hidden="true">
                {tabCount > 9 ? '9+' : tabCount}
              </span>
            ) : null}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
