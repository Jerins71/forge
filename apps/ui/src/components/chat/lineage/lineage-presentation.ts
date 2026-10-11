import type { ContextTransfer, SessionLineageSnapshot } from '@forge/protocol/environment-v2'

export interface LineageSummary {
  label: string
  tone: 'neutral' | 'warning'
}

export const TRANSFER_KIND_LABELS: Record<ContextTransfer['kind'], string> = {
  fork: 'Fork',
  provider_switch: 'Provider switch',
  merge_back: 'Merge back',
  worker_input: 'Worker input',
  worker_result: 'Worker result',
}

export const TRANSFER_STRATEGY_LABELS: Record<ContextTransfer['strategy'], string> = {
  unresolved: 'Unresolved',
  native_fork: 'Native fork',
  portable_context: 'Portable context',
  delta_context: 'Delta context',
  canonical_input: 'Canonical input',
}

/** Newest first; the environment does not promise an order. */
export function transfersNewestFirst(snapshot: SessionLineageSnapshot): ContextTransfer[] {
  return [...snapshot.transfers].sort((a, b) => b.createdAt - a.createdAt)
}

export function describeBasePoint(point: { sequence: number; entryId?: string }): string {
  return `message ${point.entryId ?? `#${point.sequence}`}`
}

/** One line for the session header: where this conversation came from, then its latest provider switch. */
export function summarizeLineage(
  snapshot: SessionLineageSnapshot | null | undefined,
  resolveSessionLabel?: (sessionId: string) => string | undefined,
): LineageSummary | null {
  if (!snapshot) return null
  const lineage = snapshot.lineage
  const switched = transfersNewestFirst(snapshot).find((transfer) => transfer.kind === 'provider_switch' && transfer.state !== 'superseded')
  if (!lineage && !switched) return null
  const parent = lineage ? resolveSessionLabel?.(lineage.parentThreadId) ?? lineage.parentThreadId : ''
  const origin = !lineage
    ? null
    : lineage.relationship === 'fork'
      ? `Forked from ${parent} at ${describeBasePoint(lineage.basePoint)}`
      : `Continued from a worker of ${parent}`
  const from = switched?.sourceProvider ?? 'another provider'
  const failed = switched?.state === 'failed'
  const provider = !switched ? null : failed ? `switch from ${from} failed` : `switched from ${from}`
  const label = [origin, provider].filter((part): part is string => Boolean(part)).join(' · ')
  return { label: label.charAt(0).toUpperCase() + label.slice(1), tone: failed ? 'warning' : 'neutral' }
}

/** A provider's typed refusal of the latest merge-back; later success or another failure clears it. */
export function mergeBackUnsupportedReason(snapshot: SessionLineageSnapshot | null | undefined): string | null {
  const latest = snapshot && transfersNewestFirst(snapshot).find((transfer) => transfer.kind === 'merge_back')
  return latest?.state === 'failed' && latest.error?.code === 'UNSUPPORTED' ? `UNSUPPORTED: ${latest.error.message}` : null
}
