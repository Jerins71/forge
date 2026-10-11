import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { loadConfiguredSqliteDatabaseConstructor } from "../../../sqlite-database-loader.js";
import { prepareControlDatabase } from "../database.js";
import { createEventSink } from "../event-sink.js";
import { loadState, rebuildLifecycleProjections } from "./store.js";
import type { CoreCommand } from "./types.js";
import { piProviderCapabilities } from "../../../swarm/runtime/pi/pi-provider-adapter.js";
import type { RecoverySnapshot } from "@forge/protocol/environment-v2";

const roots: string[] = []; const databases: Database[] = [];
afterEach(async () => { for (const db of databases) if (db.open) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function database() {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-kernel-store-")); roots.push(root);
  const Constructor = await loadConfiguredSqliteDatabaseConstructor();
  const db = new Constructor(path.join(root, "control.sqlite")); databases.push(db);
  return db;
}
const now = 1_800_000_000_000;
function initialize(db: Database) { return prepareControlDatabase(db, { environmentId: "fixture", streamEpoch: "fixture" }); }

async function recoveryFixture() {
  const db = await database(); await initialize(db);
  let serial = 0;
  const sink = createEventSink(db, () => now, () => `fact-${++serial}`);
  const published: RecoverySnapshot[] = [];
  sink.subscribe(event => {
    if (event.event.type === "recovery.upsert") {
      expect(db.inTransaction).toBe(false);
      published.push(event.event.recovery);
    }
  });
  const commit = (command: CoreCommand) => sink.transaction(tx => sink.commitCommand(tx, command));
  const start = (threadId: string, runId: string) => {
    if (!loadState(db).threads[threadId]) commit({ type: "thread.create", commandId: `create-${threadId}`, now, threadId, projectId: "project", role: threadId === "manager" ? "manager" : "worker", managerId: threadId === "manager" ? undefined : "manager" });
    commit({ type: "run.submit", commandId: runId, now, threadId, runId, inputId: `input-${runId}`, attemptId: `attempt-${runId}`, bindingId: `binding-${runId}`, input: { text: runId, artifactIds: [] }, delivery: "queue" });
    commit({ type: "input.recorded", commandId: `record-${runId}`, now, threadId, inputId: `input-${runId}`, entryId: `entry-${runId}` });
    dispatch(runId);
  };
  const dispatch = (runId: string) => {
    const attempt = loadState(db).attempts[loadState(db).runs[runId].activeAttemptId];
    const { threadId, bindingId, generation, attemptId } = attempt;
    const scope = { threadId, bindingId, generation };
    commit({ type: "binding.acquired", commandId: `acquire-${attemptId}`, now, threadId, binding: { scope, conversation: { ...scope, kind: "conversation", nativeId: "native" }, capabilities: piProviderCapabilities(), instructionRevision: "prompt", toolContractRevision: "tools" } });
    commit({ type: "attempt.dispatch", commandId: `dispatch-${attemptId}`, now, threadId, attemptId, authorized: true });
  };
  const crash = (id: string, reports: RecoverySnapshot["undeliveredReports"]) => commit({ type: "environment.recover", commandId: id, now, recoveryId: id, bootId: id, reports });
  const resolve = (action: "resume" | "dismiss") => {
    const state = loadState(db); const recoveryId = state.recovery!.recoveryId;
    const attempts = Object.fromEntries(Object.values(state.runs).filter(run => run.state === "recovery").map(run => [run.runId, `retry-${run.runId}-${recoveryId}`]));
    const bindingIds = Object.fromEntries(Object.keys(state.threads).map(id => [id, `replacement-${id}-${recoveryId}`]));
    return commit(action === "resume" ? { type: "recovery.resume", commandId: `resolve-${recoveryId}`, now, recoveryId, attempts, bindingIds } : { type: "recovery.dismiss", commandId: `resolve-${recoveryId}`, now, recoveryId });
  };
  const finish = (runId: string) => {
    const state = loadState(db); const run = state.runs[runId]; const attempt = state.attempts[run.activeAttemptId]; const binding = state.bindings[attempt.bindingId];
    return commit({ type: "provider.observe", commandId: `finish-${attempt.attemptId}`, now, observation: { type: "terminal", scope: binding.scope, attemptId: attempt.attemptId, sequence: 1, origin: { kind: "root", conversation: binding.conversation }, terminalAuthority: "root_attempt", outcome: "completed" } });
  };
  return { db, published, start, dispatch, crash, resolve, commit, finish };
}

async function resultRecoveryFixture(boundary: "pending" | "unknown" | "unsubmitted") {
  const f = await recoveryFixture(); f.start("manager", "parent");
  for (const id of ["one", "two"]) {
    f.commit({ type: "thread.create", commandId: `worker-${id}`, now, threadId: id, projectId: "project", role: "worker", managerId: "manager" });
    f.commit({ type: "worker.assign", commandId: `assign-${id}`, now, assignmentId: id, parentThreadId: "manager", parentRunId: "parent", workerThreadId: id, workerRunId: `worker-run-${id}`, inputId: `worker-input-${id}`, attemptId: `worker-attempt-${id}`, bindingId: `worker-binding-${id}`, input: { text: id, artifactIds: [] }, authorized: true, selection: { specialistId: "builder", provider: "codex", modelId: "fixture" } });
    f.commit({ type: "input.recorded", commandId: `record-worker-${id}`, now, threadId: id, inputId: `worker-input-${id}`, entryId: `worker-input-entry-${id}` }); f.dispatch(`worker-run-${id}`); f.finish(`worker-run-${id}`);
  }
  if (boundary === "unsubmitted") {
    f.finish("parent"); f.commit({ type: "thread.stop", commandId: "stop-parent", now, threadId: "manager" });
    for (const owner of Object.values(loadState(f.db).threads)) if (owner.bindingId) f.commit({ type: "binding.drained", commandId: `drain-${owner.threadId}`, now, threadId: owner.threadId, bindingId: owner.bindingId, status: "clean" });
  }
  for (const id of ["one", "two"]) {
    f.commit({ type: "worker.result", commandId: `result-${id}`, now, assignmentId: id, workerRunId: `worker-run-${id}`, resultRef: { threadId: id, runId: `worker-run-${id}`, entryId: `worker-final-${id}` }, input: { text: `result-${id}`, artifactIds: [] } });
    if (boundary !== "unsubmitted") f.commit({ type: "input.recorded", commandId: `record-result-${id}`, now, threadId: "manager", inputId: `${id}:result:input`, entryId: `result-entry-${id}` });
  }
  if (boundary === "unknown") { f.finish("parent"); f.dispatch("one:result:run"); }
  const reports = ["one", "two"].map(id => ({ deliveryId: `${id}:result`, fromAgentId: id, toAgentId: "manager", assignmentId: id }));
  f.crash("first-crash", reports.slice(0, 1)); f.crash("second-crash", reports.slice(1));
  expect(loadState(f.db).recovery?.undeliveredReports).toEqual(reports);
  return f;
}

describe("retained lifecycle commit", () => {
  it.each(["pending", "unknown", "unsubmitted"] as const)("dismisses the union of %s result transfers without losing canonical results or delivering later", async boundary => {
    const f = await resultRecoveryFixture(boundary); const references = Object.values(loadState(f.db).assignments).map(assignment => assignment.resultRef);
    f.resolve("dismiss");
    for (const id of ["one", "two"]) {
      expect(loadState(f.db).transfers[`${id}:result`].state).toBe("superseded");
      if (boundary === "unsubmitted") expect(loadState(f.db).runs[`${id}:result:run`]).toBeUndefined();
      else expect(loadState(f.db).runs[`${id}:result:run`].state).toBe("terminal");
      expect(f.commit({ type: "assignment.deliver", commandId: `late-${id}`, now, assignmentId: id, authorized: true }).effects).toEqual([]);
    }
    expect(Object.values(loadState(f.db).assignments).map(assignment => assignment.resultRef)).toEqual(references);
    f.crash("third-crash", []); expect(loadState(f.db).recovery?.dismissedAt).toBeTruthy();
    const before = loadState(f.db); rebuildLifecycleProjections(f.db); expect(loadState(f.db)).toEqual(before);
  });
  it.each(["pending", "unknown", "unsubmitted"] as const)("resumes the union of %s result transfers in the new generation and consumes each exactly once", async boundary => {
    const f = await resultRecoveryFixture(boundary); f.resolve("resume");
    expect(f.resolve("resume").effects).toEqual([]);
    if (boundary === "pending") { f.dispatch("parent"); f.finish("parent"); }
    for (const id of ["one", "two"]) {
      if (boundary === "unsubmitted") {
        f.commit({ type: "assignment.deliver", commandId: `deliver-${id}`, now, assignmentId: id, authorized: true });
        f.commit({ type: "input.recorded", commandId: `record-result-${id}`, now, threadId: "manager", inputId: `${id}:result:input`, entryId: `result-entry-${id}` });
      }
      const state = loadState(f.db); const run = state.runs[`${id}:result:run`]; const attemptId = run.activeAttemptId;
      expect(state.assignments[id].parentGeneration).toBe(state.threads.manager.generation);
      expect(state.transfers[`${id}:result`]).toMatchObject({ state: "pending", targetGeneration: state.threads.manager.generation, ...(boundary === "unsubmitted" ? {} : { consumingAttemptId: attemptId }) });
      f.dispatch(run.runId);
      f.commit({ type: "attempt.accepted", commandId: `accepted-${id}`, now, threadId: "manager", attemptId, turn: { ...loadState(f.db).bindings[loadState(f.db).attempts[attemptId].bindingId].scope, kind: "turn", conversationId: "native", nativeId: id } });
      f.finish(run.runId);
      expect(loadState(f.db).transfers[`${id}:result`]).toMatchObject({ state: "consumed", consumingAttemptId: attemptId });
      expect(f.commit({ type: "assignment.deliver", commandId: `duplicate-${id}`, now, assignmentId: id, authorized: true }).effects).toEqual([]);
    }
    expect(Object.values(loadState(f.db).runs).filter(run => run.runId.endsWith(":result:run"))).toHaveLength(2);
    f.crash("third-crash", []); expect(loadState(f.db).recovery?.resumedAt).toBeTruthy();
    const before = loadState(f.db); rebuildLifecycleProjections(f.db); expect(loadState(f.db)).toEqual(before);
  });
  it.each(["resume", "dismiss"] as const)("publishes a new recovery occurrence after %s and retains it on restart", async action => {
    const f = await recoveryFixture(); f.start("manager", "first-run"); f.crash("first-crash", []);
    f.resolve(action);
    if (action === "resume") f.dispatch("first-run"); else f.start("manager", "second-run");
    f.crash("second-crash", []);
    const second = loadState(f.db).recovery!;
    expect(second).toMatchObject({ recoveryId: "second-crash", bootId: "second-crash", interruptedManagers: ["manager"] });
    expect(second.resumedAt).toBeUndefined(); expect(second.dismissedAt).toBeUndefined();
    expect(f.published.at(-1)).toEqual(second);
    f.db.close(); const Constructor = await loadConfiguredSqliteDatabaseConstructor();
    const reopened = new Constructor(f.db.name); databases.push(reopened); await initialize(reopened); rebuildLifecycleProjections(reopened);
    expect(loadState(reopened).recovery).toEqual(second);
  });
  it.each(["resume", "dismiss"] as const)("unions consecutive unacknowledged crashes and %s settles the whole occurrence", async action => {
    const f = await recoveryFixture(); const report = (id: string) => ({ deliveryId: id, fromAgentId: "worker", toAgentId: "manager" });
    f.start("manager", "manager-run"); f.crash("first-crash", [report("report-one")]);
    f.start("worker", "worker-run"); f.crash("second-crash", [report("report-one"), report("report-two")]);
    const union = loadState(f.db).recovery!;
    expect(union).toMatchObject({ recoveryId: "first-crash", interruptedManagers: ["manager"], interruptedWorkers: ["worker"], undeliveredReports: [report("report-one"), report("report-two")] });
    expect(f.published.at(-1)).toEqual(union);
    const decision = f.resolve(action); const resolved = loadState(f.db);
    expect(Object.values(resolved.runs).some(run => run.state === "recovery")).toBe(false);
    expect(resolved.recovery?.[action === "resume" ? "resumedAt" : "dismissedAt"]).toBeTruthy();
    if (action === "resume") expect(decision.effects.filter(effect => effect.kind === "recovery.deliver")).toEqual(union.undeliveredReports.map(report => ({ kind: "recovery.deliver", threadId: "manager", deliveryId: report.deliveryId, recoveryId: union.recoveryId })));
    else expect(Object.values(resolved.runs).map(run => run.outcome)).toEqual(["dismissed", "dismissed"]);
    rebuildLifecycleProjections(f.db); expect(loadState(f.db)).toEqual(resolved);
  });
  it("commits facts, projection and outbox together and publishes only after the commit", async () => {
    const db = await database(); await initialize(db);
    let id = 0; const sink = createEventSink(db, () => now, () => `id-${++id}`);
    const observed: boolean[] = [];
    sink.subscribe(() => observed.push(!db.inTransaction && loadState(db).runs.run.inputId === "input"));
    sink.transaction(tx => {
      db.prepare("INSERT INTO commands VALUES ('00000000-0000-4000-8000-000000000001','device','session.send','hash','{}','thread',?)").run(now);
      db.prepare("INSERT INTO command_receipts VALUES ('00000000-0000-4000-8000-000000000001','accepted',0,0,?)").run(JSON.stringify({ commandId: "00000000-0000-4000-8000-000000000001", method: "session.send", sessionId: "thread", state: "accepted", acceptedSequence: 0, updatedSequence: 0, acceptedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), inputId: "input", delivery: "pending", error: null }));
      sink.commitCommand(tx, { type: "thread.create", commandId: "00000000-0000-4000-8000-000000000001", now, threadId: "thread", role: "manager", projectId: "project" });
      sink.commitCommand(tx, { type: "run.submit", commandId: "00000000-0000-4000-8000-000000000001", now, threadId: "thread", runId: "run", inputId: "input", attemptId: "attempt", bindingId: "binding", delivery: "queue", input: { text: "fixture", artifactIds: [] } });
      sink.updateReceipt(tx, "00000000-0000-4000-8000-000000000001", {});
    });
    expect(observed).toEqual([true]);
    expect((db.prepare("SELECT kind FROM effects").all())).toEqual([{ kind: "runtime.acquire" }, { kind: "transcript.append" }]);
    expect(db.prepare("SELECT COUNT(*) n FROM lifecycle_events").get()).toEqual({ n: 4 });
    const before = loadState(db); sink.close(); db.close();
    const Constructor = await loadConfiguredSqliteDatabaseConstructor(); const reopened = new Constructor(db.name); databases.push(reopened); await initialize(reopened);
    rebuildLifecycleProjections(reopened);
    expect(loadState(reopened)).toEqual(before);
  });
  it("rolls back retained facts and outbox if a later write fails, without publishing", async () => {
    const db = await database(); await initialize(db);
    const sink = createEventSink(db, () => now, () => "id"); let published = 0; sink.subscribe(() => published++);
    expect(() => sink.transaction(tx => {
      sink.commitCommand(tx, { type: "thread.create", commandId: "00000000-0000-4000-8000-000000000001", now, threadId: "thread", role: "manager", projectId: "project" });
      throw new Error("fixture rollback");
    })).toThrow("fixture rollback");
    expect(loadState(db).threads).toEqual({}); expect(db.prepare("SELECT COUNT(*) n FROM lifecycle_events").get()).toEqual({ n: 0 }); expect(published).toBe(0);
  });
  it("retains lifecycle events independently of the bounded stream journal", async () => {
    const db = await database(); await initialize(db);
    const sink = createEventSink(db, () => now, () => "id");
    sink.transaction(tx => sink.commitCommand(tx, { type: "thread.create", commandId: "00000000-0000-4000-8000-000000000001", now, threadId: "thread", role: "manager", projectId: "project" }));
    db.prepare("DELETE FROM events").run(); rebuildLifecycleProjections(db);
    expect(loadState(db).threads.thread.threadId).toBe("thread");
  });
  it("rejects a previous v3 schema missing the authoritative assignment projections without repairing it", async () => {
    const db = await database(); await initialize(db);
    db.exec("DROP TABLE orchestration_transfers; DROP TABLE orchestration_assignments");
    await expect(initialize(db)).rejects.toThrow(/incompatible/i);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('orchestration_assignments','orchestration_transfers')").all()).toEqual([]);
  });
  it("rejects a declared-current database with a required table missing and preserves its retained facts", async () => {
    const db = await database(); await initialize(db);
    const sink = createEventSink(db, () => now, () => "retained");
    sink.transaction(tx => sink.commitCommand(tx, { type: "thread.create", commandId: "retained", now, threadId: "retained-thread", role: "manager", projectId: "project" }));
    const meta = db.prepare("SELECT * FROM environment_meta").get();
    const facts = db.prepare("SELECT * FROM lifecycle_events").all();
    db.exec("DROP TABLE orchestration_run_inputs");
    const schema = db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    await expect(initialize(db)).rejects.toThrow(/incompatible/i);
    expect(db.prepare("SELECT * FROM environment_meta").get()).toEqual(meta);
    expect(db.prepare("SELECT * FROM lifecycle_events").all()).toEqual(facts);
    expect(db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
  });
  it("rejects an incompatible database without creating tables or importing files", async () => {
    const db = await database(); db.exec("CREATE TABLE environment_meta (singleton INTEGER PRIMARY KEY, schema_version INTEGER); INSERT INTO environment_meta VALUES (1,2)");
    await expect(initialize(db)).rejects.toThrow(/incompatible/i);
    expect(db.prepare("SELECT schema_version FROM environment_meta").get()).toEqual({ schema_version: 2 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: "environment_meta" }]);
  });
});
