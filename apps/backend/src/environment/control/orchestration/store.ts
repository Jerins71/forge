import type { Database } from "better-sqlite3";
import { emptyState, evolve } from "./kernel.js";
import type { CoreState, LifecycleEvent } from "./types.js";

export function loadState(database: Database): CoreState {
  const state = emptyState();
  const entities = [
    ["threads", "orchestration_threads", "thread_id"], ["runs", "orchestration_runs", "run_id"],
    ["attempts", "orchestration_attempts", "attempt_id"], ["bindings", "orchestration_bindings", "binding_id"],
    ["requests", "orchestration_requests", "request_id"], ["handoffs", "orchestration_handoffs", "handoff_id"],
    ["assignments", "orchestration_assignments", "assignment_id"], ["transfers", "orchestration_transfers", "transfer_id"],
  ] as const;
  for (const [key, table, identity] of entities) for (const row of database.prepare(`SELECT ${identity} AS id,state_json FROM ${table}`).all() as { id: string; state_json: string }[]) {
    (state[key] as Record<string, unknown>)[row.id] = JSON.parse(row.state_json);
  }
  const recovery = database.prepare("SELECT snapshot_json FROM orchestration_recovery WHERE singleton=1").get() as { snapshot_json: string } | undefined;
  state.recovery = recovery ? JSON.parse(recovery.snapshot_json) : null;
  return state;
}

export function projectLifecycle(database: Database, event: LifecycleEvent): void {
  if ("thread" in event) database.prepare("INSERT INTO orchestration_threads VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET state_json=excluded.state_json").run(event.thread.threadId, JSON.stringify(event.thread));
  else if ("run" in event) {
    database.prepare("INSERT INTO orchestration_runs VALUES (?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET state_json=excluded.state_json").run(event.run.runId, event.run.threadId, event.run.inputId, JSON.stringify(event.run));
    if (event.type === "input.accepted") {
      const assignment = Object.values(loadState(database).assignments).find(candidate => `${candidate.assignmentId}:result:run` === event.run.runId);
      if (assignment?.resultPrepared) database.prepare("INSERT OR IGNORE INTO orchestration_run_inputs (run_id,prepared_json) VALUES (?,?)").run(event.run.runId, JSON.stringify(assignment.resultPrepared));
    }
  }
  else if ("attempt" in event) database.prepare("INSERT INTO orchestration_attempts VALUES (?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET state_json=excluded.state_json").run(event.attempt.attemptId, event.attempt.runId, event.attempt.threadId, JSON.stringify(event.attempt));
  else if ("binding" in event) database.prepare("INSERT INTO orchestration_bindings VALUES (?,?,?,?) ON CONFLICT(binding_id) DO UPDATE SET state_json=excluded.state_json").run(event.binding.scope.bindingId, event.binding.scope.threadId, event.binding.scope.generation, JSON.stringify(event.binding));
  else if ("request" in event) database.prepare("INSERT INTO orchestration_requests VALUES (?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET state_json=excluded.state_json").run(event.request.requestId, event.request.threadId, event.request.attemptId, JSON.stringify(event.request));
  else if ("handoff" in event) database.prepare("INSERT INTO orchestration_handoffs VALUES (?,?) ON CONFLICT(handoff_id) DO UPDATE SET state_json=excluded.state_json").run(event.handoff.handoffId, JSON.stringify(event.handoff));
  else if ("assignment" in event || "transfer" in event) {
    if ("assignment" in event) database.prepare("INSERT INTO orchestration_assignments VALUES (?,?,?,?,?) ON CONFLICT(assignment_id) DO UPDATE SET state_json=excluded.state_json").run(event.assignment.assignmentId, event.assignment.parentThreadId, event.assignment.parentRunId, event.assignment.workerThreadId, JSON.stringify(event.assignment));
    else database.prepare("INSERT INTO orchestration_transfers VALUES (?,?,?,?,?,?) ON CONFLICT(transfer_id) DO UPDATE SET state_json=excluded.state_json").run(event.transfer.transferId, "assignmentId" in event.transfer ? event.transfer.assignmentId : null, event.transfer.kind, event.transfer.source.threadId, event.transfer.targetThreadId, JSON.stringify(event.transfer));
  }
  else database.prepare("INSERT INTO orchestration_recovery VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET snapshot_json=excluded.snapshot_json").run(JSON.stringify(event.recovery));
}

/** Rebuild only projections. Receipts, external-effect markers and JSONL never replay. */
export function rebuildLifecycleProjections(database: Database): void {
  database.transaction(() => {
    for (const table of ["orchestration_threads", "orchestration_runs", "orchestration_attempts", "orchestration_bindings", "orchestration_requests", "orchestration_recovery", "orchestration_assignments", "orchestration_transfers", "orchestration_handoffs"]) database.prepare(`DELETE FROM ${table}`).run();
    for (const row of database.prepare("SELECT event_json FROM lifecycle_events ORDER BY sequence").all() as { event_json: string }[]) projectLifecycle(database, JSON.parse(row.event_json));
  }).immediate();
}

/** Replay is also useful to compare retained facts with current projections in evidence. */
export function replayLifecycle(database: Database): CoreState {
  let state = emptyState();
  for (const row of database.prepare("SELECT event_json FROM lifecycle_events ORDER BY sequence").all() as { event_json: string }[]) state = evolve(state, JSON.parse(row.event_json));
  return state;
}
