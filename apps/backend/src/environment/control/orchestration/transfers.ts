import type { CoreState, LifecycleEvent } from "./types.js";

/** Phase 5 extends the kinds/strategies; worker transfers carry canonical content references. */
export interface TransferPoint { threadId: string; runId: string; entryId?: string }
export interface WorkerTransfer {
  transferId: string;
  assignmentId: string;
  kind: "worker_input" | "worker_result";
  source: TransferPoint;
  targetThreadId: string;
  targetGeneration: number;
  targetRunId: string;
  strategy: "canonical_input";
  state: "pending" | "dispatch_marked" | "consumed" | "unknown" | "superseded";
  createdAt: number;
  consumingAttemptId?: string;
  consumedAt?: number;
}
export type TransferEvent = {
  type: "transfer.created" | "transfer.dispatch_marked" | "transfer.consumed" | "transfer.unknown" | "transfer.superseded";
  transfer: WorkerTransfer;
};

/** Delivery certainty is derived only from the consuming core attempt, never descriptor status. */
export function reconcileTransfer(state: CoreState, transfer: WorkerTransfer, commandId: string, at: number): LifecycleEvent | undefined {
  if (["consumed", "superseded"].includes(transfer.state)) return;
  const run = state.runs[transfer.targetRunId];
  const attempt = run && state.attempts[run.activeAttemptId];
  if (!attempt || transfer.state === "unknown" && attempt.attemptId !== transfer.consumingAttemptId) return;
  if (attempt.delivery === "dispatched") return { type: "transfer.consumed", transfer: { ...transfer, state: "consumed", consumingAttemptId: attempt.attemptId, consumedAt: at }, commandId, at };
  if (attempt.delivery === "unknown" && transfer.state !== "unknown") return { type: "transfer.unknown", transfer: { ...transfer, state: "unknown", consumingAttemptId: attempt.attemptId }, commandId, at };
  if (attempt.state === "dispatching" && transfer.state === "pending") return { type: "transfer.dispatch_marked", transfer: { ...transfer, state: "dispatch_marked", consumingAttemptId: attempt.attemptId }, commandId, at };
  // A confirmed pre-dispatch cancellation cannot become a delivered result.
  if (run.state === "terminal" && transfer.state === "pending") return { type: "transfer.superseded", transfer: { ...transfer, state: "superseded" }, commandId, at };
}
