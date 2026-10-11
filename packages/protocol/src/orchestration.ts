import { Type, type Static } from "@sinclair/typebox";

/** A persisted snapshot of adapter policy, never a live runtime or security capability. */
export const PROVIDER_CONTRACT_VERSION = 1 as const;
const strict = { additionalProperties: false };
const id = Type.String({ minLength: 1 });
const values = <T extends string>(items: readonly T[]) => Type.Union(items.map(item => Type.Literal(item)));

export const ProviderCapabilitiesSchema = Type.Object({
  version: Type.Literal(PROVIDER_CONTRACT_VERSION),
  provider: id,
  adapterVersion: id,
  instructions: Type.Object({
    channels: Type.Array(values(["system", "developer", "preset_append", "resource_loader"] as const), { minItems: 1, uniqueItems: true }),
    update: values(["on_open", "on_turn", "explicit_refresh"] as const),
    nativeBase: values(["none", "preserved", "preset"] as const),
  }, strict),
  tools: Type.Object({
    registration: values(["immutable", "refreshable"] as const),
    host: values(["dynamic_tools", "in_process_mcp", "loopback_mcp", "native_tools"] as const),
    nativeCallIdentity: Type.Boolean(),
    cancellation: values(["abort_signal", "provider_interrupt", "none"] as const),
    extensionHooks: Type.Boolean(),
  }, strict),
  streaming: Type.Object({
    text: values(["delta", "snapshot", "final", "none"] as const),
    reasoning: values(["delta", "snapshot", "final", "none"] as const),
    tools: values(["delta", "snapshot", "final", "none"] as const),
    usage: values(["delta", "final", "none"] as const),
    terminal: values(["authoritative", "inferred", "none"] as const),
  }, strict),
  native: Type.Object({
    resume: Type.Boolean(), fork: Type.Boolean(), forkThroughTurn: Type.Optional(Type.Boolean()), steer: Type.Boolean(), compact: Type.Boolean(),
    readContext: Type.Boolean(), interrupt: Type.Boolean(),
  }, strict),
  approvals: Type.Object({
    lifetime: values(["none", "live_callback", "binding", "resumable"] as const),
    nativeRequestIdentity: Type.Boolean(), childRequests: Type.Boolean(),
  }, strict),
  secureSessions: Type.Object({
    supported: Type.Boolean(), mechanism: values(["none", "guarded_tools", "secure_bash"] as const),
  }, strict),
}, strict);
export type ProviderCapabilities = Static<typeof ProviderCapabilitiesSchema>;
export type ProviderInstructionChannel = ProviderCapabilities["instructions"]["channels"][number];
export type ProviderToolHostMechanism = ProviderCapabilities["tools"]["host"];

/** Refs are scoped to an app binding and generation, then to their native parents. */
export const ProviderScopeSchema = Type.Object({ threadId: id, bindingId: id, generation: Type.Integer({ minimum: 0 }) }, strict);
export type ProviderScope = Static<typeof ProviderScopeSchema>;
const scopeFields = ProviderScopeSchema.properties;
export const ProviderTurnRefSchema = Type.Object({ ...scopeFields, kind: Type.Literal("turn"), conversationId: id, nativeId: id }, strict);
/** Fork locators contain public native identities only. Claude defers its fork until SDK resume. */
export const ProviderConversationRefSchema = Type.Object({ ...scopeFields, kind: Type.Literal("conversation"), nativeId: id,
  forkOnResume: Type.Optional(Type.Literal(true)),
  forkSource: Type.Optional(Type.Object({ nativeId: id, through: Type.Optional(ProviderTurnRefSchema) }, strict)),
}, strict);
export const ProviderItemRefSchema = Type.Object({ ...scopeFields, kind: Type.Literal("item"), conversationId: id, turnId: id, nativeId: id }, strict);
export const ProviderRequestRefSchema = Type.Object({ ...scopeFields, kind: Type.Literal("request"), conversationId: id, turnId: Type.Optional(id), nativeId: id }, strict);
export const ProviderToolCallRefSchema = Type.Object({ ...scopeFields, kind: Type.Literal("tool_call"), conversationId: id, turnId: id, nativeId: id }, strict);
export type ProviderConversationRef = Static<typeof ProviderConversationRefSchema>;
export type ProviderTurnRef = Static<typeof ProviderTurnRefSchema>;
export type ProviderItemRef = Static<typeof ProviderItemRefSchema>;
export type ProviderRequestRef = Static<typeof ProviderRequestRefSchema>;
export type ProviderToolCallRef = Static<typeof ProviderToolCallRefSchema>;

const rootOrigin = Type.Object({ kind: Type.Literal("root"), conversation: ProviderConversationRefSchema, turn: Type.Optional(ProviderTurnRefSchema) }, strict);
const childOrigin = Type.Object({ kind: Type.Literal("child"), conversation: ProviderConversationRefSchema, parentTurn: ProviderTurnRefSchema, nativeAgentId: Type.Optional(id) }, strict);
const origin = Type.Union([rootOrigin, childOrigin]);
const observationFields = { scope: ProviderScopeSchema, attemptId: id, sequence: Type.Integer({ minimum: 0 }) };
const jsonValue = Type.Recursive(self => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(self), Type.Record(Type.String(), self)]));

export const ProviderRequestLifetimeSchema = Type.Object({
  kind: values(["live_callback", "binding", "resumable"] as const),
  /** Even resumable requests must be re-observed in the current generation before responding. */
  generation: Type.Integer({ minimum: 0 }),
  expiresAt: Type.Optional(Type.String()),
}, strict);
export type ProviderRequestLifetime = Static<typeof ProviderRequestLifetimeSchema>;

export const ProviderTokenUsageSchema = Type.Object({
  input: Type.Optional(Type.Number()), output: Type.Optional(Type.Number()), cacheRead: Type.Optional(Type.Number()),
  cacheWrite: Type.Optional(Type.Number()), reasoning: Type.Optional(Type.Number()), total: Type.Optional(Type.Number()),
}, strict);
export type ProviderTokenUsage = Static<typeof ProviderTokenUsageSchema>;
export const ProviderCostUsdSchema = Type.Object({
  input: Type.Optional(Type.Number()), output: Type.Optional(Type.Number()), cacheRead: Type.Optional(Type.Number()),
  cacheWrite: Type.Optional(Type.Number()), total: Type.Optional(Type.Number()),
}, strict);
export type ProviderCostUsd = Static<typeof ProviderCostUsdSchema>;

/** Observations are facts; only the existing lifecycle owner may act on them. */
export const ProviderObservationSchema = Type.Union([
  Type.Object({ ...observationFields, type: Type.Literal("accepted"), origin, turn: ProviderTurnRefSchema }, strict),
  Type.Object({ ...observationFields, type: Type.Literal("message"), origin, item: ProviderItemRefSchema,
    phase: values(["start", "delta", "complete"] as const), channel: values(["assistant", "reasoning"] as const), text: Type.String(), content: Type.Optional(jsonValue) }, strict),
  Type.Object({ ...observationFields, type: Type.Literal("tool"), origin, call: ProviderToolCallRefSchema,
    phase: values(["start", "update", "complete"] as const), name: id, payload: Type.Optional(jsonValue), isError: Type.Optional(Type.Boolean()) }, strict),
  Type.Object({ ...observationFields, type: Type.Literal("usage"), origin, usage: ProviderTokenUsageSchema,
    costUsd: Type.Optional(ProviderCostUsdSchema), modelId: Type.Optional(id), responseModelId: Type.Optional(id),
    provider: Type.Optional(id), api: Type.Optional(id), stopReason: Type.Optional(Type.String()),
    providerRequestId: Type.Optional(id), durationMs: Type.Optional(Type.Number()),
  }, strict),
  Type.Object({ ...observationFields, type: Type.Literal("context_usage"), origin,
    tokens: Type.Number(), contextWindow: Type.Number(), percent: Type.Number(),
  }, strict),
  Type.Object({ ...observationFields, type: Type.Literal("request_opened"), origin, request: ProviderRequestRefSchema,
    requestKind: values(["approval", "user_input"] as const), lifetime: ProviderRequestLifetimeSchema, payload: jsonValue }, strict),
  Type.Object({ ...observationFields, type: Type.Literal("request_resolved"), origin, request: ProviderRequestRefSchema,
    resolution: values(["answered", "cancelled", "expired"] as const) }, strict),
  // Keep authority in the union: a provider child cannot claim a Forge root terminal.
  ...(["root", "child"] as const).map(kind => Type.Object({ ...observationFields, type: Type.Literal("terminal"),
    origin: kind === "root" ? rootOrigin : childOrigin,
    terminalAuthority: Type.Literal(kind === "root" ? "root_attempt" : "native_child"),
    outcome: values(["completed", "interrupted", "cancelled", "failed"] as const),
    error: Type.Optional(Type.Object({ code: id, message: Type.String() }, strict)),
  }, strict)),
  Type.Object({ ...observationFields, type: Type.Literal("error"), origin, code: id, message: Type.String(),
    delivery: values(["not_dispatched", "accepted", "unknown"] as const) }, strict),
  /** Display only: the provider is retrying a failed request itself. Never a terminal or delivery fact. */
  Type.Object({ ...observationFields, type: Type.Literal("retry"), origin, attempt: Type.Integer({ minimum: 1 }), message: Type.String(),
    maxAttempts: Type.Optional(Type.Integer({ minimum: 1 })), delayMs: Type.Optional(Type.Number({ minimum: 0 })) }, strict),
  Type.Object({ ...observationFields, type: Type.Literal("compaction"), origin,
    phase: values(["started", "completed", "failed"] as const), payload: Type.Optional(jsonValue) }, strict),
]);
export type ProviderObservation = Static<typeof ProviderObservationSchema>;

export const InstructionSourceSchema = Type.Object({
  kind: id,
  id,
  path: Type.Optional(Type.String()),
  revision: id,
}, strict);
export type InstructionSource = Static<typeof InstructionSourceSchema>;
export const InstructionPartSchema = Type.Object({
  kind: id,
  text: Type.String(),
  /** Exact prefix separator; joining parts never trims or normalizes bytes. */
  separator: Type.String(),
  sources: Type.Array(InstructionSourceSchema, { minItems: 1 }),
}, strict);
export type InstructionPart = Static<typeof InstructionPartSchema>;

const inventoryEntry = Type.Object({ name: id, path: id, description: Type.Optional(Type.String()), source: InstructionSourceSchema }, strict);
export const InstructionBundleSchema = Type.Object({
  version: Type.Literal(PROVIDER_CONTRACT_VERSION), revision: id,
  actor: Type.Object({ agentId: id, role: values(["manager", "worker"] as const), managerId: id, profileId: Type.Optional(id) }, strict),
  project: Type.Object({ cwd: id, workspaceKey: Type.Optional(id), forgeDir: Type.Optional(id) }, strict),
  parts: Type.Array(InstructionPartSchema),
  memory: Type.Optional(Type.Object({ path: id, content: Type.String(), sources: Type.Array(InstructionSourceSchema) }, strict)),
  skills: Type.Array(inventoryEntry), references: Type.Array(inventoryEntry),
  pins: Type.Array(Type.Object({ id, content: Type.String(), source: InstructionSourceSchema }, strict)),
  approvedHandoff: Type.Optional(Type.Object({ handoffId: id, content: Type.String(), sources: Type.Array(InstructionSourceSchema),
    sourceThreadId: id, sourceEntryId: id, approvedBy: id }, strict)),
}, strict);
export type InstructionBundle = Static<typeof InstructionBundleSchema>;

/** The only tool-host data that may be persisted; handlers and grants stay ephemeral. */
export const ToolHostSnapshotSchema = Type.Object({
  version: Type.Literal(PROVIDER_CONTRACT_VERSION), actorAgentId: id,
  mechanism: Type.Optional(values(["dynamic_tools", "in_process_mcp", "loopback_mcp", "native_tools"] as const)),
  tools: Type.Array(Type.Object({ name: id, description: Type.String(), inputSchema: jsonValue }, strict)),
  eligibility: Type.Object({ browser: Type.Boolean(), internalSession: Type.Boolean(), role: values(["manager", "worker"] as const) }, strict),
}, strict);
export type ToolHostSnapshot = Static<typeof ToolHostSnapshotSchema>;
