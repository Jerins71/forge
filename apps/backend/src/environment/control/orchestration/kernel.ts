import { decideTransfer, isTransferCommand, reconcileBindingCoverage } from "./transfers.js";
import { decideAssignment, evolveAssignment, reconcileAssignments } from "./assignments.js";
import type { ProviderObservation } from "@forge/protocol";
import type { CoreCommand, CoreState, Decision, LifecycleEvent, Run } from "./types.js";

export function emptyState(): CoreState {
  return { threads: {}, runs: {}, attempts: {}, bindings: {}, requests: {}, assignments: {}, transfers: {}, handoffs: {}, recovery: null };
}
/** The reducer is shared by live projection and retained-event replay. */
export function evolve(state: CoreState, event: LifecycleEvent): CoreState {
  if ("thread" in event) return { ...state, threads: { ...state.threads, [event.thread.threadId]: event.thread } };
  if ("run" in event) return { ...state, runs: { ...state.runs, [event.run.runId]: event.run } };
  if ("attempt" in event) return { ...state, attempts: { ...state.attempts, [event.attempt.attemptId]: event.attempt } };
  if ("binding" in event) return { ...state, bindings: { ...state.bindings, [event.binding.scope.bindingId]: event.binding } };
  if ("request" in event) return { ...state, requests: { ...state.requests, [event.request.requestId]: event.request } };
  if ("handoff" in event) return { ...state, handoffs: { ...state.handoffs, [event.handoff.handoffId]: event.handoff } };
  if ("assignment" in event || "transfer" in event) return evolveAssignment(state, event);
  return { ...state, recovery: event.recovery };
}

/** All time, identities, authorization and facts enter as values. No I/O or ambient state. */
export function decide(initial: CoreState, command: CoreCommand): Decision {
  let state = initial;
  const decision: Decision = { events: [], effects: [] };
  type Fact = LifecycleEvent extends infer E ? E extends LifecycleEvent ? Omit<E, "commandId" | "at"> : never : never;
  const emit = (fact: Fact) => {
    const event = { ...fact, commandId: command.commandId, at: command.now } as LifecycleEvent;
    decision.events.push(event); state = evolve(state, event);
  };
  const thread = (id: string) => {
    const value = state.threads[id]; if (!value) throw new Error("Unknown orchestration thread"); return value;
  };
  const finish = (run: Run, outcome: NonNullable<Run["outcome"]>, delivered = false) => {
    const attempt = state.attempts[run.activeAttemptId];
    emit({ type: "attempt.terminal", attempt: { ...attempt, state: "terminal", outcome, delivery: attempt.state === "dispatching" && delivered ? "dispatched" : attempt.delivery } });
    emit({ type: "run.terminal", run: { ...run, state: "terminal", outcome } });
    for (const request of Object.values(state.requests)) if (request.attemptId === attempt.attemptId && ["pending", "responding"].includes(request.state))
      emit({ type: "request.expired", request: { ...request, state: "expired" } });
    const owner = thread(run.threadId);
    if (owner.activeRunId === run.runId) emit({ type: "thread.changed", thread: { ...owner, activeRunId: undefined } });
  };
  const advance = (id: string) => {
    const owner = thread(id);
    if (owner.desired !== "running" || owner.shutdown !== "clean" || owner.activeRunId || owner.compaction) return;
    const next = Object.values(state.runs).filter(r => r.threadId === id && r.state === "queued").sort((a, b) => a.sequence - b.sequence)[0];
    if (!next?.entryId) return;
    const attempt = state.attempts[next.activeAttemptId];
    emit({ type: "run.started", run: { ...next, state: "running" } });
    emit({ type: "thread.changed", thread: { ...owner, activeRunId: next.runId, bindingId: attempt.bindingId } });
    if (state.bindings[attempt.bindingId]?.scope.generation !== owner.generation)
      decision.effects.push({ kind: "runtime.acquire", threadId: id, bindingId: attempt.bindingId, generation: owner.generation });
    else decision.effects.push({ kind: "provider.start", threadId: id, attemptId: attempt.attemptId });
  };
  const requireRecovery = (attemptId: string) => {
    const attempt = state.attempts[attemptId]; if (!attempt || attempt.state === "terminal") return;
    const run = state.runs[attempt.runId];
    emit({ type: "attempt.unknown", attempt: { ...attempt, state: "unknown", delivery: "unknown" } });
    emit({ type: "run.recovery", run: { ...run, state: "recovery" } });
  };
  const recover = (recoveryId: string, bootId: string, reports: NonNullable<CoreState["recovery"]>["undeliveredReports"], processLost: boolean) => {
    const pending = state.recovery && !state.recovery.resumedAt && !state.recovery.dismissedAt ? state.recovery : null;
    const managers = new Set(pending?.interruptedManagers); const workers = new Set(pending?.interruptedWorkers);
    for (const run of Object.values(state.runs)) {
      if (!["running", "recovery"].includes(run.state)) continue;
      const owner = thread(run.threadId); const attempt = state.attempts[run.activeAttemptId];
      if (attempt.state === "created") {
        if (processLost) {
          emit({ type: "run.started", run: { ...run, state: "queued" } });
          emit({ type: "thread.changed", thread: { ...owner, activeRunId: undefined } });
        }
        continue;
      }
      requireRecovery(attempt.attemptId);
      (owner.role === "manager" ? managers : workers).add(owner.threadId);
    }
    if (processLost) for (const owner of Object.values(state.threads)) {
      // The process boundary proves old writers are gone. In-process failures require drain.
      const nextBindingId = `binding:${command.commandId}:${owner.threadId}`;
      emit({ type: "thread.changed", thread: { ...owner, generation: owner.generation + 1, bindingId: nextBindingId, shutdown: "clean", compaction: undefined } });
      for (const attempt of Object.values(state.attempts)) if (attempt.threadId === owner.threadId && attempt.state === "created") emit({ type: "attempt.created", attempt: { ...attempt, generation: owner.generation + 1, bindingId: nextBindingId } });
    }
    const deliveries = new Map((pending?.undeliveredReports ?? []).map(r => [r.deliveryId, r]));
    for (const report of reports) deliveries.set(report.deliveryId, report);
    if (managers.size || workers.size || deliveries.size) emit({ type: "recovery.required", recovery: {
      ...(pending ?? { recoveryId, bootId, createdAt: new Date(command.now).toISOString() }),
      interruptedManagers: [...managers].sort(), interruptedWorkers: [...workers].sort(),
      undeliveredReports: [...deliveries.values()].sort((a, b) => a.deliveryId.localeCompare(b.deliveryId)),
    } });
    for (const request of Object.values(state.requests)) if (["pending", "responding"].includes(request.state))
      emit({ type: "request.expired", request: { ...request, state: "expired" } });
  };
  const observe = (observation: ProviderObservation) => {
    const owner = state.threads[observation.scope.threadId]; const attempt = state.attempts[observation.attemptId];
    if (!owner || !attempt || owner.generation !== observation.scope.generation || attempt.generation !== owner.generation ||
      attempt.bindingId !== observation.scope.bindingId || attempt.threadId !== owner.threadId || observation.sequence <= attempt.lastSequence || attempt.state === "terminal") return;
    emit({ type: "attempt.observed", attempt: { ...attempt, lastSequence: observation.sequence } });
    const run = state.runs[attempt.runId];
    if (observation.type === "request_opened") {
      if (observation.lifetime.generation !== owner.generation || observation.request.bindingId !== attempt.bindingId || observation.request.generation !== owner.generation) return;
      const requestId = `${attempt.bindingId}:${owner.generation}:${observation.request.nativeId}`;
      const prior = state.requests[requestId]; if (prior && prior.state !== "expired") return;
      emit({ type: "request.opened", request: { requestId, threadId: owner.threadId, attemptId: attempt.attemptId, ref: observation.request, lifetime: observation.lifetime, kind: observation.requestKind, state: "pending", payload: observation.payload } });
    } else if (observation.type === "request_resolved") {
      const request = state.requests[`${attempt.bindingId}:${owner.generation}:${observation.request.nativeId}`];
      if (request) emit({ type: observation.resolution === "expired" ? "request.expired" : "request.resolved", request: { ...request, state: observation.resolution === "expired" ? "expired" : "resolved" } });
    } else if (observation.origin.kind !== "root" || owner.activeRunId !== run.runId || run.activeAttemptId !== attempt.attemptId) { /* This observation has no root terminal authority. */ }
    else if (observation.type === "accepted") emit({ type: "attempt.accepted", attempt: { ...state.attempts[attempt.attemptId], state: "accepted", delivery: "dispatched", turn: observation.turn } });
    else if (observation.type === "terminal" && observation.terminalAuthority === "root_attempt") { finish(state.runs[run.runId], observation.outcome,true); advance(owner.threadId); }
    else if (observation.type === "error") {
      if (observation.delivery === "unknown") { requireRecovery(attempt.attemptId); recover(`recovery-${command.commandId}`, command.commandId, [], false); }
      else { finish(state.runs[run.runId], "failed",observation.delivery === "accepted"); advance(owner.threadId); }
    }
  };

  switch (command.type) {
    case "thread.create":
      if (state.threads[command.threadId]) break;
      emit({ type: "thread.created", thread: { threadId: command.threadId, role: command.role, projectId: command.projectId, model: command.model, managerId: command.managerId, desired: "running", generation: 0, shutdown: "clean", nextRunSequence: 0 } }); break;
    case "run.submit": {
      const owner = thread(command.threadId);
      if (owner.desired !== "running" || owner.shutdown !== "clean") throw new Error("Thread shutdown must be confirmed before input admission");
      if (Object.values(state.runs).some(run => run.inputId === command.inputId)) break;
      emit({ type: "input.accepted", run: { runId: command.runId, threadId: command.threadId, inputId: command.inputId, input: command.input, source: command.source, delivery: command.delivery, commandId: command.commandId, state: "queued", sequence: owner.nextRunSequence, activeAttemptId: command.attemptId } });
      emit({ type: "attempt.created", attempt: { attemptId: command.attemptId, runId: command.runId, threadId: owner.threadId, bindingId: owner.bindingId ?? command.bindingId, generation: owner.generation, state: "created", delivery: "pending", lastSequence: -1 } });
      emit({ type: "thread.changed", thread: { ...owner, bindingId: owner.bindingId ?? command.bindingId, nextRunSequence: owner.nextRunSequence + 1 } });
      decision.effects.push({ kind: "transcript.append", threadId: owner.threadId, inputId: command.inputId, runId: command.runId });
      if (command.delivery === "steer" && owner.activeRunId) {
        const active = state.attempts[state.runs[owner.activeRunId].activeAttemptId];
        if (active.turn && !active.interruptRequested) {
          emit({ type: "attempt.interrupted", attempt: { ...active, interruptRequested: true } });
          decision.effects.push({ kind: "provider.interrupt", threadId: owner.threadId, attemptId: active.attemptId });
        }
      }
      break;
    }
    case "run.cancel": {
      const run=state.runs[command.runId];
      if (run?.threadId === command.threadId && state.attempts[run.activeAttemptId].state === "created") { finish(run,"cancelled"); advance(run.threadId); }
      break;
    }
    case "input.recorded": {
      const run = Object.values(state.runs).find(r => r.inputId === command.inputId && r.threadId === command.threadId);
      if (!run) throw new Error("Unknown canonical input");
      if (run.entryId && run.entryId !== command.entryId) throw new Error("Canonical input identity conflicts");
      if (!run.entryId) emit({ type: "input.recorded", run: { ...run, entryId: command.entryId } });
      advance(command.threadId); break;
    }
    case "binding.acquired": {
      const owner = thread(command.threadId); const scope = command.binding.scope;
      if (scope.generation !== owner.generation || scope.threadId !== owner.threadId || scope.bindingId !== owner.bindingId) break;
      emit({ type: "binding.acquired", binding: command.binding });
      const active = owner.activeRunId && state.runs[owner.activeRunId];
      if (active && state.attempts[active.activeAttemptId].state === "created") decision.effects.push({ kind: "provider.start", threadId: owner.threadId, attemptId: active.activeAttemptId }); break;
    }
    case "attempt.dispatch": {
      const attempt = state.attempts[command.attemptId]; if (!attempt || attempt.state !== "created") break;
      const owner = thread(command.threadId); const run = state.runs[attempt.runId];
      if (!command.authorized || owner.desired !== "running" || owner.shutdown !== "clean" || owner.generation !== attempt.generation || owner.activeRunId !== run.runId) {
        finish(run, "cancelled"); advance(owner.threadId); break;
      }
      if (!run.entryId || !state.bindings[attempt.bindingId]) throw new Error("Dispatch requires canonical input and acquired binding");
      emit({ type: "attempt.dispatch_marked", attempt: { ...attempt, state: "dispatching" } }); break;
    }
    case "attempt.accepted": {
      const attempt = state.attempts[command.attemptId]; const owner = thread(command.threadId);
      if (!attempt || attempt.state === "terminal" || owner.generation !== attempt.generation || owner.activeRunId !== attempt.runId) break;
      emit({ type: "attempt.accepted", attempt: { ...attempt, state: "accepted", delivery: "dispatched", turn: command.turn } }); break;
    }
    case "attempt.unknown": requireRecovery(command.attemptId); recover(`recovery-${command.commandId}`, command.commandId, [], false); break;
    case "attempt.interrupt_acknowledged": {
      const attempt = state.attempts[command.attemptId]; if (attempt && attempt.state !== "terminal") emit({ type: "attempt.interrupted", attempt: { ...attempt, interruptAcknowledged: true } }); break;
    }
    case "provider.observe": observe(command.observation); break;
    case "thread.stop": {
      const owner = thread(command.threadId);
      emit({ type: "thread.stopped", thread: { ...owner, desired: "stopped", shutdown: owner.bindingId ? "pending" : "clean" } });
      for (const run of Object.values(state.runs)) if (run.threadId === owner.threadId && run.state === "queued") finish(run, "cancelled");
      if (owner.bindingId) decision.effects.push({ kind: "provider.release", threadId: owner.threadId, bindingId: owner.bindingId }); break;
    }
    case "binding.drained": {
      const owner = thread(command.threadId); if (owner.bindingId !== command.bindingId) break;
      emit({ type: "thread.changed", thread: { ...owner, shutdown: command.status === "clean" ? "clean" : "quarantined", ...(command.status === "clean" ? { bindingId: undefined, activeRunId: undefined } : {}) } });
      if (command.status === "clean" && owner.activeRunId && owner.desired === "stopped") finish(state.runs[owner.activeRunId], "cancelled");
      if(command.status === "clean" && owner.desired === "running") advance(owner.threadId); break;
    }
    case "thread.resume": {
      const owner = thread(command.threadId); if (owner.shutdown !== "clean") throw new Error("Thread shutdown remains quarantined");
      if (owner.desired === "running") break;
      emit({ type: "thread.resumed", thread: { ...owner, desired: "running", generation: owner.generation + 1, bindingId: undefined } }); advance(owner.threadId); break;
    }
    case "request.respond": {
      const request = state.requests[command.requestId]; const owner = thread(command.threadId);
      if (!request || request.threadId !== owner.threadId || request.state !== "pending") throw new Error("Request is no longer pending");
      const expires = request.lifetime.expiresAt;
      if (request.lifetime.generation !== owner.generation || owner.desired !== "running" || (expires && Date.parse(expires) <= command.now)) {
        emit({ type: "request.expired", request: { ...request, state: "expired" } }); break;
      }
      emit({ type: "request.responding", request: { ...request, state: "responding" } });
      decision.effects.push({ kind: "provider.respond", threadId: owner.threadId, requestId: request.requestId, response: command.response }); break;
    }
    case "request.cancel": case "request.responded": {
      const request = state.requests[command.requestId]; if (!request || request.threadId !== command.threadId || !["pending", "responding"].includes(request.state)) break;
      emit({ type: command.type === "request.cancel" ? "request.cancelled" : "request.resolved", request: { ...request, state: command.type === "request.cancel" ? "cancelled" : "resolved" } }); break;
    }
    case "thread.compact": {
      const owner = thread(command.threadId); if (owner.activeRunId || owner.compaction || owner.shutdown !== "clean" || !owner.bindingId) throw new Error("Compaction requires an idle acquired thread");
      emit({ type: "compaction.requested", thread: { ...owner, compaction: { attemptId: command.attemptId, state: "running" } } });
      decision.effects.push({ kind: "provider.compact", threadId: owner.threadId, attemptId: command.attemptId, instructions: command.instructions }); break;
    }
    case "compaction.completed": {
      const owner = thread(command.threadId); if (owner.compaction?.attemptId !== command.attemptId) break;
      emit({ type: command.succeeded ? "compaction.completed" : "compaction.failed", thread: { ...owner, compaction: undefined } }); advance(owner.threadId); break;
    }
    case "environment.recover": recover(command.recoveryId, command.bootId, command.reports, true); break;
    case "recovery.resume": case "recovery.dismiss": {
      const snapshot = state.recovery;
      if (!snapshot || snapshot.recoveryId !== command.recoveryId || snapshot.resumedAt || snapshot.dismissedAt) break;
      for (const run of Object.values(state.runs)) if (run.state === "recovery") {
        const owner = thread(run.threadId);
        if (command.type === "recovery.dismiss") finish(run, "dismissed");
        else {
          if (owner.shutdown !== "clean") throw new Error("Recovery requires confirmed writer shutdown");
          const attemptId = command.attempts[run.runId]; const bindingId = command.bindingIds[owner.threadId];
          if (!attemptId || !bindingId) throw new Error("Explicit recovery requires new attempt and binding identities");
          emit({ type: "attempt.created", attempt: { attemptId, runId: run.runId, threadId: owner.threadId, bindingId, generation: owner.generation, state: "created", delivery: "pending", lastSequence: -1 } });
          emit({ type: "run.started", run: { ...run, state: "queued", activeAttemptId: attemptId } });
          emit({ type: "thread.changed", thread: { ...owner, activeRunId: undefined, bindingId: undefined } });
        }
      }
      if (command.type === "recovery.resume") for (const report of snapshot.undeliveredReports) decision.effects.push({ kind: "recovery.deliver", threadId: report.toAgentId, deliveryId: report.deliveryId, recoveryId: snapshot.recoveryId });
      emit({ type: "recovery.resolved", recovery: { ...snapshot, [command.type === "recovery.resume" ? "resumedAt" : "dismissedAt"]: new Date(command.now).toISOString() } });
      for (const owner of Object.values(state.threads)) advance(owner.threadId); break;
    }
    case "effect.failed": {
      if (command.attemptId && state.attempts[command.attemptId]) {
        const attempt = state.attempts[command.attemptId];
        if (attempt.state === "terminal") break;
        if (command.delivery === "unknown") { requireRecovery(attempt.attemptId); recover(`recovery-${command.commandId}`, command.commandId, [], false); }
        else { finish(state.runs[attempt.runId], "failed"); advance(command.threadId); }
      } else if (command.kind === "provider.release") {
        const owner = thread(command.threadId); emit({ type: "thread.changed", thread: { ...owner, shutdown: "quarantined" } });
      } break;
    }
    default: return isTransferCommand(command) ? decideTransfer(state, command) : decideAssignment(state, command);
  }
  return reconcileBindingCoverage(initial, command, reconcileAssignments(initial, command, decision));
}
