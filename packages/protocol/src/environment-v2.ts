/**
 * Forge V2 environment protocol: environment identity, scopes, shell/detail
 * streams, durable command receipts, pairing, and the schema-first RPC
 * registry. Authoritative contract for Phase 1; see the Phase 1
 * implementation spec. Every RPC method declares exactly one scope.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { SESSION_ATTENTION_REASONS } from './session-attention.js'

export const ENVIRONMENT_PROTOCOL_VERSION = 1 as const
export const ENVIRONMENT_PROTOCOL_HEADER = 'x-forge-environment-protocol'
export const ENVIRONMENT_RPC_PATH = '/api/v2/rpc'
export const ENVIRONMENT_WS_PROTOCOL = 'forge.v2'
export const V2_LIMITS = {
  frameBytes: 1_048_576,
  replayEvents: 128,
  replayBytes: 1_048_576,
  socketQueueBytes: 2_097_152,
  socketQueueFrames: 256,
  shellPageSessions: 500,
  shellPageProjects: 100,
  detailRecentTurns: 20,
  detailCacheIdleMs: 300_000,
  heartbeatMs: 30_000,
} as const

const O = <P extends Record<string, TSchema>>(p: P) =>
  Type.Object(p, { additionalProperties: false })
const E = <T extends string>(...values: T[]) =>
  Type.Union(values.map(value => Type.Literal(value)))
export const V2Id = Type.String({ minLength: 1, maxLength: 128 })
export const V2Uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' })
export const V2Sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
export const V2Time = Type.String({ maxLength: 32, pattern: '^\\d{4}-\\d{2}-\\d{2}T.*Z$' })
export const V2Empty = O({})
const ShortText = Type.String({ maxLength: 256 })
const NullableId = Type.Union([V2Id, Type.Null()])
export const ScopeSchema = E(
  'session:read', 'session:operate', 'workspace:read', 'workspace:write',
  'terminal:operate', 'settings:admin', 'access:admin',
)
export type Scope = Static<typeof ScopeSchema>
export const ScopesSchema = Type.Array(ScopeSchema, { uniqueItems: true, minItems: 1, maxItems: 7 })

export const EnvironmentCapabilitiesSchema = O({
  shellResume: Type.Boolean(),
  sessionDetail: Type.Boolean(),
  durableCommands: Type.Boolean(),
  newWorktree: Type.Boolean(),
  artifactUpload: Type.Boolean(),
  terminal: Type.Boolean(),
  legacyAdapter: Type.Boolean(),
})
export type EnvironmentCapabilities = Static<typeof EnvironmentCapabilitiesSchema>
export const EnvironmentDescriptorSchema = O({
  environmentId: V2Uuid,
  label: Type.String({ minLength: 1, maxLength: 80 }),
  platform: O({ os: E('darwin', 'linux', 'win32', 'unknown'), arch: ShortText }),
  forgeVersion: ShortText,
  protocolVersion: Type.Integer({ minimum: 1 }),
  streamEpoch: V2Uuid,
  capabilities: EnvironmentCapabilitiesSchema,
})
export type EnvironmentDescriptor = Static<typeof EnvironmentDescriptorSchema>
export const EnvironmentRefSchema = O({ environmentId: V2Uuid })
export const ProjectRefSchema = O({ environmentId: V2Uuid, projectId: V2Id })
export const SessionRefSchema = O({ environmentId: V2Uuid, sessionId: V2Id })
export type ProjectRef = Static<typeof ProjectRefSchema>
export type SessionRef = Static<typeof SessionRefSchema>

export const RepositoryIdentitySchema = O({
  // A grouping hint, never an access grant or a claim of matching content.
  canonicalRemote: Type.String({ minLength: 1, maxLength: 512 }),
  subpath: Type.String({ maxLength: 256 }), // slash-separated, '' at repository root
  key: Type.String({ minLength: 1, maxLength: 128 }), // sha256(remote + '\n' + subpath)
})
export type RepositoryIdentity = Static<typeof RepositoryIdentitySchema>
export const ProjectSummarySchema = O({
  projectId: V2Id,
  title: ShortText,
  cwd: Type.String({ minLength: 1, maxLength: 4096 }),
  repository: Type.Union([RepositoryIdentitySchema, Type.Null()]),
  isGit: Type.Boolean(),
  defaultBranch: Type.Union([ShortText, Type.Null()]),
  updatedAt: V2Time,
  sortKey: ShortText,
  archived: Type.Boolean(),
  // Model new threads start on unless the launch names one.
  defaultModel: Type.Optional(O({ provider: ShortText, modelId: ShortText, thinkingLevel: ShortText })),
})
export type ProjectSummary = Static<typeof ProjectSummarySchema>
export const WorkspaceStrategySchema = Type.Union([
  O({ kind: Type.Literal('current_checkout') }),
  O({ kind: Type.Literal('new_worktree'), baseRef: Type.String({ minLength: 1, maxLength: 256 }),
      branch: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) }),
])
export type WorkspaceStrategy = Static<typeof WorkspaceStrategySchema>
export const SessionSummarySchema = O({
  sessionId: V2Id, projectId: V2Id, title: ShortText,
  status: E('preparing', 'idle', 'running', 'waiting', 'stopping', 'stopped', 'error', 'interrupted'),
  attention: E('none', 'choice', 'approval', 'error', 'result'),
  unread: Type.Integer({ minimum: 0 }),
  workerCount: Type.Integer({ minimum: 0 }),
  updatedAt: V2Time, sortKey: ShortText, archived: Type.Boolean(),
  workspace: O({ kind: E('current_checkout', 'new_worktree'),
    cwd: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
    branch: Type.Union([ShortText, Type.Null()]) }),
  // Optional so shells cached by older clients still decode; producers always send it.
  model: Type.Optional(O({ provider: ShortText, modelId: ShortText, thinkingLevel: ShortText,
    origin: E('profile_default', 'session_override') })),
  // The server attention occurrence behind `attention: 'result'`; Inbox › Needs You lists and dismisses it.
  attentionOccurrence: Type.Optional(O({ attentionId: Type.String({ minLength: 1, maxLength: 256 }),
    reason: E(...SESSION_ATTENTION_REASONS), raisedAt: V2Time })),
})
export type SessionSummary = Static<typeof SessionSummarySchema>

export const ArtifactRefSchema = O({
  artifactId: V2Uuid, fileName: ShortText, mimeType: ShortText,
  sizeBytes: Type.Integer({ minimum: 0, maximum: 26_214_400 }),
})
export type ArtifactRef = Static<typeof ArtifactRefSchema>
export const MessageInputSchema = O({
  text: Type.String({ maxLength: 131_072 }),
  artifactIds: Type.Array(V2Uuid, { maxItems: 20, uniqueItems: true }),
})
export const LaunchSessionSchema = O({
  commandId: V2Uuid,
  projectId: V2Id,
  title: Type.String({ minLength: 1, maxLength: 256 }),
  workspaceStrategy: WorkspaceStrategySchema,
  // Omission freezes the environment project's default in the acceptance transaction.
  model: Type.Optional(O({ provider: ShortText, modelId: ShortText,
    thinkingLevel: Type.Optional(ShortText) })),
  initialMessage: Type.Optional(MessageInputSchema),
})
export type LaunchSession = Static<typeof LaunchSessionSchema>
export const SendMessageSchema = O({ commandId: V2Uuid, sessionId: V2Id, message: MessageInputSchema })
export const ChoiceAnswerSchema = O({
  questionId: V2Id, selectedOptionIds: Type.Array(V2Id, { uniqueItems: true, maxItems: 50 }),
  text: Type.Optional(Type.String({ maxLength: 32_768 })),
})
export const ChoiceResponseSchema = O({ commandId: V2Uuid, sessionId: V2Id, choiceId: V2Id,
  answers: Type.Array(ChoiceAnswerSchema, { minItems: 1, maxItems: 20 }) })
export const StopSessionSchema = O({ commandId: V2Uuid, sessionId: V2Id })
export const RpcErrorSchema = O({
  code: E('INVALID_INPUT', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT',
    'UNAVAILABLE', 'PROTOCOL_MISMATCH', 'IDENTITY_MISMATCH', 'RESYNC_REQUIRED',
    'RATE_LIMITED', 'PAYLOAD_TOO_LARGE', 'INTERNAL'),
  message: Type.String({ maxLength: 1024 }), retryable: Type.Boolean(),
  retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
})
export type RpcError = Static<typeof RpcErrorSchema>
export const CommandReceiptSchema = O({
  commandId: V2Uuid,
  method: E('session.launch', 'session.send', 'session.choose', 'session.stop'),
  sessionId: NullableId,
  state: E('accepted', 'running', 'succeeded', 'failed', 'interrupted'),
  acceptedSequence: V2Sequence, updatedSequence: V2Sequence,
  acceptedAt: V2Time, updatedAt: V2Time,
  // input acceptance and provider delivery are deliberately separate facts.
  inputId: NullableId,
  delivery: E('none', 'pending', 'dispatched', 'unknown'),
  error: Type.Union([RpcErrorSchema, Type.Null()]),
})
export type CommandReceipt = Static<typeof CommandReceiptSchema>

export const StreamCursorSchema = O({ streamEpoch: V2Uuid, afterSequence: V2Sequence })
export type StreamCursor = Static<typeof StreamCursorSchema>
export const ShellSnapshotSchema = O({
  projects: Type.Array(ProjectSummarySchema, { maxItems: 100 }),
  sessions: Type.Array(SessionSummarySchema, { maxItems: 500 }),
  // Continuation is bound to the same materialized snapshot and high water.
  nextPage: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
})
export const ChoiceQuestionSchema = O({
  id: V2Id, header: Type.Optional(ShortText), question: Type.String({ maxLength: 8192 }),
  options: Type.Optional(Type.Array(O({ id: V2Id, label: ShortText,
    description: Type.Optional(Type.String({ maxLength: 2048 })),
    recommended: Type.Optional(Type.Boolean()) }), { maxItems: 50 })),
  isOther: Type.Optional(Type.Boolean()), placeholder: Type.Optional(ShortText),
  multiSelect: Type.Optional(Type.Boolean()),
  minSelections: Type.Optional(Type.Integer({ minimum: 0 })),
  maxSelections: Type.Optional(Type.Integer({ minimum: 0 })),
})
export const ChoiceSummarySchema = O({
  choiceId: V2Id, agentId: V2Id,
  status: E('pending', 'answered', 'cancelled', 'expired', 'interrupted'),
  questions: Type.Array(ChoiceQuestionSchema, { maxItems: 20 }),
})
export const WorkerSummarySchema = O({
  agentId: V2Id, title: ShortText, status: E('idle', 'streaming', 'terminated', 'stopped', 'error'),
})
export const DetailItemSchema = O({
  itemId: V2Id, userTurnId: V2Id, actorId: V2Id,
  kind: E('user', 'assistant', 'worker_result', 'tool', 'activity'),
  timestamp: V2Time, text: Type.String({ maxLength: 8192 }),
  contentRef: Type.Union([V2Id, Type.Null()]), // fetch full text/tool arguments/output by ID
  artifacts: Type.Array(ArtifactRefSchema, { maxItems: 20 }),
  commandId: Type.Union([V2Uuid, Type.Null()]),
})
export const DetailSnapshotSchema = O({
  session: SessionSummarySchema,
  items: Type.Array(DetailItemSchema, { maxItems: 200 }),
  workers: Type.Array(WorkerSummarySchema, { maxItems: 100 }),
  choices: Type.Array(ChoiceSummarySchema, { maxItems: 20 }),
  historyCursor: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
  workersCursor: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
})
export const ShellEventSchema = Type.Union([
  O({ type: Type.Literal('project.upsert'), project: ProjectSummarySchema }),
  O({ type: Type.Literal('project.remove'), projectId: V2Id }),
  O({ type: Type.Literal('session.upsert'), session: SessionSummarySchema }),
  O({ type: Type.Literal('session.remove'), sessionId: V2Id }),
])
export const DetailEventSchema = Type.Union([
  O({ type: Type.Literal('item.upsert'), item: DetailItemSchema }),
  O({ type: Type.Literal('worker.upsert'), worker: WorkerSummarySchema }),
  O({ type: Type.Literal('worker.remove'), agentId: V2Id }),
  O({ type: Type.Literal('choice.upsert'), choice: ChoiceSummarySchema }),
  O({ type: Type.Literal('receipt.upsert'), receipt: CommandReceiptSchema }),
  O({ type: Type.Literal('session.upsert'), session: SessionSummarySchema }),
  O({ type: Type.Literal('detail.reset') }),
])
export const streamItemSchema = <S extends TSchema, D extends TSchema>(snapshot: S, event: D) =>
  Type.Union([
    O({ kind: Type.Literal('snapshot'), streamEpoch: V2Uuid, sequence: V2Sequence, snapshot }),
    O({ kind: Type.Literal('event'), streamEpoch: V2Uuid, sequence: V2Sequence, event }),
    O({ kind: Type.Literal('synchronized'), streamEpoch: V2Uuid, sequence: V2Sequence }),
  ])
export const ShellStreamItemSchema = streamItemSchema(ShellSnapshotSchema, ShellEventSchema)
export const DetailStreamItemSchema = streamItemSchema(DetailSnapshotSchema, DetailEventSchema)
export type ShellStreamItem = Static<typeof ShellStreamItemSchema>
export type DetailStreamItem = Static<typeof DetailStreamItemSchema>
// Decoder-only result; the server never emits kind:'unknown'. Known malformed events fail decoding.
export type UnknownStreamItem = {
  kind: 'unknown'; streamEpoch: string; sequence: number; eventType: string
}
export const ShellSubscribeSchema = O({ cursor: Type.Optional(StreamCursorSchema) })
export const DetailSubscribeSchema = O({ sessionId: V2Id, cursor: Type.Optional(StreamCursorSchema) })
export const HistoryPageSchema = O({
  sequence: V2Sequence, streamEpoch: V2Uuid,
  items: Type.Array(DetailItemSchema, { maxItems: 200 }),
  nextCursor: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
})

export const DeviceSessionSchema = O({
  deviceSessionId: V2Uuid, deviceName: Type.String({ minLength: 1, maxLength: 80 }),
  kind: E('browser', 'desktop', 'cli'), scopes: ScopesSchema,
  createdAt: V2Time, lastSeenAt: V2Time, expiresAt: V2Time,
  revokedAt: Type.Union([V2Time, Type.Null()]),
  isCurrent: Type.Boolean(),
})
export type DeviceSession = Static<typeof DeviceSessionSchema>
export const CreatePairingGrantSchema = O({
  kind: E('link', 'code'), label: Type.String({ minLength: 1, maxLength: 80 }),
  scopes: ScopesSchema,
  expiresInSeconds: Type.Integer({ minimum: 60, maximum: 600 }),
  reachableBaseUrl: Type.String({ minLength: 1, maxLength: 2048 }),
})
export const PairingGrantCreatedSchema = O({
  grantId: V2Uuid, environmentId: V2Uuid, expiresAt: V2Time, scopes: ScopesSchema,
  pairingUrl: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
  code: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
  // Secrets in this response only; excluded from events, read models, logs, and receipts.
})
export const PairingChallengeSchema = O({
  challengeId: V2Uuid, nonce: Type.String({ minLength: 43, maxLength: 43 }), expiresAt: V2Time,
})
export const PairingExchangeSchema = O({
  credential: Type.Union([
    O({ kind: Type.Literal('link'), grantId: V2Uuid, secret: Type.String({ minLength: 43, maxLength: 43 }) }),
    O({ kind: Type.Literal('code'), code: Type.String({ minLength: 12, maxLength: 14 }) }),
  ]),
  environmentId: V2Uuid, challengeId: V2Uuid, nonce: Type.String({ minLength: 43, maxLength: 43 }),
  deviceName: Type.String({ minLength: 1, maxLength: 80 }),
  deviceKind: E('browser', 'desktop', 'cli'),
  delivery: E('cookie', 'bearer'), requestedScopes: ScopesSchema,
  // P-256 public JWK coordinates and IEEE-P1363 ECDSA SHA-256 signature (base64url).
  proofKey: O({ kty: Type.Literal('EC'), crv: Type.Literal('P-256'),
    x: Type.String({ minLength: 43, maxLength: 43 }), y: Type.String({ minLength: 43, maxLength: 43 }) }),
  proof: Type.String({ minLength: 86, maxLength: 86 }),
})
export const PairingExchangeResultSchema = O({
  environment: EnvironmentDescriptorSchema, deviceSession: DeviceSessionSchema,
  // cookie delivery omits token and sets HttpOnly cookie; bearer is delivered only once.
  bearerToken: Type.Optional(Type.String({ minLength: 43, maxLength: 43 })),
  csrfToken: Type.Optional(Type.String({ minLength: 43, maxLength: 43 })),
})
export type PairingExchange = Static<typeof PairingExchangeSchema>
export type PairingExchangeResult = Static<typeof PairingExchangeResultSchema>
export const RevokeDeviceSessionSchema = O({ deviceSessionId: V2Uuid })
export const RevokeDeviceSessionResultSchema = O({ deviceSessionId: V2Uuid, revokedAt: V2Time })
export const WsTicketRequestSchema = O({ audience: E('rpc', 'legacy'), protocolVersion: Type.Integer({ minimum: 1 }) })
export const WsTicketSchema = O({ ticket: Type.String({ minLength: 43, maxLength: 43 }), expiresAt: V2Time })

const SubscribeResult = O({ subscriptionId: V2Id })
const SessionInput = O({ sessionId: V2Id })
const LegacyInput = O({
  sessionId: Type.Optional(V2Id),
  // Temporary envelope. Existing strict ClientCommand parser is mandatory inside adapter.
  command: Type.Record(Type.String(), Type.Unknown()),
})
const LegacyResult = O({ events: Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 64 }) })
const TerminalRef = O({ terminalId: V2Id, sessionId: V2Id })
const TerminalFrame = Type.Union([
  O({ kind: Type.Literal('snapshot'), snapshotId: V2Uuid, part: Type.Integer({ minimum: 0 }),
    final: Type.Boolean(), offset: V2Sequence, data: Type.String({ maxLength: 65_536 }) }),
  O({ kind: Type.Literal('output'), offset: V2Sequence, data: Type.String({ maxLength: 16_384 }) }),
  O({ kind: Type.Literal('closed'), reason: ShortText }),
])
// Desktop's embedded browser host. The subscription is the host connection: ending it unregisters the host.
const BrowserHostStreamItem = Type.Union([
  O({ kind: Type.Literal('attached') }),
  O({ kind: Type.Literal('event'), event: Type.Record(Type.String(), Type.Unknown()) }),
])
// One host ClientCommand as JSON text, split so an 8 MiB automation response fits the frame limit.
const BrowserHostSend = O({
  transferId: V2Uuid, index: Type.Integer({ minimum: 0, maximum: 63 }),
  count: Type.Integer({ minimum: 1, maximum: 64 }), data: Type.String({ minLength: 1, maxLength: 262_144 }),
})
const defineRpc = <I extends TSchema, R extends TSchema, S extends TSchema | undefined = undefined>(
  input: I, output: R, options?: { stream?: S; receipt?: true },
) => ({ input, output, error: RpcErrorSchema, stream: options?.stream, receipt: options?.receipt === true })

export const rpcSchemas = {
  'environment.get': defineRpc(V2Empty, EnvironmentDescriptorSchema),
  'shell.subscribe': defineRpc(ShellSubscribeSchema, SubscribeResult, { stream: ShellStreamItemSchema }),
  'shell.page': defineRpc(O({ page: Type.String({ maxLength: 512 }) }),
    O({ sequence: V2Sequence, streamEpoch: V2Uuid, snapshot: ShellSnapshotSchema })),
  'session.subscribe': defineRpc(DetailSubscribeSchema, SubscribeResult, { stream: DetailStreamItemSchema }),
  'session.history': defineRpc(O({ sessionId: V2Id, before: Type.Optional(Type.String({ maxLength: 512 })),
    turns: Type.Integer({ minimum: 1, maximum: 20 }) }), HistoryPageSchema),
  'session.workers': defineRpc(O({ sessionId: V2Id, page: Type.Optional(Type.String({ maxLength: 512 })) }),
    O({ workers: Type.Array(WorkerSummarySchema, { maxItems: 100 }), nextPage: Type.Union([ShortText, Type.Null()]) })),
  'session.content': defineRpc(O({ sessionId: V2Id, contentRef: V2Id,
    offset: Type.Integer({ minimum: 0 }), maxBytes: Type.Integer({ minimum: 1, maximum: 262_144 }) }),
    O({ text: Type.String({ maxLength: 262_144 }), nextOffset: Type.Union([V2Sequence, Type.Null()]) })),
  'session.launch': defineRpc(LaunchSessionSchema, CommandReceiptSchema, { receipt: true }),
  'session.send': defineRpc(SendMessageSchema, CommandReceiptSchema, { receipt: true }),
  'session.choose': defineRpc(ChoiceResponseSchema, CommandReceiptSchema, { receipt: true }),
  'session.stop': defineRpc(StopSessionSchema, CommandReceiptSchema, { receipt: true }),
  'command.get': defineRpc(O({ commandId: V2Uuid }), CommandReceiptSchema),
  'access.grant.create': defineRpc(CreatePairingGrantSchema, PairingGrantCreatedSchema),
  'access.devices.list': defineRpc(V2Empty, Type.Array(DeviceSessionSchema, { maxItems: 256 })),
  'access.devices.revoke': defineRpc(RevokeDeviceSessionSchema, RevokeDeviceSessionResultSchema),
  'terminal.attach': defineRpc(O({ ...TerminalRef.properties, ticket: Type.String({ maxLength: 128 }) }),
    SubscribeResult, { stream: TerminalFrame }),
  'terminal.input': defineRpc(O({ subscriptionId: V2Id, inputId: V2Uuid,
    data: Type.String({ maxLength: 16_384 }) }), V2Empty),
  'terminal.resize': defineRpc(O({ subscriptionId: V2Id,
    cols: Type.Integer({ minimum: 1, maximum: 1000 }), rows: Type.Integer({ minimum: 1, maximum: 1000 }) }), V2Empty),
  'browser.host.attach': defineRpc(V2Empty, SubscribeResult, { stream: BrowserHostStreamItem }),
  'browser.host.send': defineRpc(BrowserHostSend, V2Empty),
  // Migration-only methods, each with a compile-time scope and a stricter inner allowlist.
  'legacy.session.subscribe': defineRpc(SessionInput, SubscribeResult, { stream:
    O({ type: Type.String({ minLength: 1, maxLength: 128 }), payload: Type.Unknown() }) }),
  'legacy.session.read': defineRpc(LegacyInput, LegacyResult),
  'legacy.session.operate': defineRpc(LegacyInput, LegacyResult),
  'legacy.workspace.read': defineRpc(LegacyInput, LegacyResult),
  'legacy.workspace.write': defineRpc(LegacyInput, LegacyResult),
  'legacy.settings.admin': defineRpc(LegacyInput, LegacyResult),
} as const
export type Method = keyof typeof rpcSchemas
export const rpcScopes = {
  'environment.get': 'session:read', 'shell.subscribe': 'session:read', 'shell.page': 'session:read',
  'session.subscribe': 'session:read', 'session.history': 'session:read',
  'session.workers': 'session:read', 'session.content': 'session:read',
  'session.launch': 'session:operate', 'session.send': 'session:operate',
  'session.choose': 'session:operate', 'session.stop': 'session:operate', 'command.get': 'session:operate',
  'access.grant.create': 'access:admin', 'access.devices.list': 'access:admin',
  'access.devices.revoke': 'access:admin',
  'terminal.attach': 'terminal:operate', 'terminal.input': 'terminal:operate', 'terminal.resize': 'terminal:operate',
  'browser.host.attach': 'session:operate', 'browser.host.send': 'session:operate',
  'legacy.session.subscribe': 'session:read',
  'legacy.session.read': 'session:read', 'legacy.session.operate': 'session:operate',
  'legacy.workspace.read': 'workspace:read', 'legacy.workspace.write': 'workspace:write',
  'legacy.settings.admin': 'settings:admin',
} as const satisfies Record<Method, Scope>
export const rpcRegistry = Object.fromEntries(Object.entries(rpcSchemas).map(([method, schemas]) =>
  [method, { method, ...schemas, scope: rpcScopes[method as Method] }],
)) as { [M in Method]: typeof rpcSchemas[M] & { method: M; scope: typeof rpcScopes[M] } }
export type RpcInput<M extends Method> = Static<(typeof rpcSchemas)[M]['input']>
export type RpcOutput<M extends Method> = Static<(typeof rpcSchemas)[M]['output']>
export type StreamMethod = {
  [M in Method]: Exclude<(typeof rpcSchemas)[M]['stream'], undefined> extends never ? never : M
}[Method]
export type RpcStreamItem<M extends StreamMethod> = Static<Exclude<(typeof rpcSchemas)[M]['stream'], undefined>>

export const RpcClientFrameSchema = Type.Union([
  O({ type: Type.Literal('request'), requestId: V2Id,
    method: E(...Object.keys(rpcSchemas) as Method[]), input: Type.Unknown() }),
  O({ type: Type.Literal('cancel'), requestId: V2Id }),
  O({ type: Type.Literal('unsubscribe'), subscriptionId: V2Id }),
  O({ type: Type.Literal('ping'), nonce: V2Id }),
])
export const RpcServerFrameSchema = Type.Union([
  O({ type: Type.Literal('result'), requestId: V2Id, output: Type.Unknown() }),
  O({ type: Type.Literal('error'), requestId: V2Id, error: RpcErrorSchema }),
  O({ type: Type.Literal('stream'), subscriptionId: V2Id, item: Type.Unknown() }),
  O({ type: Type.Literal('stream.error'), subscriptionId: V2Id, error: RpcErrorSchema }),
  O({ type: Type.Literal('pong'), nonce: V2Id }),
])
export type RpcClientFrame = Static<typeof RpcClientFrameSchema>
export type RpcServerFrame = Static<typeof RpcServerFrameSchema>
