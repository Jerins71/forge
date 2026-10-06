import { memo } from 'react'
import { cn } from '@/lib/utils'
import type { EnvironmentStatus, EnvironmentStatusKind } from '@/components/settings/environments/environment-status'
import { Server } from 'lucide-react'
import { useEnvironmentLabel, useEnvironmentStatus, useIsRemoteEnvironment } from './hooks/useEnvironmentStatus'

/** Same signal palette as session status: green healthy, accent working, amber needs you, red broken. */
const TONE: Record<EnvironmentStatusKind, string> = {
  online: 'bg-success',
  connecting: 'bg-primary animate-pulse',
  offline: 'bg-foreground/25',
  'needs-pairing': 'bg-attention',
  revoked: 'bg-danger',
  'update-required': 'bg-attention',
  'identity-changed': 'bg-danger',
  disabled: 'bg-foreground/15',
}

export function EnvironmentStatusDot({ status, className }: { status: EnvironmentStatus; className?: string }) {
  return (
    <span
      className={cn('inline-block size-[7px] shrink-0 rounded-full', TONE[status.kind], className)}
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
      className={cn('inline-flex min-w-0 items-center gap-1.5 text-[11px] text-subtle-foreground', className)}
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
        'inline-flex h-4 max-w-24 shrink-0 items-center rounded-[5px] bg-foreground/[0.06] px-1.5 font-mono text-[10px] leading-4 text-subtle-foreground',
        className,
      )}
      data-environment-badge={label}
      title={`Runs on ${label}`}
    >
      <span className="truncate">{label}</span>
    </span>
  )
}

/** Names the machine in a panel header when it is not this one; renders nothing for the primary. */
export function RemoteMachineBadge({ environmentId, className }: { environmentId: string | null | undefined; className?: string }) {
  return useIsRemoteEnvironment(environmentId) ? <RemoteMachineLabel environmentId={environmentId!} className={className} /> : null
}

function RemoteMachineLabel({ environmentId, className }: { environmentId: string; className?: string }) {
  const label = useEnvironmentLabel(environmentId)
  return (
    <span
      className={cn('inline-flex min-w-0 shrink items-center gap-1.5 text-[11px] text-subtle-foreground', className)}
      data-testid="panel-machine"
      title={`Files and commands run on ${label}`}
    >
      <Server className="size-3 shrink-0" aria-hidden="true" />
      <EnvironmentBadge label={label} />
    </span>
  )
}
