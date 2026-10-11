import { getCatalogModel, getCatalogProvider } from '@forge/protocol'
import type { ContextTransfer, SessionLineageSnapshot } from '@forge/protocol/environment-v2'

export interface LineageSummary {
  label: string
  tone: 'neutral' | 'warning'
}

type ResolveSessionLabel = (sessionId: string) => string | undefined
type TransferModel = NonNullable<ContextTransfer['targetModel']>

/** Used to name a handoff's coverage for assistive technology. */
export const TRANSFER_KIND_LABELS: Record<ContextTransfer['kind'], string> = {
  fork: 'Fork',
  provider_switch: 'Provider switch',
  merge_back: 'Merge back',
  worker_input: 'Worker input',
  worker_result: 'Worker result',
}

/** How the earlier conversation reached the new one. Nothing is said while that is still undecided. */
const TRANSFER_STRATEGY_LABELS: Record<ContextTransfer['strategy'], string | null> = {
  unresolved: null,
  native_fork: 'Full history kept',
  portable_context: 'Earlier conversation carried over',
  delta_context: 'Recent messages carried over',
  canonical_input: null,
}

const TRANSFER_STATE_LABELS: Record<ContextTransfer['state'], string> = {
  pending: 'Applies on your next message',
  resolving: 'Preparing',
  resolved: 'Ready',
  dispatch_marked: 'Sending',
  consumed: 'Done',
  unknown: 'Not confirmed',
  failed: 'Failed',
  superseded: 'Replaced',
}

/** The runtime behind a provider or model-provider ID: `codex-native` and `codex` are the same one. */
const PROVIDER_FAMILIES: Record<string, string> = {
  codex: 'Codex', 'codex-native': 'Codex', 'openai-codex': 'Codex',
  claude: 'Claude', 'claude-native': 'Claude', anthropic: 'Claude',
  'cursor-sdk': 'Cursor', cursor: 'Cursor',
}

export function providerName(provider: string | undefined): string | null {
  if (!provider) return null
  return PROVIDER_FAMILIES[provider] ?? getCatalogProvider(provider)?.displayName ?? provider
}

export function modelName(model: TransferModel | undefined): string | null {
  if (!model) return null
  return getCatalogModel(model.modelId, model.provider)?.displayName ?? model.modelId
}

export function transferStateLabel(transfer: ContextTransfer): string {
  return TRANSFER_STATE_LABELS[transfer.state]
}

export function transferStrategyLabel(transfer: ContextTransfer): string | null {
  return TRANSFER_STRATEGY_LABELS[transfer.strategy]
}

/**
 * What a provider transfer meant to the user. A changed sign-in or setting restarts the provider on
 * the same model, which is not a switch; a different model on the same provider is a model change.
 */
export function providerChange(transfer: ContextTransfer): 'refresh' | 'model' | 'provider' | null {
  if (transfer.kind !== 'provider_switch') return null
  const { sourceModel, targetModel } = transfer
  const from = providerName(sourceModel?.provider ?? transfer.sourceProvider)
  const to = providerName(targetModel?.provider ?? transfer.targetProvider)
  if (from && to && from !== to) return 'provider'
  // Without both models (an older environment) a same-provider transfer is assumed to be a model change.
  return sourceModel && targetModel && sourceModel.modelId === targetModel.modelId ? 'refresh' : 'model'
}

/** Transfers worth showing, newest first; the environment does not promise an order. */
export function transfersNewestFirst(snapshot: SessionLineageSnapshot): ContextTransfer[] {
  return snapshot.transfers.filter((transfer) => providerChange(transfer) !== 'refresh').sort((a, b) => b.createdAt - a.createdAt)
}

/** "Claude Opus → GPT-6 Sol", or the providers when the models were not recorded. */
export function describeModelChange(transfer: ContextTransfer): string | null {
  const from = modelName(transfer.sourceModel) ?? providerName(transfer.sourceProvider)
  const to = modelName(transfer.targetModel) ?? providerName(transfer.targetProvider)
  if (!from && !to) return null
  return from && to && from !== to ? `${from} → ${to}` : to ?? from
}

export function transferTitle(transfer: ContextTransfer, resolveSessionLabel?: ResolveSessionLabel): string {
  switch (transfer.kind) {
    case 'fork': {
      const source = resolveSessionLabel?.(transfer.source.threadId)
      return source ? `Started from ${source}` : 'Started from another conversation'
    }
    case 'provider_switch': {
      const target = modelName(transfer.targetModel) ?? providerName(transfer.targetProvider)
      const verb = providerChange(transfer) === 'provider' ? 'Switched to' : 'Model changed to'
      return target ? `${verb} ${target}` : 'Model changed'
    }
    case 'merge_back': return 'Merged back'
    case 'worker_input': return 'Work handed to a worker'
    case 'worker_result': return 'Worker result received'
  }
}

/** Where a fork or continuation began, in words; the entry ID stays out of sight. */
export function describeBasePoint(point: { sequence: number }): string {
  return `message ${point.sequence}`
}

/** One line for the session header: where this conversation came from, then a switch from another provider. */
export function summarizeLineage(
  snapshot: SessionLineageSnapshot | null | undefined,
  resolveSessionLabel?: ResolveSessionLabel,
): LineageSummary | null {
  if (!snapshot) return null
  const lineage = snapshot.lineage
  // A model or sign-in change on the same provider leaves the conversation where it was; only a move between providers is worth the header.
  const switched = transfersNewestFirst(snapshot).find((transfer) => providerChange(transfer) === 'provider' && transfer.state !== 'superseded')
  if (!lineage && !switched) return null
  const parent = lineage ? resolveSessionLabel?.(lineage.parentThreadId) : undefined
  const origin = !lineage
    ? null
    : lineage.relationship === 'fork'
      ? `Forked from ${parent ?? 'another conversation'}`
      : `Continued from ${parent ?? 'a worker'}`
  const from = switched ? providerName(switched.sourceModel?.provider ?? switched.sourceProvider) ?? 'another provider' : null
  const failed = switched?.state === 'failed'
  const provider = !switched ? null : failed ? `switch from ${from} failed` : `switched from ${from}`
  const label = [origin, provider].filter((part): part is string => Boolean(part)).join(' · ')
  return { label: label.charAt(0).toUpperCase() + label.slice(1), tone: failed ? 'warning' : 'neutral' }
}

/** A provider's typed refusal of the latest merge-back; later success or another failure clears it. */
export function mergeBackUnsupportedReason(snapshot: SessionLineageSnapshot | null | undefined): string | null {
  const latest = snapshot && [...snapshot.transfers].sort((a, b) => b.createdAt - a.createdAt).find((transfer) => transfer.kind === 'merge_back')
  return latest?.state === 'failed' && latest.error?.code === 'UNSUPPORTED' ? latest.error.message : null
}
