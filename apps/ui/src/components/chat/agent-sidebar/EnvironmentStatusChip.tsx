import { memo, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { useEnvironmentSelector } from '@/hooks/use-environment-selector'
import { selectConnection } from '@/components/settings/environments/environment-runtime'
import { describeEnvironmentStatus, type EnvironmentStatus, type EnvironmentStatusKind } from '@/components/settings/environments/environment-status'

const TONE: Record<EnvironmentStatusKind, string> = {
  online: 'bg-emerald-500',
  connecting: 'bg-sky-500 animate-pulse',
  offline: 'bg-muted-foreground/50',
  'needs-pairing': 'bg-amber-500',
  revoked: 'bg-destructive',
  'update-required': 'bg-amber-500',
  'identity-changed': 'bg-destructive',
  disabled: 'bg-muted-foreground/30',
}

/** Re-renders on this environment's connection changes only; offline age ticks locally. */
export function useEnvironmentStatus(environmentId: string): EnvironmentStatus {
  const connection = useEnvironmentSelector(environmentId, 'connection', selectConnection)
  const ticking = connection.phase === 'offline' || connection.phase === 'backoff'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [ticking])
  return describeEnvironmentStatus(connection, now)
}

export function EnvironmentStatusDot({ status, className }: { status: EnvironmentStatus; className?: string }) {
  return (
    <span
      className={cn('inline-block size-1.5 shrink-0 rounded-full', TONE[status.kind], className)}
      aria-hidden="true"
    />
  )
}

export const EnvironmentStatusChip = memo(function EnvironmentStatusChip({
  environmentId,
  compact = false,
  className,
}: {
  environmentId: string
  /** Compact chips hide the label while online, keeping sidebar rows quiet. */
  compact?: boolean
  className?: string
}) {
  const status = useEnvironmentStatus(environmentId)
  if (compact && status.kind === 'online') return null
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground', className)}
      data-environment-status={status.kind}
      title={status.detail ?? status.label}
    >
      <EnvironmentStatusDot status={status} />
      <span className="truncate">{status.label}</span>
    </span>
  )
})
