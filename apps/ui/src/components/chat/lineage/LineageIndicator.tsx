import { GitFork } from 'lucide-react'
import type { ContextHandoff, ContextTransfer, SessionLineageSnapshot } from '@forge/protocol/environment-v2'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  TRANSFER_KIND_LABELS,
  TRANSFER_STRATEGY_LABELS,
  describeBasePoint,
  summarizeLineage,
  transfersNewestFirst,
} from './lineage-presentation'

interface LineageIndicatorProps {
  lineage: SessionLineageSnapshot | null | undefined
  resolveSessionLabel?: (sessionId: string) => string | undefined
  onOpenSession?: (sessionId: string) => void
}

const MAX_TRANSFERS = 6

/** Compact session-header origin: forked from X at message Y, or switched from provider A. */
export function LineageIndicator({ lineage: snapshot, resolveSessionLabel, onOpenSession }: LineageIndicatorProps) {
  const summary = summarizeLineage(snapshot, resolveSessionLabel)
  if (!snapshot || !summary) return null
  const lineage = snapshot.lineage
  const parentLabel = lineage ? resolveSessionLabel?.(lineage.parentThreadId) ?? lineage.parentThreadId : ''
  const handoffs = new Map(snapshot.handoffs.map((handoff) => [handoff.transferId, handoff]))
  const transfers = transfersNewestFirst(snapshot)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Lineage: ${summary.label}`}
          title={summary.label}
          className={cn(
            'inline-flex h-5 min-w-0 max-w-56 shrink items-center gap-1 rounded-md border px-1.5 text-[10px] font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            summary.tone === 'warning'
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 hover:bg-amber-500/15 dark:text-amber-400'
              : 'border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground',
          )}
        >
          <GitFork className="size-3 shrink-0" aria-hidden="true" />
          <span className="hidden truncate md:inline">{summary.label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} collisionPadding={12} className="max-h-[min(70vh,28rem)] w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto p-3 text-xs [scrollbar-width:thin]">
        {lineage ? (
          <section className="space-y-1">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 font-medium text-foreground">
                {lineage.relationship === 'fork' ? `Forked from ${parentLabel}` : `Continued from a worker of ${parentLabel}`}
              </p>
              {onOpenSession ? (
                <button
                  type="button"
                  aria-label={`Open ${parentLabel}`}
                  onClick={() => onOpenSession(lineage.parentThreadId)}
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  Open
                </button>
              ) : null}
            </div>
            <p className="font-mono text-[11px] text-subtle-foreground">
              Base point: {describeBasePoint(lineage.basePoint)} · sequence {lineage.basePoint.sequence}
            </p>
          </section>
        ) : null}

        {transfers.length > 0 ? (
          <section className={cn('space-y-2', lineage && 'mt-3 border-t border-hairline pt-3')}>
            <h2 className="text-[11px] font-medium uppercase tracking-wide text-subtle-foreground">Context handoffs</h2>
            <ul className="space-y-2.5">
              {transfers.slice(0, MAX_TRANSFERS).map((transfer) => (
                <TransferRow key={transfer.transferId} transfer={transfer} handoff={handoffs.get(transfer.transferId)} />
              ))}
            </ul>
            {transfers.length > MAX_TRANSFERS ? (
              <p className="text-[11px] text-subtle-foreground">{transfers.length - MAX_TRANSFERS} earlier handoffs not shown.</p>
            ) : null}
          </section>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function TransferRow({ transfer, handoff }: { transfer: ContextTransfer; handoff: ContextHandoff | undefined }) {
  const kind = TRANSFER_KIND_LABELS[transfer.kind]
  const providers = transfer.sourceProvider || transfer.targetProvider
    ? `${transfer.sourceProvider ?? 'unknown'} → ${transfer.targetProvider ?? 'unknown'}`
    : null
  return (
    <li className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-medium text-foreground">
          {kind}
          {providers ? <span className="font-mono font-normal text-muted-foreground"> · {providers}</span> : null}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-subtle-foreground">{transfer.state.replace('_', ' ')}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">{TRANSFER_STRATEGY_LABELS[transfer.strategy]}</p>
      {transfer.error ? (
        <p role="alert" className="text-[11px] text-destructive">{transfer.error.code}: {transfer.error.message}</p>
      ) : null}
      {handoff ? (
        <>
          <dl aria-label={`Handoff coverage for ${kind}`} className="grid grid-cols-3 gap-1 rounded-lg bg-foreground/[0.04] px-2 py-1.5">
            <CoverageCell label="Included" value={`${handoff.coverage.includedEntryIds.length} of ${handoff.coverage.requestedEntryIds.length}`} />
            <CoverageCell label="Omitted" value={String(handoff.coverage.omittedEntryIds.length)} warn={handoff.coverage.omittedEntryIds.length > 0} />
            <CoverageCell label="Truncated" value={String(handoff.coverage.partialEntryIds.length)} warn={handoff.coverage.partialEntryIds.length > 0} />
          </dl>
          <p className="text-[11px] text-muted-foreground">
            {handoff.budget.usedChars.toLocaleString('en-US')} of {handoff.budget.maxChars.toLocaleString('en-US')} characters
            {handoff.budget.truncated ? ' · budget reached' : ''}
          </p>
          <p className="text-[11px] text-subtle-foreground">
            Rendered from <span className="font-mono">{handoff.provenance.source}</span> by{' '}
            <span className="font-mono">{handoff.provenance.renderer}</span> · Credentials {handoff.provenance.credentials} · Tool grants{' '}
            {handoff.provenance.toolGrants} · <span className="font-mono" title={handoff.sha256}>{handoff.sha256.slice(0, 12)}</span>
          </p>
        </>
      ) : null}
    </li>
  )
}

function CoverageCell({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-subtle-foreground">{label}</dt>
      <dd className={cn('font-mono text-[12px] tabular-nums', warn ? 'text-amber-600 dark:text-amber-400' : 'text-foreground')}>{value}</dd>
    </div>
  )
}
