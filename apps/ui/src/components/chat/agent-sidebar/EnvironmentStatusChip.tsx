import { memo } from 'react'
import { cn } from '@/lib/utils'
import type { EnvironmentStatus, EnvironmentStatusKind } from '@/components/settings/environments/environment-status'
import { useEnvironmentStatus } from './hooks/useEnvironmentStatus'

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

/** Readable machine badge for a session row; the label is the environment's display name. */
export function EnvironmentBadge({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-24 shrink-0 items-center rounded border border-sidebar-border px-1 text-[10px] leading-4 text-muted-foreground',
        className,
      )}
      data-environment-badge={label}
      title={`Runs on ${label}`}
    >
      <span className="truncate">{label}</span>
    </span>
  )
}
