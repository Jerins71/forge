import type { IncomingMessage } from "node:http";
import type { ProviderScope, ProviderConversationRef } from "@forge/protocol";
import type { ProviderAdapter, ProviderBinding } from "../../swarm/runtime/provider-contract.js";
import type { RuntimeUserMessage } from "../../swarm/runtime-contracts.js";
import type {
  CommandReceipt,
  DetailStreamItem,
  PairingExchange,
  PairingExchangeResult,
  RpcInput,
  RpcOutput,
  Scope,
  ShellStreamItem,
} from "@forge/protocol/environment-v2";

/**
 * Cross-stream service ports for the Forge V2 environment layer. These are the
 * fixed seams between the control, access, swarm-integration, and transport
 * workstreams; implementations keep their stores and constructors internal.
 * Wire DTOs live in @forge/protocol/environment-v2 and are never duplicated here.
 */

export type ControlMethod = CommandReceipt["method"];

export interface Principal {
  /** Server-derived provenance; this grants no additional authority. */
  integration?: "cli" | "stream-deck";
  /** Private platform capability, minted only on a loopback Desktop ticket. Never a grant scope. */
  localBrowserHost?: boolean;
  deviceSessionId: string;
  scopes: ReadonlySet<Scope>;
}

/** Backend-only admission data; existing validated wire commands remain unchanged. */
export interface LifecycleAdmission {
  /** Return saved receipts after interruption; never repeat the callback. */
  receiptReplay?: boolean;
  /** A claimed provider operation cannot be safely replayed after interruption. */
  ambiguousDelivery?: boolean;
  commandId: string;
  command: string;
  /** File mutations authorize workspace writes without elevating session privileges. */
  requiredScope?: Scope;
  receipt?: { method: ControlMethod; projectId?: string; sessionId?: string };
  sessionIds: readonly string[];
  /** A worker deletion fences only this child, preserving its manager and queued inputs. */
  workerId?: string;
  /** Profile teardown also fences launches not yet materialized in the swarm. */
  projectIds?: readonly string[];
  intent: "stop" | "resume" | "inspect" | "cancel-choice";
  request: unknown;
  /** Resolved policy is durable without changing the caller request hash. */
  frozenRequest?: unknown;
  choiceId?: string;
  /** Synchronous target policy; only fresh requests run it, before any fence. */
  preflight?: () => void;
}

/** Durable owner of session mutations and their lifecycle admission. */
export interface ControlService {
  execute<M extends ControlMethod>(principal: Principal, method: M, input: RpcInput<M>): Promise<CommandReceipt>;
  readLineage?(principal: Principal, input: RpcInput<"session.lineage.get">): Promise<RpcOutput<"session.lineage.get">> | RpcOutput<"session.lineage.get">;
  readWorkspace?<M extends import("./project-policy.js").DirectoryReadMethod>(principal: Principal, method: M, input: RpcInput<M>): Promise<RpcOutput<M>>;
  getReceipt(principal: Principal, commandId: string): Promise<CommandReceipt>;
  /** Synchronous lifecycle callbacks are journaled for retry, never automatically replayed. */
  admitLifecycle?<T>(principal: Principal, input: LifecycleAdmission, operation: () => Promise<T>): Promise<T>;
}

/** Narrow calls into the existing SwarmManager facade used by control effects. */
export interface SwarmControlPort {
  /** Resolve worker targets to their owning manager's admission lane. */
  resolveSession?(agentId: string): { sessionId: string; workerId?: string };
  ensureSession(input: {
    commandId: string;
    sessionId: string;
    projectId: string;
    title: string;
    cwd: string;
    cli?: RpcInput<"session.launch">["cli"];
    model?: { provider: string; modelId: string; thinkingLevel?: string };
  }): Promise<{ materialized: true }>;
  applyInput(input: {
    commandId: string;
    inputId: string;
    sessionId: string;
    runGeneration: number;
    message: RpcInput<"session.send">["message"];
    source?: import("../../swarm/types.js").MessageSourceContext;
    delivery?: RpcInput<"session.send">["delivery"];
    runId: string;
    resendOfCommandId?: string;
    prepared?: import("./command-service.js").InternalInput["prepared"];
    userOptions?: import("./command-service.js").InternalInput["userOptions"];
  }): Promise<{ entryId: string; runtimeMessage: RuntimeUserMessage }>;
  acquireProvider(scope: ProviderScope, conversation?: ProviderConversationRef, model?: Pick<import("../../swarm/types.js").AgentModelDescriptor,"provider"|"modelId"> & Partial<Pick<import("../../swarm/types.js").AgentModelDescriptor,"thinkingLevel">>): Promise<{ adapter: ProviderAdapter; binding: ProviderBinding }>;
  readTransferEntries?(threadId: string): Promise<import("../../swarm/types.js").ConversationEntryEvent[]>;
  /** Descriptor/resources only: no provider, credential, or implicit tool-grant acquisition. */
  prepareLineageSession?(input: { kind: "fork" | "continued_worker"; sourceThreadId: string; targetThreadId: string; commandId: string; title?: string; historical?: boolean; sourcePoint: import("@forge/protocol/environment-v2").ContextSourcePoint; model?: import("../../swarm/types.js").AgentDescriptor["model"]; purpose?: "side_chat" }): Promise<void>;
  enqueuePresentation?(threadId:string,runId:string,presentation:import("../../swarm/turn-context-coordinator.js").InboundTurnContextInput):void;
  prepareWorkerResult?(assignment: import("./orchestration/assignments.js").WorkerAssignment, resultText: string): Promise<NonNullable<import("./command-service.js").InternalInput["prepared"]>>;
  extractWorkerResult?(threadId:string,runId:string,inputEntryId:string):Promise<{ entryId:string; resultText:string }>;
  /** Writes the "stopped by the user" result into the worker's transcript and returns it for delivery to the manager. */
  recordStoppedWorkerResult?(threadId:string,runId:string):Promise<{ entryId:string; resultText:string }>;
  applyChoice(input: {
    commandId: string;
    sessionId: string;
    choiceId: string;
    runtimeGeneration: string;
    answers: RpcInput<"session.choose">["answers"];
  }): Promise<"answered" | "interrupted">;
  stopSession(input: { commandId: string; sessionId: string }): Promise<{ stopped: boolean }>;
  /** Leaves the "Stopped by you" marker on a turn the user stopped while it was running. */
  markTurnStopped?(sessionId: string): void;
}

export interface EnvironmentAccessPort {
  authenticateHttp(request: IncomingMessage, required: Scope, csrf: boolean): Promise<Principal>;
  authorize(principal: Principal, scopes: readonly Scope[]): void;
  exchange(input: PairingExchange, origin: string | null): Promise<PairingExchangeResult>;
  createGrant(principal: Principal, input: RpcInput<"access.grant.create">): Promise<RpcOutput<"access.grant.create">>;
  pairingAddressInfo(principal: Principal): Promise<RpcOutput<"access.pairing.address">>;
  listDevices(principal: Principal): Promise<RpcOutput<"access.devices.list">>;
  revokeDevice(principal: Principal, input: RpcInput<"access.devices.revoke">): Promise<RpcOutput<"access.devices.revoke">>;
  consumeWsTicket(input: {
    ticket: string;
    audience: "rpc";
    origin: string | null;
    protocolVersion: number;
  }): Promise<Principal>;
  registerResource(principal: Principal, close: () => void): () => void;
}

export interface EnvironmentStreamPort {
  shell(principal: Principal, input: RpcInput<"shell.subscribe">, signal: AbortSignal): AsyncIterable<ShellStreamItem>;
  shellPage(principal: Principal, input: RpcInput<"shell.page">): Promise<RpcOutput<"shell.page">>;
  detail(principal: Principal, input: RpcInput<"session.subscribe">, signal: AbortSignal): AsyncIterable<DetailStreamItem>;
  history(principal: Principal, input: RpcInput<"session.history">): Promise<RpcOutput<"session.history">>;
  workers(principal: Principal, input: RpcInput<"session.workers">): Promise<RpcOutput<"session.workers">>;
  content(principal: Principal, input: RpcInput<"session.content">): Promise<RpcOutput<"session.content">>;
}
