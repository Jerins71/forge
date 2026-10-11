import { Type, type Static, type TSchema } from '@sinclair/typebox'

const O = <P extends Record<string, TSchema>>(p: P) => Type.Object(p, { additionalProperties: false })
const E = <T extends string>(...values: T[]) => Type.Union(values.map(value => Type.Literal(value)))
const id = Type.String({ minLength: 1, maxLength: 256 })
const ordinal = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const ids = Type.Array(id, { maxItems: 10000, uniqueItems: true })

/** Requests resolve to a frozen canonical point before creating the transfer. */
export const ContextSourceSelectorSchema = Type.Union([
  O({ kind: Type.Literal('latest_stable') }),
  O({ kind: Type.Literal('run'), runId: id }),
  O({ kind: Type.Literal('message'), entryId: id }),
])
export type ContextSourceSelector = Static<typeof ContextSourceSelectorSchema>
export const ContextSourcePointSchema = O({ threadId: id, sequence: ordinal, runId: Type.Optional(id), entryId: Type.Optional(id) })
export type ContextSourcePoint = Static<typeof ContextSourcePointSchema>
export const ThreadLineageSchema = O({ parentThreadId: id, rootThreadId: id, relationship: E('fork', 'continued_worker'), transferId: id, basePoint: ContextSourcePointSchema })
export type ThreadLineage = Static<typeof ThreadLineageSchema>
export const ContextCoverageSchema = O({ sourceThreadId: id, requestedEntryIds: ids, includedEntryIds: ids, omittedEntryIds: ids, partialEntryIds: ids })
export type ContextCoverage = Static<typeof ContextCoverageSchema>
/** Metadata only. Payloads are private immutable files, never credentials or grants. */
export const ContextHandoffSchema = O({
  handoffId: id, transferId: id, artifactRef: id, sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }), createdAt: ordinal,
  provenance: O({ source: Type.Literal('canonical_jsonl'), renderer: Type.Literal('forge-portable-v1'), credentials: Type.Literal('excluded'), toolGrants: Type.Literal('excluded') }),
  coverage: ContextCoverageSchema,
  budget: O({ maxChars: ordinal, usedChars: ordinal, truncated: Type.Boolean() }),
})
export type ContextHandoff = Static<typeof ContextHandoffSchema>
export const ContextTransferSchema = O({
  transferId: id, kind: E('fork', 'provider_switch', 'merge_back', 'worker_input', 'worker_result'),
  source: ContextSourcePointSchema, basePoint: Type.Optional(ContextSourcePointSchema), targetThreadId: id,
  targetRunId: Type.Optional(id), sourceProvider: Type.Optional(id), targetProvider: Type.Optional(id),
  strategy: E('unresolved', 'native_fork', 'portable_context', 'delta_context', 'canonical_input'),
  state: E('pending', 'resolving', 'resolved', 'dispatch_marked', 'consumed', 'unknown', 'failed', 'superseded'),
  createdAt: ordinal, consumingAttemptId: Type.Optional(id), consumedAt: Type.Optional(ordinal), handoffId: Type.Optional(id),
  error: Type.Optional(O({ code: E('UNSUPPORTED', 'SOURCE_UNAVAILABLE', 'MATERIALIZATION_FAILED', 'DELIVERY_UNKNOWN', 'STALE_TARGET'), message: Type.String({ maxLength: 4096 }) })),
})
export type ContextTransfer = Static<typeof ContextTransferSchema>
export const SessionLineageSnapshotSchema = O({ threadId: id, lineage: Type.Union([ThreadLineageSchema, Type.Null()]), transfers: Type.Array(ContextTransferSchema, { maxItems: 1000 }), handoffs: Type.Array(ContextHandoffSchema, { maxItems: 1000 }) })
export type SessionLineageSnapshot = Static<typeof SessionLineageSnapshotSchema>
