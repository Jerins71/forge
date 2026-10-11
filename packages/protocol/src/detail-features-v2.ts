/** Bounded typed presentation. No secret values, tool arguments or provider locators. */
import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { TimelineActivitySchema } from './activity-timeline.js'
const O = <P extends Record<string, TSchema>>(p: P) => Type.Object(p, { additionalProperties: false })
const E = <T extends string>(...v: T[]) => Type.Union(v.map(x => Type.Literal(x)))
const id = Type.String({ minLength: 1, maxLength: 256 })
const text = Type.String({ maxLength: 32768 })
const short = Type.String({ maxLength: 512 })
const time = Type.String({ maxLength: 32 })
const n = Type.Number({ minimum: 0 })
const nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()])
const ids = Type.Array(id, { maxItems: 1000 })
const model = O({ provider: short, modelId: short, thinkingLevel: short })
const attempt = O({ id, number: n, status: E('dispatching','running','succeeded','blocked','cancelled'), startedAt: time,
  completedAt: Type.Optional(time), workerId: Type.Optional(id), behaviorMode: E('general','plan','correctness-review','design-review','research'), requestedRoute: Type.Optional(short),
  resolvedRouteId: Type.Optional(id), resolvedRouteLabel: Type.Optional(short), rosterId: Type.Optional(id), rosterRevision: Type.Optional(n),
  model: Type.Optional(model), capabilityEscalationRouteId: Type.Optional(id), executionPolicy: Type.Optional(E('support','routine','deep')), summary: Type.Optional(text) })
export const PlanSnapshotV2Schema = O({ revision: n, updatedAt: nullable(time), explanation: Type.Optional(text),
  plan: Type.Array(O({ id: Type.Optional(id), step: text, status: E('pending','in_progress','completed') }), { maxItems: 256 }),
  coordinationMode: Type.Optional(E('plan','graph')), workGraph: Type.Optional(O({ maxConcurrency: n,
    nodes: Type.Array(O({ id, title: text, task: text, kind: E('task','plan','research','implementation','review','design-review','synthesis','decision'),
      status: E('pending','running','awaiting_review','waiting','blocked','completed','cancelled'), statusUpdatedAt: Type.Optional(time),
      dependsOn: ids, acceptanceCriteria: Type.Optional(text), route: Type.Optional(short), effort: Type.Optional(E('auto','support','routine','deep')),
      attempts: Type.Array(attempt, { maxItems: 256 }) }), { maxItems: 256 }) })) })
export const GoalSnapshotV2Schema = O({ revision: n, measuredAt: time, goal: nullable(O({ id, objective: text,
  status: E('active','paused','blocked','completed','cancelled'), createdAt: time, updatedAt: time, endedAt: Type.Optional(time),
  tokenBudget: Type.Optional(n), pauseReason: Type.Optional(E('user','token_budget_exhausted')), activeElapsedMs: n, turnCount: n,
  usage: O({ input: n, output: n, cacheRead: n, cacheWrite: n, total: n }), usageCoverage: E('complete','partial'), remainingTokens: Type.Optional(n) })) })
export const GoalControlV2Schema = Type.Union([O({ action: E('pause','resume','cancel') }),
  O({ action: Type.Literal('edit'), objective: Type.String({ minLength: 1, maxLength: 1000 }), tokenBudget: Type.Optional(nullable(Type.Integer({ minimum: 1, maximum: 100000000 }))) })])
export const ToolActivityV2Schema = O({ sessionAgentId: id, revision: n, toolCount: n, backgroundCount: Type.Optional(n),
  scheduledWakeupCount: Type.Optional(n), currentToolName: Type.Optional(short) })
const quality = O({ measurementScope: Type.Literal('agent_model_call'), agentRetryAttempt: nullable(n),
  providerAttemptScope: E('openai_codex_websocket_request','unavailable'), observedProviderAttemptCount: nullable(n),
  tokenSource: E('provider_final','estimated_local','unavailable'), boundarySource: E('content_delta_to_stream_end','response_stream_proxy','unavailable'),
  reasoningBoundaryCoverage: E('observed','hidden_or_unobserved','not_reported') })
const rate = nullable(n)
const basis = Type.Optional(Type.Literal('request_wall_monotonic'))
export const ThroughputMeasurementV2Schema = O({ measurementId: id, sequence: n, phase: E('starting','generating','completed','aborted'),
  profileId: id, sessionId: id, agentId: id, managerId: id, role: E('manager','worker'), provider: short, modelId: short, sampledAt: time,
  requestStartedAt: Type.Optional(time), completedAt: Type.Optional(nullable(time)), firstOutputAt: nullable(time), lastOutputAt: Type.Optional(nullable(time)),
  timeToFirstOutputMs: Type.Optional(rate), responseDurationMs: Type.Optional(rate), responseThroughputDurationBasis: basis,
  outputSpanMs: Type.Optional(rate), generationTailDurationMs: Type.Optional(rate), elapsedGenerationMs: rate, outputTokens: rate,
  instantaneousTokensPerSecond: rate, responseThroughputTokensPerSecond: Type.Optional(rate), generationAverageTokensPerSecond: rate,
  valueKind: E('estimated','provider_final','unavailable'), quality })
export const ThroughputSummaryV2Schema = O({ sessionAgentId: id, window: Type.Literal('last_20_terminal_generations'), measuredGenerationCount: n,
  weightedResponseTokensPerSecond: Type.Optional(rate), weightedTokensPerSecond: rate,
  samples: Type.Array(O({ completedAt: time, role: E('manager','worker'), responseTokensPerSecond: Type.Optional(n), tokensPerSecond: n }), { maxItems: 20 }) })
const binding = Type.Union([O({ deliveryKind: E('stdin','ssh_agent') }), O({ deliveryKind: E('environment','askpass'), targetName: short }),
  O({ deliveryKind: Type.Literal('file'), targetPath: Type.String({ maxLength: 4096 }), fileMode: Type.Optional(n) })])
const bindings = Type.Array(binding, { maxItems: 16 })
const leaseKind = E('task','timed','one_use')
const attribution = { requestedByAgentId: id, requestedByDisplayName: short, createdAt: time, expiresAt: nullable(time) }
const host = { alias: short, hostName: short, port: n, username: short, hostKeyAlgorithm: short, hostKeyFingerprint: short }
export const SecureSessionV2Schema = O({ sessionAgentId: id, profileId: id, principalKind: E('manager','worker'), ownerManagerAgentId: nullable(id),
  workerAssignmentId: nullable(id), revision: n, executionMode: E('standard','secure'), environmentStatus: E('stopped','starting','ready','degraded','failed'),
  accessPolicy: Type.Optional(O({ paused: Type.Boolean(), blockedAgentIds: ids, blockedSecretIds: ids })), outputState: Type.Optional(E('clear','quarantined')),
  outputStateCode: Type.Optional(nullable(Type.Literal('SECURE_OUTPUT_QUARANTINED'))),
  leases: Type.Array(O({ leaseId: id, secretId: id, displayAlias: short, username: Type.Optional(nullable(short)), leaseKind, exposures: bindings,
    status: E('active','consumed','revoked','expired'), expiresAt: nullable(time), lastUsedAt: nullable(time), remainingUses: nullable(n),
    grantSource: Type.Optional(E('manual','access_request','project_default')) }), { maxItems: 256 }),
  pendingRequests: Type.Array(O({ requestId: id, secretId: nullable(id), displayAlias: short, username: Type.Optional(nullable(short)), requestedLeaseKind: leaseKind,
    requestedDurationSeconds: Type.Optional(n), requestedExposures: bindings, purposeSummary: Type.String({ maxLength: 2000 }), ...attribution, workerAssignmentId: nullable(id) }), { maxItems: 256 }),
  trustedSshHosts: Type.Optional(Type.Array(O({ trustedHostId: id, profileId: id, ...host, createdAt: time, updatedAt: time }), { maxItems: 256 })),
  pendingSshTrustRequests: Type.Optional(Type.Array(O({ requestId: id, ...host, purposeSummary: Type.String({ maxLength: 2000 }), ...attribution }), { maxItems: 256 })),
  projectDefaults: Type.Optional(Type.Array(O({ secretId: id, displayAlias: short, state: E('configured','active','unavailable','conflict','blocked'),
    statusCode: E('ok','source_unavailable','binding_conflict','access_blocked') }), { maxItems: 256 })),
  lastExecutionIncident: Type.Optional(O({ code: E('EXECUTION_ABORTED','EXECUTION_TIMEOUT'), agentId: id, occurredAt: time })), updatedAt: time })
export const TerminalV2Schema = O({ terminalId: id, sessionAgentId: id, profileId: id, name: short, shell: Type.String({ maxLength: 4096 }),
  cwd: Type.String({ maxLength: 4096 }), cols: n, rows: n, state: E('running','exited','restoring','restore_failed'), pid: nullable(n),
  exitCode: nullable(Type.Number()), exitSignal: nullable(n), recoveredFromPersistence: Type.Boolean(), createdAt: time, updatedAt: time })
export const ElicitationV2Schema = O({ elicitationId: id, agentId: id, sidecarAgentId: id,
  /** Random pending occurrence identity is the continuation generation fence. */
  generation: id, mode: E('form','url'), title: Type.Optional(short), message: Type.String({ maxLength: 4000 }),
  fields: Type.Optional(Type.Array(O({ key: id, label: short, type: E('string','boolean','number','enum'), required: Type.Boolean(),
    options: Type.Optional(Type.Array(short, { maxItems: 100 })), sensitive: Type.Optional(Type.Boolean()) }), { maxItems: 100 })),
  urlOrigin: Type.Optional(short), persistScopes: Type.Array(E('session','always'), { maxItems: 2 }) })
export const ElicitationRespondV2Schema = O({ sessionId: id, elicitationId: id, generation: id, decision: E('allow','deny','cancel'),
  values: Type.Optional(Type.Record(Type.String({ maxLength: 256 }), Type.Union([Type.String({ maxLength: 32768 }), Type.Number(), Type.Boolean()]), { maxProperties: 100 })),
  persistScope: Type.Optional(E('session','always')) })
export const DetailFeatureEventSchema = Type.Union([
  O({ type: Type.Literal('tool.activity'), activity: ToolActivityV2Schema }),
  O({ type: Type.Literal('activity.upsert'), item: TimelineActivitySchema }),
  O({ type: Type.Literal('throughput.upsert'), measurement: ThroughputMeasurementV2Schema, summary: Type.Optional(ThroughputSummaryV2Schema) }),
  O({ type: Type.Literal('throughput.snapshot'), measurements: Type.Array(ThroughputMeasurementV2Schema, { maxItems: 100 }), summary: ThroughputSummaryV2Schema }),
  O({ type: Type.Literal('secure.upsert'), snapshot: SecureSessionV2Schema }), O({ type: Type.Literal('secure.catalog.changed'), revision: n }),
  O({ type: Type.Literal('elicitation.request'), request: ElicitationV2Schema }), O({ type: Type.Literal('elicitation.dismissed'), elicitationId: id, agentId: id }),
  O({ type: Type.Literal('terminals.snapshot'), scopeId: id, terminals: Type.Array(TerminalV2Schema, { maxItems: 20 }) }),
  O({ type: Type.Literal('terminal.upsert'), scopeId: id, terminal: TerminalV2Schema }),
  O({ type: Type.Literal('terminal.closed'), scopeId: id, terminalId: id, reason: E('user_closed','session_deleted','manager_deleted','shutdown','orphan_cleanup') }),
])
export const DetailFeatureStreamItemSchema = O({ event: DetailFeatureEventSchema })
export type DetailFeatureEvent = Static<typeof DetailFeatureEventSchema>
export type DetailFeatureStreamItem = Static<typeof DetailFeatureStreamItemSchema>
