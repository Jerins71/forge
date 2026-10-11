import type {
  InstructionBundle, ProviderCapabilities, ProviderConversationRef, ProviderInstructionChannel,
  ProviderObservation, ProviderRequestLifetime, ProviderRequestRef, ProviderScope, ProviderToolCallRef,
  ProviderTurnRef, ToolHostSnapshot,
} from "@forge/protocol";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ForgeExtensionHost } from "../forge-extension-host.js";
import type { SecureRuntimeBinding } from "../secure-sessions/runtime/secure-runtime-binding.js";
import type { RuntimeUserMessage } from "../runtime-contracts.js";
import type { AgentModelDescriptor } from "../types.js";

export interface ProviderRequirements {
  instructionChannel?: ProviderInstructionChannel;
  instructionRefresh?: boolean;
  toolRefresh?: boolean;
  nativeResume?: boolean;
  nativeFork?: boolean;
  nativeSteer?: boolean;
  nativeCompact?: boolean;
  readContext?: boolean;
  interrupt?: boolean;
  persistentApprovals?: boolean;
  secureSessions?: boolean;
  textDeltas?: boolean;
  reasoningDeltas?: boolean;
  toolDeltas?: boolean;
  authoritativeTerminal?: boolean;
}

export class UnsupportedProviderBehaviorError extends Error {
  readonly code = "PROVIDER_BEHAVIOR_UNSUPPORTED" as const;
  constructor(readonly provider: string, readonly behavior: keyof ProviderRequirements) {
    super(`Provider ${provider} does not support required behavior: ${behavior}.`);
    this.name = "UnsupportedProviderBehaviorError";
  }
}

/** Same-scope open/resume found a different instruction revision or tool host; the runtime must be recreated or resumed, never rebound. */
export class ProviderRefreshRequiredError extends Error {
  readonly code = "PROVIDER_REFRESH_REQUIRED" as const;
  constructor(readonly provider: string, readonly changed: "instructions" | "tools" | "both") {
    super(`Provider ${provider} requires a refresh: ${changed} changed for an already-open binding.`);
    this.name = "ProviderRefreshRequiredError";
  }
}

/** Rejected before a native dispatch; the kernel may admit another attempt without unknown-delivery recovery. */
export class ProviderDispatchRejectedError extends Error {
  readonly code = "PROVIDER_DISPATCH_REJECTED" as const;
  readonly delivery = "not_dispatched" as const;
  constructor(readonly reason: "busy" | "closed" | "stale_scope" | "unsupported_steer") {
    super(`Provider dispatch rejected before delivery: ${reason}.`);
    this.name = "ProviderDispatchRejectedError";
  }
}

/** The binding cannot answer an unknown, expired, or stale native request. */
export class ProviderRequestRejectedError extends Error {
  readonly code = "PROVIDER_REQUEST_REJECTED" as const;
  constructor(readonly reason: "unknown_request" | "expired" | "stale_scope") {
    super(`Provider request is expired, already resolved, or belongs to a stale scope: ${reason}.`);
    this.name = "ProviderRequestRejectedError";
  }
}

/** Admission is explicit. This helper never chooses or dispatches a weaker fallback. */
export function assertProviderRequirements(capabilities: ProviderCapabilities, requirements: ProviderRequirements = {}): void {
  const support: Record<Exclude<keyof ProviderRequirements, "instructionChannel">, boolean> = {
    instructionRefresh: capabilities.instructions.update !== "on_open",
    toolRefresh: capabilities.tools.registration === "refreshable",
    nativeResume: capabilities.native.resume, nativeFork: capabilities.native.fork,
    nativeSteer: capabilities.native.steer, nativeCompact: capabilities.native.compact,
    readContext: capabilities.native.readContext, interrupt: capabilities.native.interrupt,
    persistentApprovals: capabilities.approvals.lifetime === "resumable",
    secureSessions: capabilities.secureSessions.supported,
    textDeltas: capabilities.streaming.text === "delta", reasoningDeltas: capabilities.streaming.reasoning === "delta",
    toolDeltas: capabilities.streaming.tools === "delta", authoritativeTerminal: capabilities.streaming.terminal === "authoritative",
  };
  if (requirements.instructionChannel && !capabilities.instructions.channels.includes(requirements.instructionChannel)) {
    throw new UnsupportedProviderBehaviorError(capabilities.provider, "instructionChannel");
  }
  for (const behavior of Object.keys(support) as Array<keyof typeof support>) {
    if (requirements[behavior] && !support[behavior]) throw new UnsupportedProviderBehaviorError(capabilities.provider, behavior);
  }
}

/** Live object; never serialize this binding. Use snapshot for durable schema metadata. */
export interface ToolHostBinding {
  readonly snapshot: ToolHostSnapshot;
  readonly tools: readonly ToolDefinition[];
  readonly extensionHooks?: { host: ForgeExtensionHost; bindingToken: string };
  readonly security?: SecureRuntimeBinding;
  toJSON(): never;
  /** Passes the native call ID, cancellation signal and updates unchanged to the existing tool owner. */
  invoke(call: {
    ref: ProviderToolCallRef;
    name: string;
    args: unknown;
    signal?: AbortSignal;
    onUpdate?: Parameters<ToolDefinition["execute"]>[3];
    context: Parameters<ToolDefinition["execute"]>[4];
  }): ReturnType<ToolDefinition["execute"]>;
}

export interface ProviderOpenInput {
  scope: ProviderScope;
  model: AgentModelDescriptor;
  instructions: InstructionBundle;
  toolHost: ToolHostBinding;
  required?: ProviderRequirements;
}
export interface ProviderBinding {
  scope: ProviderScope;
  conversation: ProviderConversationRef;
  capabilities: ProviderCapabilities;
  instructionRevision: string;
  toolContractRevision: string;
  /** App-owned context coverage; live security and callback capabilities never enter this snapshot. */
  model?: AgentModelDescriptor;
  nativeRunIds?: string[];
  contextCoverage?: Record<string, string[]>;
}
export interface ProviderResumeInput extends ProviderOpenInput { conversation: ProviderConversationRef; }
export interface ProviderStartInput {
  binding: ProviderBinding;
  runId: string;
  attemptId: string;
  input: RuntimeUserMessage;
  /** Present only when capability policy permits updates at the turn boundary. */
  instructions?: InstructionBundle;
  /** Only refreshable registration may accept a changed host at the next dispatch boundary. */
  toolHost?: ToolHostBinding;
}
export interface ProviderSteerInput extends ProviderStartInput { turn: ProviderTurnRef; }
export interface ProviderRespondInput {
  binding: ProviderBinding;
  request: ProviderRequestRef;
  lifetime: ProviderRequestLifetime;
  response: unknown;
}
export interface ProviderContext {
  conversation: ProviderConversationRef;
  coveredThrough?: ProviderTurnRef;
  messages: ReadonlyArray<{ role: "user" | "assistant" | "system"; content: unknown }>;
}
export type ProviderDispatchResult =
  | { status: "accepted"; turn: ProviderTurnRef }
  | { status: "unknown" };
export type ProviderDrainResult = { status: "clean" } | { status: "pending" };

/** Providers own native correlation; Forge's current lifecycle owner still owns runs and queues. */
export interface ProviderAdapter {
  capabilities(): ProviderCapabilities;
  open(input: ProviderOpenInput): Promise<ProviderBinding>;
  resume(input: ProviderResumeInput): Promise<ProviderBinding>;
  start(input: ProviderStartInput): Promise<ProviderDispatchResult>;
  steer(input: ProviderSteerInput): Promise<ProviderDispatchResult>;
  /** Resolving interrupt is an acknowledgment, not a terminal observation. */
  interrupt(input: { binding: ProviderBinding; attemptId: string; turn: ProviderTurnRef }): Promise<void>;
  respond(input: ProviderRespondInput): Promise<void>;
  compact(input: { binding: ProviderBinding; attemptId: string; instructions?: string }): Promise<void>;
  fork?(input: { binding: ProviderBinding; through?: ProviderTurnRef }): Promise<ProviderConversationRef>;
  readContext?(input: { binding: ProviderBinding; through?: ProviderTurnRef }): Promise<ProviderContext>;
  /** A single ordered stream per binding. The adapter cannot assign children to Forge workers. */
  observations(binding: ProviderBinding, signal?: AbortSignal): AsyncIterable<ProviderObservation>;
  close(binding: ProviderBinding): Promise<void>;
  /** Clean means callbacks, tools, transports and journal writers are settled. */
  drain(binding: ProviderBinding): Promise<ProviderDrainResult>;
}
