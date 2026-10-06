import type { GitCommitMetadata } from '@forge/protocol'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

interface CommitMetadataBadgesProps {
  metadata: GitCommitMetadata | null | undefined
  className?: string
}

const SOURCE_STYLES: Record<string, { label: string; className: string }> = {
  'agent-edit-tool': {
    label: 'Edit tool',
    className: 'border-primary/25 bg-primary/10 text-primary',
  },
  'agent-write-tool': {
    label: 'Write tool',
    className: 'border-primary/25 bg-primary/10 text-primary',
  },
  'api-write-file': {
    label: 'API write',
    className: 'border-primary/25 bg-primary/10 text-primary',
  },
  'api-write-file-restore': {
    label: 'Restore',
    className: 'border-attention/30 bg-attention/10 text-attention',
  },
  'profile-memory-merge': {
    label: 'Memory merge',
    className: 'border-success/30 bg-success/10 text-success',
  },
  'prompt-save': {
    label: 'Prompt save',
    className: 'border-compacting/30 bg-compacting/10 text-compacting',
  },
  'prompt-delete': {
    label: 'Prompt delete',
    className: 'border-compacting/30 bg-compacting/10 text-compacting',
  },
  'reference-doc': {
    label: 'Reference doc',
    className: 'border-compacting/30 bg-compacting/10 text-compacting',
  },
  'reference-index': {
    label: 'Reference index',
    className: 'border-compacting/30 bg-compacting/10 text-compacting',
  },
  'legacy-knowledge-migration': {
    label: 'Migration',
    className: 'border-attention/30 bg-attention/10 text-attention',
  },
  bootstrap: {
    label: 'Bootstrap',
    className: 'border-muted-foreground/20 bg-muted/60 text-muted-foreground',
  },
  reconcile: {
    label: 'Reconcile',
    className: 'border-attention/30 bg-attention/10 text-attention',
  },
}

export function CommitMetadataBadges({ metadata, className }: CommitMetadataBadgesProps) {
  if (!metadata) {
    return null
  }

  const sourceLabel = resolveSourceLabel(metadata)

  return (
    <div className={cn('mt-1 flex flex-wrap gap-1', className)} aria-label="Commit metadata">
      {sourceLabel ? (
        <Badge
          variant="outline"
          className={cn(
            'h-5 border px-1.5 py-0 text-[10px] font-medium',
            resolveSourceClassName(metadata),
          )}
        >
          {sourceLabel}
        </Badge>
      ) : null}
      {metadata.profileId ? (
        <Badge
          variant="outline"
          className="h-5 border-primary/25 bg-primary/10 px-1.5 py-0 text-[10px] font-medium text-primary"
        >
          {`Profile ${metadata.profileId}`}
        </Badge>
      ) : null}
      {metadata.sessionId ? (
        <Badge
          variant="outline"
          className="h-5 border-border/60 bg-muted/40 px-1.5 py-0 text-[10px] font-medium text-muted-foreground"
        >
          {`Session ${metadata.sessionId}`}
        </Badge>
      ) : null}
    </div>
  )
}

function resolveSourceLabel(metadata: GitCommitMetadata): string | null {
  const sources = metadata.sources?.length ? metadata.sources : metadata.source ? [metadata.source] : []
  if (sources.length === 0) {
    return null
  }

  if (sources.length > 1) {
    return 'Mixed sources'
  }

  return SOURCE_STYLES[sources[0]]?.label ?? humanizeSource(sources[0])
}

function resolveSourceClassName(metadata: GitCommitMetadata): string {
  const sources = metadata.sources?.length ? metadata.sources : metadata.source ? [metadata.source] : []
  if (sources.length !== 1) {
    return 'border-border/60 bg-muted/40 text-muted-foreground'
  }

  return SOURCE_STYLES[sources[0]]?.className ?? 'border-border/60 bg-muted/40 text-muted-foreground'
}

function humanizeSource(source: string): string {
  return source
    .split('-')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}
