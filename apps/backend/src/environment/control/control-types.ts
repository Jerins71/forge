import type { IncomingMessage } from "node:http";
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

export type ControlMethod = "session.launch" | "session.send" | "session.choose" | "session.stop";

export interface Principal {
  deviceSessionId: string;
  scopes: ReadonlySet<Scope>;
}

/** Durable owner of the four user-facing session mutations. */
export interface ControlService {
  execute<M extends ControlMethod>(principal: Principal, method: M, input: RpcInput<M>): Promise<CommandReceipt>;
  getReceipt(principal: Principal, commandId: string): Promise<CommandReceipt>;
}

/** Narrow calls into the existing SwarmManager facade used by control effects. */
export interface SwarmControlPort {
  ensureSession(input: {
    commandId: string;
    sessionId: string;
    projectId: string;
    title: string;
    cwd: string;
    model?: { provider: string; modelId: string; thinkingLevel?: string };
  }): Promise<{ materialized: true }>;
  applyInput(input: {
    commandId: string;
    inputId: string;
    sessionId: string;
    runGeneration: number;
    message: RpcInput<"session.send">["message"];
    /** Implemented by the control DB; invoked at the matching boundary inside the existing coordinator. */
    beforeDispatch(): Promise<"dispatch" | "do-not-dispatch">;
    onCanonicalAppend(entryId: string): Promise<void>;
    onDispatchAccepted(): Promise<void>;
  }): Promise<{ delivery: "dispatched" | "unknown" }>;
  applyChoice(input: {
    commandId: string;
    sessionId: string;
    choiceId: string;
    runtimeGeneration: string;
    answers: RpcInput<"session.choose">["answers"];
  }): Promise<"answered" | "interrupted">;
  stopSession(input: { commandId: string; sessionId: string }): Promise<{ stopped: boolean }>;
}

export interface EnvironmentAccessPort {
  authenticateHttp(request: IncomingMessage, required: Scope, csrf: boolean): Promise<Principal>;
  authorize(principal: Principal, scopes: readonly Scope[]): void;
  exchange(input: PairingExchange, origin: string | null): Promise<PairingExchangeResult>;
  createGrant(principal: Principal, input: RpcInput<"access.grant.create">): Promise<RpcOutput<"access.grant.create">>;
  listDevices(principal: Principal): Promise<RpcOutput<"access.devices.list">>;
  revokeDevice(principal: Principal, input: RpcInput<"access.devices.revoke">): Promise<RpcOutput<"access.devices.revoke">>;
  consumeWsTicket(input: {
    ticket: string;
    audience: "rpc" | "legacy";
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
