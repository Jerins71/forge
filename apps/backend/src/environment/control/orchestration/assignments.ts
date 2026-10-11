import type { WorkerParentContext } from "../../../swarm/types.js";
import { decide, evolve } from "./kernel.js";
import { reconcileTransfer, isLineageTransfer, type TransferEvent, type TransferPoint, type WorkerTransfer } from "./transfers.js";
import type { CoreCommand, CoreState, Decision, LifecycleEvent, Run } from "./types.js";

export interface AssignmentSelection {
  specialistId?: string;
  rosterId?: string;
  rosterRevision?: number;
  routeId?: string;
  provider: string;
  modelId: string;
  /** Ordered, preflighted availability/capacity/security facts; no I/O in policy. */
  candidates?: { provider: string; modelId: string; available: boolean }[];
  maxConcurrent?: number;
}
export interface WorkerAssignment {
  assignmentId: string;
  parentThreadId: string;
  parentRunId: string;
  parentGeneration: number;
  workerThreadId: string;
  workerRunId: string;
  selection: Omit<AssignmentSelection, "candidates" | "maxConcurrent">;
  planStep?: { planId: string; stepId: string };
  state: "assigned" | "running" | "terminal" | "cancelled";
  assignedAt: number;
  terminalAt?: number;
  outcome?: Run["outcome"];
  inputTransferId: string;
  resultTransferId?: string;
  resultRef?: TransferPoint;
  resultInput?: Run["input"];
  parentContext?: WorkerParentContext;
  invalidatedAt?: number;
}
export type AssignmentCommand =
  | { type: "worker.assign"; assignmentId: string; parentThreadId: string; parentRunId: string; workerThreadId: string; workerRunId: string; inputId: string; attemptId: string; bindingId: string; input: Run["input"]; authorized: boolean; selection: AssignmentSelection; planStep?: WorkerAssignment["planStep"]; parentContext?: Pick<WorkerParentContext, "outputTarget" | "rootTurnId" | "parentRootTurnId"> }
  | { type: "worker.stop"; threadId: string; managerId: string; authorized: boolean }
  | { type: "worker.result"; assignmentId: string; workerRunId: string; resultRef: TransferPoint; input: Run["input"] }
  | { type: "assignment.deliver"; assignmentId: string; authorized: boolean }
  | { type: "assignments.clear"; threadId: string; authorized: boolean };
export type AssignmentEvent =
  | { type: "assignment.created" | "assignment.started" | "assignment.terminal" | "assignment.cancelled" | "assignment.result_recorded" | "assignment.invalidated"; assignment: WorkerAssignment }
  | TransferEvent;
export type AssignmentEffect = { kind: "assignment.result.extract"; threadId: string; assignmentId: string; workerRunId: string };

export function evolveAssignment(state: CoreState, event: AssignmentEvent): CoreState {
  if ("assignment" in event) return { ...state, assignments: { ...state.assignments, [event.assignment.assignmentId]: event.assignment } };
  return { ...state, transfers: { ...state.transfers, [event.transfer.transferId]: event.transfer } };
}
export function findWorkerAssignment(state: CoreState, threadId: string): WorkerAssignment | undefined {
  return Object.values(state.assignments).filter(a => a.workerThreadId === threadId && a.invalidatedAt === undefined)
    .sort((a, b) => (state.runs[b.workerRunId]?.sequence ?? -1) - (state.runs[a.workerRunId]?.sequence ?? -1))[0];
}
export function matchAssignmentPlanStep(assignment: WorkerAssignment, planId: string, stepId: string): boolean {
  return assignment.invalidatedAt === undefined && assignment.planStep?.planId === planId && assignment.planStep.stepId === stepId;
}
function chooseSelection(state: CoreState, command: Extract<CoreCommand, { type: "worker.assign" }>): WorkerAssignment["selection"] {
  const { candidates, maxConcurrent, ...selection } = command.selection;
  if (maxConcurrent !== undefined) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("Invalid specialist concurrency limit");
    const current = Object.values(state.assignments).filter(a => a.parentThreadId === command.parentThreadId && a.selection.specialistId === selection.specialistId && ["assigned", "running"].includes(a.state) && a.invalidatedAt === undefined);
    if (current.length >= maxConcurrent) throw new Error("Specialist concurrency limit reached");
  }
  if (!candidates) return selection;
  const selected = candidates.find(candidate => candidate.available);
  if (!selected) throw new Error("No eligible specialist model or fallback");
  return { ...selection, provider: selected.provider, modelId: selected.modelId };
}

/** Assignment policy composes existing thread/run decisions; it never sends provider input. */
export function decideAssignment(initial: CoreState, command: CoreCommand & AssignmentCommand): Decision {
  let state = initial;
  const decision: Decision = { events: [], effects: [] };
  const emit = (fact: AssignmentEvent) => {
    const event = { ...fact, commandId: command.commandId, at: command.now } as LifecycleEvent;
    state = evolve(state, event); decision.events.push(event);
  };
  const apply = (nested: CoreCommand) => {
    const next = decide(state, nested);
    for (const event of next.events) state = evolve(state, event);
    decision.events.push(...next.events); decision.effects.push(...next.effects);
  };
  const deliver = (assignment: WorkerAssignment) => {
    const transfer = state.transfers[assignment.resultTransferId ?? ""];
    const parent = state.threads[assignment.parentThreadId];
    if (!transfer || isLineageTransfer(transfer) || transfer.state !== "pending" || !assignment.resultInput || assignment.invalidatedAt !== undefined ||
      !parent || parent.desired !== "running" || parent.shutdown !== "clean" || parent.generation !== assignment.parentGeneration || state.runs[transfer.targetRunId]) return;
    apply({ type: "run.submit", commandId: command.commandId, now: command.now, threadId: parent.threadId,
      runId: transfer.targetRunId, inputId: `${assignment.assignmentId}:result:input`, attemptId: `${assignment.assignmentId}:result:attempt`,
      bindingId: parent.bindingId ?? `${assignment.assignmentId}:result:binding`, delivery: "queue", input: assignment.resultInput });
  };
  switch (command.type) {
    case "worker.assign": {
      const prior = state.assignments[command.assignmentId];
      if (prior) {
        if (prior.parentThreadId !== command.parentThreadId || prior.parentRunId !== command.parentRunId || prior.workerThreadId !== command.workerThreadId || prior.workerRunId !== command.workerRunId) throw new Error("Assignment identity conflicts");
        return decision;
      }
      const parent = state.threads[command.parentThreadId]; const parentRun = state.runs[command.parentRunId];
      const worker = state.threads[command.workerThreadId];
      if (!command.authorized || !parent || parent.role !== "manager" || parent.desired !== "running" || parent.shutdown !== "clean" || parent.activeRunId !== command.parentRunId || parentRun?.state !== "running") throw new Error("Assignment requires an authorized active parent run");
      if (!worker || worker.role !== "worker" || worker.managerId !== parent.threadId || worker.projectId !== parent.projectId) throw new Error("Assignment worker owner conflicts");
      if (Object.values(state.assignments).some(a => a.workerThreadId === worker.threadId && ["assigned", "running"].includes(a.state) && a.invalidatedAt === undefined)) throw new Error("Worker already has an active assignment");
      if (state.runs[command.workerRunId] || state.attempts[command.attemptId] || Object.values(state.runs).some(r => r.inputId === command.inputId)) throw new Error("Assignment run identity conflicts");
      const assignment: WorkerAssignment = { assignmentId: command.assignmentId, parentThreadId: parent.threadId, parentRunId: parentRun.runId, parentGeneration: parent.generation,
        workerThreadId: worker.threadId, workerRunId: command.workerRunId, selection: chooseSelection(state, command), planStep: command.planStep,
        state: "assigned", assignedAt: command.now, ...(command.parentContext ? { parentContext: { ...command.parentContext, schemaVersion: 1 as const, managerId: parent.threadId, assignmentId: command.assignmentId, assignedAt: new Date(command.now).toISOString() } } : {}), inputTransferId: `${command.assignmentId}:input` };
      emit({ type: "assignment.created", assignment });
      emit({ type: "transfer.created", transfer: { transferId: assignment.inputTransferId, assignmentId: assignment.assignmentId, kind: "worker_input",
        source: { threadId: parent.threadId, runId: parentRun.runId, entryId: parentRun.entryId }, targetThreadId: worker.threadId, targetGeneration: worker.generation,
        targetRunId: command.workerRunId, strategy: "canonical_input", state: "pending", createdAt: command.now } });
      apply({ type: "run.submit", commandId: command.commandId, now: command.now, threadId: worker.threadId, runId: command.workerRunId, inputId: command.inputId,
        attemptId: command.attemptId, bindingId: command.bindingId, input: command.input, delivery: "queue" });
      break;
    }
    case "worker.stop": {
      const worker = state.threads[command.threadId]; const manager = state.threads[command.managerId];
      if (!command.authorized || !manager || manager.role !== "manager" || !worker || worker.role !== "worker" || worker.managerId !== manager.threadId) throw new Error("Authorized worker owner required");
      for (const assignment of Object.values(state.assignments)) if (assignment.workerThreadId === worker.threadId && ["assigned", "running"].includes(assignment.state))
        emit({ type: "assignment.cancelled", assignment: { ...assignment, state: "cancelled", terminalAt: command.now, outcome: "cancelled" } });
      apply({ type: "thread.stop", commandId: command.commandId, now: command.now, threadId: worker.threadId });
      break;
    }
    case "worker.result": {
      const assignment = state.assignments[command.assignmentId];
      if (!assignment || assignment.workerRunId !== command.workerRunId || command.resultRef.threadId !== assignment.workerThreadId || command.resultRef.runId !== assignment.workerRunId || !command.resultRef.entryId) throw new Error("Worker result source conflicts");
      if (assignment.resultRef) {
        if (assignment.resultRef.entryId !== command.resultRef.entryId) throw new Error("Worker result identity conflicts");
        return decision;
      }
      if (state.runs[assignment.workerRunId]?.state !== "terminal") throw new Error("Worker result requires a terminal core run");
      const recorded = { ...assignment, resultRef: command.resultRef, resultInput: command.input, resultTransferId: `${assignment.assignmentId}:result` };
      emit({ type: "assignment.result_recorded", assignment: recorded });
      const transfer: WorkerTransfer = { transferId: recorded.resultTransferId, assignmentId: assignment.assignmentId, kind: "worker_result", source: command.resultRef,
        targetThreadId: assignment.parentThreadId, targetGeneration: assignment.parentGeneration, targetRunId: `${assignment.assignmentId}:result:run`, strategy: "canonical_input",
        state: assignment.invalidatedAt !== undefined ? "superseded" : "pending", createdAt: command.now };
      emit({ type: transfer.state === "superseded" ? "transfer.superseded" : "transfer.created", transfer });
      deliver(recorded); break;
    }
    case "assignment.deliver": {
      if (!command.authorized) throw new Error("Authorized result delivery required");
      const assignment = state.assignments[command.assignmentId];
      if (!assignment) throw new Error("Unknown assignment");
      deliver(assignment); break;
    }
    case "assignments.clear": {
      if (!command.authorized) throw new Error("Authorized assignment clear required");
      for (const assignment of Object.values(state.assignments)) if (assignment.parentThreadId === command.threadId && assignment.invalidatedAt === undefined) {
        emit({ type: "assignment.invalidated", assignment: { ...assignment, invalidatedAt: command.now } });
        for (const transfer of Object.values(state.transfers)) if (!isLineageTransfer(transfer) && transfer.assignmentId === assignment.assignmentId && !["consumed", "unknown", "superseded"].includes(transfer.state)) {
          // Possibly delivered input remains unknown; clearing cannot assert it was never received.
          emit({ type: transfer.state === "dispatch_marked" ? "transfer.unknown" : "transfer.superseded", transfer: { ...transfer, state: transfer.state === "dispatch_marked" ? "unknown" : "superseded" } });
        }
      }
      break;
    }
  }
  return decision;
}

/** Runs and attempts are authoritative. Apply their committed decision to assignment/transfer facts. */
export function reconcileAssignments(initial: CoreState, command: CoreCommand, decision: Decision): Decision {
  let state = decision.events.reduce(evolve, initial);
  const emit = (fact: AssignmentEvent) => {
    const event = { ...fact, commandId: command.commandId, at: command.now } as LifecycleEvent;
    state = evolve(state, event); decision.events.push(event);
  };
  for (const assignment of Object.values(state.assignments)) {
    const workerRun = state.runs[assignment.workerRunId];
    if (!workerRun || assignment.invalidatedAt !== undefined || ["terminal", "cancelled"].includes(assignment.state)) continue;
    if (workerRun.state === "running" && assignment.state === "assigned") emit({ type: "assignment.started", assignment: { ...assignment, state: "running" } });
    if (workerRun.state === "terminal") {
      emit({ type: "assignment.terminal", assignment: { ...assignment, state: "terminal", terminalAt: command.now, outcome: workerRun.outcome } });
      decision.effects.push({ kind: "assignment.result.extract", threadId: assignment.workerThreadId, assignmentId: assignment.assignmentId, workerRunId: assignment.workerRunId });
    }
  }
  for (const transfer of Object.values(state.transfers)) {
    const event = reconcileTransfer(state, transfer, command.commandId, command.now);
    if (event) { state = evolve(state, event); decision.events.push(event); }
  }
  return decision;
}
