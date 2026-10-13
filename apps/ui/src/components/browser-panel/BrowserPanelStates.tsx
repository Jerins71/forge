import type { ReactNode } from 'react'
import { Download, Globe2, Loader2, MonitorOff, RotateCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScreencastSkeleton } from './BrowserScreencast'
import { BrowserHostSetupCommand } from './BrowserHostSetupCommand'
import type { BrowserPanelAvailability } from './browser-panel-port'

function StateCard({ icon, title, detail, children, role }: { icon: ReactNode; title: string; detail: ReactNode; children?: ReactNode; role?: 'status' | 'alert' }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8" role={role}>
      <div className="flex max-w-[22rem] flex-col items-center text-center">
        <div className="mb-4 flex size-11 items-center justify-center rounded-xl border border-hairline bg-card text-muted-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]">
          {icon}
        </div>
        <h3 className="text-[14px] font-medium text-foreground">{title}</h3>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{detail}</p>
        {children ? <div className="mt-4 flex items-center gap-2">{children}</div> : null}
      </div>
    </div>
  )
}

/** No tabs yet: the agent opens pages here, or the person types an address. */
export function BrowserEmptyState({ onNewTab, disabled }: { onNewTab: () => void; disabled: boolean }) {
  return (
    <StateCard
      icon={<Globe2 className="size-5" />}
      title="No pages open"
      detail="Pages your agent opens show up here, and you can watch or step in at any time. You can also open one yourself."
    >
      <Button size="sm" variant="secondary" onClick={onNewTab} disabled={disabled}>Open a page</Button>
    </StateCard>
  )
}

/** The engine is not ready for this session: connecting, installing, or unavailable. */
export function BrowserAvailabilityState({ availability, onSetup }: { availability: Exclude<BrowserPanelAvailability, { kind: 'ready' }>; onSetup?: () => void }) {
  if (availability.kind === 'connecting') {
    return <div className="relative min-h-0 flex-1"><ScreencastSkeleton /></div>
  }
  if (availability.kind === 'setup') {
    if (availability.state === 'needs-host-setup') return (
      <StateCard role="alert" icon={<TriangleAlert className="size-5 text-[var(--status-attention)]" />} title="This machine needs a one-time setup" detail={<>Run this command on {availability.machineLabel}, then retry.</>}>
        <div><BrowserHostSetupCommand command={availability.setupCommand} />{onSetup ? <Button className="mt-3" size="sm" onClick={onSetup}>Retry</Button> : null}</div>
      </StateCard>
    )
    if (availability.state === 'installing') {
      return (
        <StateCard
          role="status"
          icon={<Loader2 className="size-5 animate-spin" />}
          title="Setting up the browser…"
          detail={<>Installing a browser on <span className="font-medium text-foreground">{availability.machineLabel}</span>. This happens once.</>}
        />
      )
    }
    const failed = availability.state === 'failed'
    return (
      <StateCard
        role={failed ? 'alert' : undefined}
        icon={failed ? <TriangleAlert className="size-5 text-[var(--status-attention)]" /> : <Download className="size-5" />}
        title={failed ? 'Browser setup didn’t finish' : 'This machine has no browser yet'}
        detail={failed
          ? (availability.message ?? `Forge couldn’t install a browser on ${availability.machineLabel}.`)
          : <>Forge installs one on <span className="font-medium text-foreground">{availability.machineLabel}</span> the first time an agent needs it, or you can set it up now.</>}
      >
        {onSetup ? <Button size="sm" onClick={onSetup}>{failed ? 'Try again' : 'Set up'}</Button> : null}
      </StateCard>
    )
  }
  return <StateCard icon={<MonitorOff className="size-5" />} title={availability.title} detail={availability.detail} />
}

/** The active tab crashed or failed to load. */
export function BrowserTabErrorState({ crashed, message, onReload }: { crashed: boolean; message: string | null; onReload: () => void }) {
  return (
    <StateCard
      role="alert"
      icon={<TriangleAlert className="size-5 text-[var(--status-attention)]" />}
      title={crashed ? 'This tab crashed' : 'This page didn’t load'}
      detail={message ?? (crashed ? 'The page stopped responding.' : 'Check the address, or try again.')}
    >
      <Button size="sm" variant="secondary" onClick={onReload}><RotateCw className="size-3.5" />Reload</Button>
    </StateCard>
  )
}
