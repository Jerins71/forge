import { GitFork } from 'lucide-react'
import type { ContextHandoff, ContextTransfer, SessionLineageSnapshot } from '@forge/protocol/environment-v2'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  TRANSFER_KIND_LABELS,
  describeBasePoint,
  describeModelChange,
  summarizeLineage,
  transferStateLabel,
  transferStrategyLabel,
  transferTitle,
  transfersNewestFirst,
} from './lineage-presentation'

interface LineageIndicatorProps {
  lineage: SessionLineageSnapshot | null | undefined
  resolveSessionLabel?: (sessionId: string) => string | undefined
  onOpenSession?: (sessionId: string) => void
}

const MAX_TRANSFERS = 6

/** Compact session-header origin: forked from X, or switched from provider A. IDs stay in tooltips. */
export function LineageIndicator({ lineage: snapshot, resolveSessionLabel, onOpenSession }: LineageIndicatorProps) {
  const summary = summarizeLineage(snapshot, resolveSessionLabel)
  if (!snapshot || !summary) return null
  const lineage = snapshot.lineage
  const parentLabel = lineage ? resolveSessionLabel?.(lineage.parentThreadId) ?? (lineage.relationship === 'fork' ? 'another conversation' : 'a worker') : ''
  const handoffs = new Map(snapshot.handoffs.map((handoff) => [handoff.transferId, handoff]))
  const transfers = transfersNewestFirst(snapshot)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Lineage: ${summary.label}`}
          title={summary.label}
          data-base-entry={lineage?.basePoint.entryId}
          className={cn(
            // Icon-only with a comfortable tap target on narrow screens; the label joins it from md up.
            'inline-flex h-7 min-w-0 max-w-56 shrink-0 items-center gap-1 rounded-md border px-2 text-[10px] font-medium transition-colors md:h-5 md:shrink md:px-1.5 lg:max-w-80',
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
        {snapshot.truncated ? (
          <p role="status" className="mb-2 text-[11px] text-subtle-foreground">Showing recent history</p>
        ) : null}
        {lineage ? (
          <section className="space-y-1">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 font-medium text-foreground">
                {lineage.relationship === 'fork' ? `Forked from ${parentLabel}` : `Continued from ${parentLabel}`}
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
            <p className="text-[11px] text-subtle-foreground" title={lineage.basePoint.entryId}>
              Includes that conversation up to {describeBasePoint(lineage.basePoint)}
            </p>
          </section>
        ) : null}

        {transfers.length > 0 ? (
          <section className={cn('space-y-2', lineage && 'mt-3 border-t border-hairline pt-3')}>
            <h2 className="text-[11px] font-medium uppercase tracking-wide text-subtle-foreground">Context handoffs</h2>
            <ul className="space-y-2.5">
              {transfers.slice(0, MAX_TRANSFERS).map((transfer) => (
                <TransferRow key={transfer.transferId} transfer={transfer} handoff={handoffs.get(transfer.transferId)} resolveSessionLabel={resolveSessionLabel} />
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

function TransferRow({ transfer, handoff, resolveSessionLabel }: {
  transfer: ContextTransfer
  handoff: ContextHandoff | undefined
  resolveSessionLabel?: (sessionId: string) => string | undefined
}) {
  const kind = TRANSFER_KIND_LABELS[transfer.kind]
  // Inherited context is reported per original thread; a handoff from one thread has only the flat totals.
  const sources = handoff?.coverage.sources?.length ? handoff.coverage.sources : null
  const detail = [transfer.kind === 'provider_switch' ? describeModelChange(transfer) : null, transferStrategyLabel(transfer)]
    .filter((part): part is string => Boolean(part))
  return (
    <li className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-medium text-foreground">{transferTitle(transfer, resolveSessionLabel)}</span>
        <span className="shrink-0 text-[11px] text-subtle-foreground">{transferStateLabel(transfer)}</span>
      </div>
      {detail.length ? <p className="text-[11px] text-muted-foreground">{detail.join(' · ')}</p> : null}
      {transfer.error ? (
        <p role="alert" className="text-[11px] text-destructive" title={transfer.error.code}>{transfer.error.message}</p>
      ) : null}
      {handoff ? (
        <>
          {sources ? sources.map((source) => {
            const sourceLabel = resolveSessionLabel?.(source.sourcePoint.threadId) ?? 'Another conversation'
            return (
              <div key={`${source.sourcePoint.threadId}:${source.sourcePoint.sequence}`} className="space-y-1">
                <p className="truncate text-[11px] text-muted-foreground" title={source.sourcePoint.entryId}>
                  {sourceLabel} · up to {describeBasePoint(source.sourcePoint)}
                </p>
                <CoverageCells label={`Handoff coverage for ${kind} from ${sourceLabel}`} coverage={source} />
              </div>
            )
          }) : <CoverageCells label={`Handoff coverage for ${kind}`} coverage={handoff.coverage} />}
          <p className="text-[11px] text-muted-foreground">
            {handoff.budget.usedChars.toLocaleString('en-US')} of {handoff.budget.maxChars.toLocaleString('en-US')} characters
            {handoff.budget.truncated ? ' · budget reached' : ''}
          </p>
          <p className="text-[11px] text-subtle-foreground" title={`${handoff.provenance.renderer} · ${handoff.sha256.slice(0, 12)}`}>
            Credentials {handoff.provenance.credentials} · Tool grants {handoff.provenance.toolGrants}
          </p>
        </>
      ) : null}
    </li>
  )
}

function CoverageCells({ label, coverage }: {
  label: string
  coverage: Pick<ContextHandoff['coverage'], 'requestedEntryIds' | 'includedEntryIds' | 'omittedEntryIds' | 'partialEntryIds'>
}) {
  return (
    <dl aria-label={label} className="grid grid-cols-3 gap-1 rounded-lg bg-foreground/[0.04] px-2 py-1.5">
      <CoverageCell label="Included" value={`${coverage.includedEntryIds.length} of ${coverage.requestedEntryIds.length}`} />
      <CoverageCell label="Omitted" value={String(coverage.omittedEntryIds.length)} warn={coverage.omittedEntryIds.length > 0} />
      <CoverageCell label="Truncated" value={String(coverage.partialEntryIds.length)} warn={coverage.partialEntryIds.length > 0} />
    </dl>
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
