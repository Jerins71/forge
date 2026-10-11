import type { AssignmentSelection, WorkerAssignment } from "../environment/control/orchestration/assignments.js";
import type { PlanStepAssignment } from "./planning/plan-usage-tracker.js";
import type { RuntimeUserMessage } from "./runtime-contracts.js";
import type { AgentDescriptor, ConversationAttachment, RequestedDeliveryMode, SendMessageReceipt, WorkerParentContext } from "./types.js";
import type { InboundTurnContextInput } from "./turn-context-coordinator.js";

/** Internal command ingress supplied by the environment's existing core owner. */
export interface CoreAgentMessagePort {
  /**
   * Admit worker assignments and ordinary agent input through core run.submit.
   * Persist the canonical input/attachments and this presentation metadata with
   * the accepted runId before waking the outbox. Never mint a separate turnId.
   * A scoped call identity replays its durable receipt rather than admitting twice.
   * Resolve roster/capacity/security before the acceptance transaction; the pure
   * assignment decision rechecks ownership and concurrent limits in that transaction.
   */
  submit(input: {
    sender: AgentDescriptor;
    target: AgentDescriptor;
    message: string | RuntimeUserMessage;
    attachments: ConversationAttachment[];
    delivery: RequestedDeliveryMode;
    call?: { agentId: string; toolCallId: string };
    planAssignment?: PlanStepAssignment;
    selection?: AssignmentSelection;
    requiresSecureRuntime?: boolean;
    parentContext?: Pick<WorkerParentContext, "outputTarget" | "rootTurnId" | "parentRootTurnId">;
    presentation: InboundTurnContextInput<unknown>;
  }): Promise<{ runId: string; receipt: SendMessageReceipt; assignment?: WorkerAssignment }>;
  /** Record/extract the canonical final for this exact terminal run, then worker.result. */
  recordWorkerResult(input: {
    workerAgentId: string;
    assignmentId: string;
    resultText: string;
  }): Promise<SendMessageReceipt>;
  /** Read the authoritative projection, including terminal assignments retained on reuse. */
  readAssignment(workerAgentId: string): WorkerAssignment | undefined;
  /** The user stopped a working worker: cancel what it was doing, so no result is reported for it. The worker stays resumable. */
  cancelWorkerAssignment(input: { managerId: string; workerId: string }): Promise<void>;
  /** Authorized user control remains available after a manager's root stops. */
  stopWorker(input: { managerId: string; workerId: string }): Promise<void>;
  /** Fence late results before resetting conversation content. No unknown delivery retries. */
  clearAssignments(managerId: string): Promise<void>;
}
