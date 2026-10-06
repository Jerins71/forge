import { cn } from '@/lib/utils'

type FileStatusType = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked'

interface FileStatusBadgeProps {
  status: FileStatusType
  className?: string
}

const STATUS_CONFIG: Record<FileStatusType, { label: string; className: string }> = {
  modified:  { label: 'M', className: 'bg-foreground/[0.07] text-muted-foreground' },
  added:     { label: 'A', className: 'bg-success/15 text-success' },
  deleted:   { label: 'D', className: 'bg-danger/15 text-danger' },
  renamed:   { label: 'R', className: 'bg-primary/15 text-primary' },
  copied:    { label: 'C', className: 'bg-compacting/15 text-compacting' },
  untracked: { label: 'U', className: 'bg-foreground/[0.05] text-subtle-foreground' },
}

export function FileStatusBadge({ status, className }: FileStatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.modified

  return (
    <span
      className={cn(
        'inline-flex size-[18px] shrink-0 items-center justify-center rounded-md font-mono text-[10px] font-semibold leading-none',
        config.className,
        className,
      )}
      title={status}
    >
      {config.label}
    </span>
  )
}
