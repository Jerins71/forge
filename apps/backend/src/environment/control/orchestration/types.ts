import type { AssignmentCommand, AssignmentEvent, AssignmentEffect, WorkerAssignment } from "./assignments.js";
import type { Transfer, TransferCommand, LineageEvent } from "./transfers.js";
import type { ProviderObservation, ProviderRequestLifetime, ProviderRequestRef, ProviderTurnRef } from "@forge/protocol";
import type { RecoverySnapshot } from "@forge/protocol/environment-v2";
import type { ProviderBinding } from "../../../swarm/runtime/provider-contract.js";
import type { RpcInput } from "@forge/protocol/environment-v2";

export interface Thread {
  threadId: string;
  role: "manager" | "worker";
  projectId: string;
  model?: import("../../../swarm/types.js").AgentDescriptor["model"];
  lineage?: import("@forge/protocol/environment-v2").ThreadLineage;
  managerId?: string;
  desired: "running" | "stopped";
  generation: number;
  shutdown: "clean" | "pending" | "quarantined";
  bindingId?: string;
  activeRunId?: string;
  nextRunSequence: number;
  compaction?: { attemptId: string; state: "pending" | "running" };
}
export interface Run {
  runId: string;
  threadId: string;
  commandId: string;
  inputId: string;
  input: RpcInput<"session.send">["message"];
  source?: import("../../../swarm/types.js").MessageSourceContext;
  delivery: "queue" | "steer";
  /** The turn's replies never reach the transcript, as for an internal bootstrap delivery. */
  outputHidden?: boolean;
  sequence: number;
  state: "queued" | "running" | "terminal" | "recovery";
  activeAttemptId: string;
  entryId?: string;
  fallbackCount?: number;
  outcome?: "completed" | "interrupted" | "cancelled" | "failed" | "dismissed";
}
export interface Attempt {
  attemptId: string;
  runId: string;
  threadId: string;
  bindingId: string;
  generation: number;
  state: "created" | "dispatching" | "accepted" | "terminal" | "unknown";
  delivery: "pending" | "dispatched" | "unknown";
  lastSequence: number;
  turn?: ProviderTurnRef;
  outcome?: Run["outcome"];
}
export interface Request {
  requestId: string;
  threadId: string;
  attemptId: string;
  ref: ProviderRequestRef;
  lifetime: ProviderRequestLifetime;
  kind: "approval" | "user_input";
  state: "pending" | "responding" | "resolved" | "expired" | "cancelled";
  payload: unknown;
  /** The user's answer, kept once it is sent to the provider so the settled choice can show it. */
  response?: unknown;
}
export interface CoreState {
  threads: Record<string, Thread>;
  runs: Record<string, Run>;
  attempts: Record<string, Attempt>;
  bindings: Record<string, ProviderBinding>;
  requests: Record<string, Request>;
  recovery: RecoverySnapshot | null;
  handoffs: Record<string, import("@forge/protocol/environment-v2").ContextHandoff>;
  assignments: Record<string, WorkerAssignment>;
  transfers: Record<string, Transfer>;
}
type Envelope = { commandId: string; now: number };
export type CoreCommand = Envelope & (
  | TransferCommand
  | AssignmentCommand
  | { type: "thread.prepare_binding"; threadId:string; bindingId:string }
  | { type: "thread.create"; threadId: string; role: Thread["role"]; projectId: string; managerId?: string; model?: Thread["model"] }
  | { type: "thread.stop"; threadId: string; writerPending?: boolean; retain?: boolean; terminateChildren?: boolean }
  | { type: "thread.resume"; threadId: string }
  | { type: "run.submit"; threadId: string; runId: string; inputId: string; attemptId: string; bindingId: string; input: Run["input"]; source?: Run["source"]; delivery: Run["delivery"]; outputHidden?: boolean }
  | { type:"run.cancel"; threadId:string; runId:string }
  | { type: "input.recorded"; threadId: string; inputId: string; entryId: string }
  | { type: "binding.acquired"; threadId: string; binding: ProviderBinding }
  | { type: "binding.drained"; threadId: string; bindingId: string; status: "clean" | "pending" }
  | { type: "attempt.dispatch"; threadId: string; attemptId: string; authorized: boolean; targetAttemptId?: string }
  | { type: "attempt.accepted"; threadId: string; attemptId: string; turn: ProviderTurnRef }
  | { type: "attempt.unknown"; threadId: string; attemptId: string }
  | { type: "provider.observe"; observation: ProviderObservation }
  | { type: "request.respond"; threadId: string; requestId: string; response: unknown }
  | { type: "request.cancel" | "request.expire" | "request.responded"; threadId: string; requestId: string }
  | { type: "thread.compact"; threadId: string; attemptId: string; instructions?: string }
  | { type: "compaction.completed"; threadId: string; attemptId: string; succeeded: boolean }
  | { type: "environment.recover"; recoveryId: string; bootId: string; reports: RecoverySnapshot["undeliveredReports"] }
  | { type: "recovery.resume"; recoveryId: string; attempts: Record<string, string>; bindingIds: Record<string, string> }
  | { type: "recovery.dismiss"; recoveryId: string }
  | { type: "effect.failed"; threadId: string; attemptId?: string; requestId?: string; kind: CoreEffect["kind"]; delivery: "not_dispatched" | "unknown"; steerTargetEnded?: boolean; steerUnsupported?: boolean; bindingClosed?: boolean }
);
export type LifecycleEvent = { commandId: string; at: number } & (
  | LineageEvent
  | AssignmentEvent
  | { type: "thread.created" | "thread.stopped" | "thread.resumed" | "thread.changed" | "compaction.requested" | "compaction.completed" | "compaction.failed"; thread: Thread }
  | { type: "input.accepted" | "input.recorded" | "run.started" | "run.terminal" | "run.recovery"; run: Run }
  | { type: "attempt.created" | "attempt.dispatch_marked" | "attempt.accepted" | "attempt.terminal" | "attempt.unknown" | "attempt.observed"; attempt: Attempt }
  | { type: "binding.acquired"; binding: ProviderBinding }
  | { type: "request.opened" | "request.responding" | "request.resolved" | "request.expired" | "request.cancelled"; request: Request }
  | { type: "recovery.required" | "recovery.resolved"; recovery: RecoverySnapshot }
);
export type CoreEffect =
  | AssignmentEffect
  | { kind: "transcript.append"; threadId: string; inputId: string; runId: string }
  | { kind: "runtime.acquire"; threadId: string; bindingId: string; generation: number }
  | { kind: "provider.start"; threadId: string; attemptId: string }
  | { kind: "provider.steer"; threadId: string; attemptId: string; targetAttemptId: string }
  | { kind: "provider.respond"; threadId: string; requestId: string; response: unknown }
  | { kind: "provider.decline"; threadId: string; requestId: string }
  | { kind: "provider.release"; threadId: string; bindingId: string; /** The user stopped the session while a turn was running. */ stoppedTurn?: boolean }
  | { kind: "provider.compact"; threadId: string; attemptId: string; instructions?: string }
  | { kind: "recovery.deliver"; threadId: string; recoveryId: string; deliveryId: string };
export interface Decision { events: LifecycleEvent[]; effects: CoreEffect[]; }
