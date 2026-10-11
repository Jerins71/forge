import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, appendFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { loadConfiguredSqliteDatabaseConstructor } from "../../../sqlite-database-loader.js";
import { prepareControlDatabase } from "../database.js";
import { createEventSink } from "../event-sink.js";
import { loadState, replayLifecycle, rebuildLifecycleProjections } from "./store.js";
import type { CoreCommand } from "./types.js";
import { findWorkerAssignment, matchAssignmentPlanStep } from "./assignments.js";
import { piProviderCapabilities } from "../../../swarm/runtime/pi/pi-provider-adapter.js";
import { createReplayHarness, ReplaySignals, watchdog } from "../../../swarm/runtime/replay/replay-harness.js";

const now = 1_800_000_000_000;
const roots: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
/** `steer: false` is a provider that cannot take input mid-turn: results wait for the turn to end. */
async function fixture(options: { steer?: boolean } = {}) {
  const capabilities = { ...piProviderCapabilities(), native: { ...piProviderCapabilities().native, steer: options.steer ?? false } };
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-assign-")); roots.push(root);
  const Constructor = await loadConfiguredSqliteDatabaseConstructor();
  let db = new Constructor(path.join(root, "control.sqlite")); databases.push(db);
  await prepareControlDatabase(db, { environmentId: "assign", streamEpoch: "assign" });
  let id = 0;
  let sink = createEventSink(db, () => now, () => `event-${++id}`);
  const run = (command: CoreCommand) => sink.transaction(tx => sink.commitCommand(tx, command));
  const state = () => loadState(db);
  const create = (threadId: string, role: "manager" | "worker", managerId?: string) => run({ type: "thread.create", commandId: `create-${threadId}`, now, threadId, role, projectId: "project", managerId });
  const submit = (threadId: string, name: string) => run({ type: "run.submit", commandId: `submit-${name}`, now, threadId, runId: name, inputId: `input-${name}`, attemptId: `attempt-${name}`, bindingId: `binding-${threadId}`, input: { text: name, artifactIds: [] }, delivery: "queue" });
  const record = async (runId: string, crashBeforeLocator = false) => {
    const entry = state().runs[runId];
    const file = path.join(root, `${entry.threadId}.jsonl`);
    const entryId = `entry-${entry.inputId}`;
    const prior = await readFile(file, "utf8").catch(() => "");
    if (!prior.split("\n").some(line => line && JSON.parse(line).id === entryId)) await appendFile(file, JSON.stringify({ id: entryId, text: entry.input.text }) + "\n");
    if (!crashBeforeLocator) run({ type: "input.recorded", commandId: `record-${runId}`, now, threadId: entry.threadId, inputId: entry.inputId, entryId });
  };
  const ready = async (runId: string) => {
    await record(runId);
    const entry = state().runs[runId]; const attempt = state().attempts[entry.activeAttemptId];
    run({ type: "binding.acquired", commandId: `binding-${runId}`, now, threadId: entry.threadId, binding: { scope: { threadId: entry.threadId, bindingId: attempt.bindingId, generation: attempt.generation }, conversation: { threadId: entry.threadId, bindingId: attempt.bindingId, generation: attempt.generation, kind: "conversation", nativeId: `native-${entry.threadId}` }, capabilities, instructionRevision: "prompt", toolContractRevision: "tools" } });
  };
  const dispatch = (runId: string) => {
    const entry = state().runs[runId];
    return run({ type: "attempt.dispatch", commandId: `dispatch-${runId}`, now, threadId: entry.threadId, attemptId: entry.activeAttemptId, authorized: true });
  };
  const observe = (runId: string, type: "accepted" | "terminal") => {
    const entry = state().runs[runId]; const attempt = state().attempts[entry.activeAttemptId];
    const scope = { threadId: entry.threadId, bindingId: attempt.bindingId, generation: attempt.generation };
    return run({ type: "provider.observe", commandId: `${type}-${runId}`, now, observation: { scope, attemptId: attempt.attemptId, sequence: type === "accepted" ? 1 : 2, origin: { kind: "root", conversation: { ...scope, kind: "conversation", nativeId: `native-${entry.threadId}` } }, ...(type === "accepted" ? { type, turn: { ...scope, kind: "turn", conversationId: `native-${entry.threadId}`, nativeId: `turn-${runId}` } } : { type, terminalAuthority: "root_attempt", outcome: "completed" }) } });
  };
  const assign = (worker: string, assignmentId = worker, specialistId = "builder", planStep?: { planId: string; stepId: string }, limit = 2) => {
    if (!state().threads[worker]) create(worker, "worker", "manager");
    return run({ type: "worker.assign", commandId: `assign-${assignmentId}`, now, assignmentId, parentThreadId: "manager", parentRunId: state().threads.manager.activeRunId!, workerThreadId: worker, workerRunId: `run-${assignmentId}`, inputId: `input-${assignmentId}`, attemptId: `attempt-${assignmentId}`, bindingId: `binding-${worker}`, input: { text: "bounded assignment", artifactIds: [] }, authorized: true, selection: { specialistId, provider: "codex", modelId: "primary", candidates: [{ provider: "codex", modelId: "primary", available: true }, { provider: "claude", modelId: "fallback", available: true }], maxConcurrent: limit }, planStep });
  };
  const result = (assignmentId: string) => run({ type: "worker.result", commandId: `result-${assignmentId}`, now, assignmentId, workerRunId: `run-${assignmentId}`, resultRef: { threadId: state().assignments[assignmentId].workerThreadId, runId: `run-${assignmentId}`, entryId: `final-${assignmentId}` }, input: { text: "status: done\nsummary: result fixture", artifactIds: [] } });
  const boot = async (name: string) => {
    sink.close(); db.close(); db = new Constructor(path.join(root, "control.sqlite")); databases.push(db);
    await prepareControlDatabase(db, { environmentId: "assign", streamEpoch: "assign" });
    sink = createEventSink(db, () => now, () => `event-${++id}`);
    run({ type: "environment.recover", commandId: name, now, recoveryId: name, bootId: name, reports: [] });
    expect(replayLifecycle(db)).toEqual(state());
    const before = state(); rebuildLifecycleProjections(db); expect(state()).toEqual(before);
  };
  create("manager", "manager"); submit("manager", "parent"); await ready("parent"); dispatch("parent"); observe("parent", "accepted");
  return { root, run, state, assign, result, ready, record, dispatch, observe, boot, db: () => db };
}

describe("authoritative assignment replay", () => {
  it("delegates concurrent workers through replay and retains the parent root after child completion", async () => {
    const f = await fixture(); f.assign("one"); f.assign("two"); await f.ready("run-one"); await f.ready("run-two");
    const harness = await createReplayHarness(() => ({ provider: "codex", protocol: "jsonrpc", version: "fixture", scenario: "concurrent-assignment", provenance: "synthetic isolated fixture", entries: [
      { type: "expect_outbound", label: "start-one", frame: { method: "turn/start", params: { runId: "run-one" } } },
      { type: "emit_inbound", frame: { runId: "run-one", type: "accepted" } },
      { type: "expect_outbound", label: "start-two", frame: { method: "turn/start", params: { runId: "run-two" } } },
      { type: "emit_inbound", frame: { runId: "run-two", type: "accepted" } },
      { type: "emit_inbound", label: "child-completed", frame: { runId: "run-one", type: "terminal" } },
    ] }));
    const signal = new ReplaySignals<boolean>();
    const socket = createConnection({ host: "127.0.0.1", port: harness.port });
    createInterface({ input: socket }).on("line", line => {
      const { frame } = JSON.parse(line);
      if (!frame) return;
      f.observe(frame.runId, frame.type); signal.observe(`${frame.runId}:${frame.type}`, true);
    });
    try {
      await new Promise<void>(resolve => socket.once("connect", resolve)); socket.write(JSON.stringify({ hello: true, bindings: {} }) + "\n");
      for (const name of ["one", "two"]) { f.dispatch(`run-${name}`); socket.write(JSON.stringify({ frame: { method: "turn/start", params: { runId: `run-${name}` } } }) + "\n"); await watchdog("acceptance", signal.wait(`run-${name}:accepted`)); }
      await watchdog("terminal barrier", harness.signals.wait("1:child-completed:held")); harness.release("1:child-completed");
      await watchdog("child terminal", signal.wait("run-one:terminal"));
      expect(f.state().runs.parent.state).toBe("running"); expect(f.state().runs["run-two"].state).toBe("running");
      expect(f.state().assignments.one.state).toBe("terminal"); expect(f.state().transfers["one:input"].state).toBe("consumed");
      expect(harness.failures).toEqual([]);
      const evidenceDir = path.resolve("../../.internal/core/evidence"); await mkdir(evidenceDir, { recursive: true });
      await writeFile(path.join(evidenceDir, "assignments-replay.json"), JSON.stringify({ trace: harness.trace, parent: f.state().runs.parent.state, assignments: f.state().assignments, rerun: "pnpm --dir apps/backend exec vitest run src/environment/control/orchestration/assignments.replay.integration.test.ts" }, null, 2));
    } finally { socket.destroy(); await harness.close(); }
  });
  it("allows authorized control to stop a stopped manager's worker and denies a foreign owner", async () => {
    const f = await fixture(); f.assign("one"); await f.ready("run-one"); f.dispatch("run-one"); f.observe("run-one", "accepted");
    f.run({ type: "thread.stop", commandId: "stop-parent", now, threadId: "manager" });
    expect(() => f.run({ type: "worker.stop", commandId: "foreign", now, threadId: "one", managerId: "foreign", authorized: true })).toThrow(/owner/i);
    f.run({ type: "worker.stop", commandId: "stop-one", now, threadId: "one", managerId: "manager", authorized: true });
    expect(f.state().threads.one.desired).toBe("stopped"); expect(f.state().assignments.one.state).toBe("cancelled");
  });
  // Failure cases: the manager is never told its worker was stopped and waits for a result forever; the
  // stop is reported as an ordinary blocked result; the stop also stops the worker's thread, so it cannot
  // be resumed; a foreign owner can mark another manager's worker.
  it("marks a user-stopped worker's assignment and still reports its end to the manager, without stopping the worker", async () => {
    const f = await fixture(); f.assign("one"); await f.ready("run-one"); f.dispatch("run-one"); f.observe("run-one", "accepted");
    expect(() => f.run({ type: "worker.stopped_by_user", commandId: "foreign", now, threadId: "one", managerId: "foreign", authorized: true })).toThrow(/owner/i);
    f.run({ type: "worker.stopped_by_user", commandId: "stop-one", now, threadId: "one", managerId: "manager", authorized: true });
    expect(f.state().assignments.one).toMatchObject({ state: "running", stoppedByUser: true }); expect(f.state().threads.one.desired).toBe("running");
    // The runtime then goes away and the run ends: the manager is owed a result saying the worker was stopped.
    const ended = f.observe("run-one", "terminal");
    expect(ended.effects.map(effect => effect.kind)).toContain("assignment.result.extract");
    expect(f.state().assignments.one).toMatchObject({ state: "terminal", stoppedByUser: true });
    f.result("one");
    expect(f.state().transfers["one:result"]).toMatchObject({ kind: "worker_result", targetThreadId: "manager" });
    expect(f.state().transfers["one:result"].state).not.toBe("superseded");
    // The manager may be waiting inside its turn: the result reaches that turn instead of queueing behind it.
    expect(f.state().runs["one:result:run"]).toMatchObject({ threadId: "manager", delivery: "steer" });
  });
  // Failure cases: a manager waiting inside its turn never sees its worker's result, because the result
  // queues behind that turn; a provider that cannot steer loses the result instead of taking it after the turn.
  it("steers a worker result into the manager's running turn, and queues it when the provider cannot steer or the turn has ended", async () => {
    const f = await fixture({ steer: true });
    f.assign("one"); await f.ready("run-one"); f.dispatch("run-one"); f.observe("run-one", "accepted"); f.observe("run-one", "terminal");
    f.result("one");
    const resultRun = "one:result:run";
    expect(f.state().runs[resultRun]).toMatchObject({ threadId: "manager", delivery: "steer" });
    // The manager's turn is still running: the recorded result is steered into it.
    expect(f.state().runs.parent.state).toBe("running");
    await f.record(resultRun);
    expect(f.state().runs[resultRun].state).toBe("running");
    const steers = () => f.db().prepare("SELECT payload_json FROM effects WHERE kind='provider.steer'").all().map((row: any) => JSON.parse(row.payload_json));
    const attemptId = f.state().runs[resultRun].activeAttemptId;
    expect(steers()).toEqual([expect.objectContaining({ threadId: "manager", attemptId, targetAttemptId: f.state().runs.parent.activeAttemptId })]);

    // The turn ended before the steer reached it: the result is kept and becomes the manager's next input.
    f.observe("parent", "terminal");
    f.run({ type: "effect.failed", commandId: "stale-steer", now, threadId: "manager", attemptId, kind: "provider.steer", delivery: "not_dispatched", steerTargetEnded: true });
    expect(f.state().runs[resultRun]).toMatchObject({ state: "running", delivery: "queue" });
    expect(f.state().threads.manager.activeRunId).toBe(resultRun);
    expect(f.state().transfers["one:result"].state).not.toBe("superseded");
    f.dispatch(resultRun); f.observe(resultRun, "accepted");
    expect(f.state().transfers["one:result"].state).toBe("consumed");

    // A provider that cannot steer: the result waits as the manager's next input.
    const plain = await fixture(); plain.assign("one"); await plain.ready("run-one"); plain.dispatch("run-one"); plain.observe("run-one", "accepted"); plain.observe("run-one", "terminal");
    plain.result("one"); await plain.record(resultRun);
    expect(plain.state().runs[resultRun]).toMatchObject({ state: "queued", delivery: "steer" });
    expect(plain.db().prepare("SELECT COUNT(*) n FROM effects WHERE kind='provider.steer'").get()).toEqual({ n: 0 });
  });
  it("creates a fresh assignment on reuse, matches plan identity, and delivers duplicate results once", async () => {
    const f = await fixture(); f.assign("one", "first", "builder", { planId: "plan", stepId: "step" }); await f.ready("run-first"); f.dispatch("run-first"); f.observe("run-first", "accepted"); f.observe("run-first", "terminal");
    f.result("first"); f.result("first");
    const resultRun = "first:result:run"; await f.ready(resultRun);
    expect(f.state().runs[resultRun].state).toBe("queued"); // parent still live
    f.observe("parent", "terminal"); f.dispatch(resultRun); f.observe(resultRun, "accepted");
    expect(f.state().transfers["first:result"].state).toBe("consumed");
    expect(Object.values(f.state().runs).filter(r => r.runId === resultRun)).toHaveLength(1);
    expect(matchAssignmentPlanStep(f.state().assignments.first, "plan", "step")).toBe(true);
    expect(matchAssignmentPlanStep(f.state().assignments.first, "other-plan", "step")).toBe(false);
    f.assign("one", "second"); expect(findWorkerAssignment(f.state(), "one")?.assignmentId).toBe("second");
    expect(f.result("first").effects).toEqual([]); expect(f.state().assignments.second.state).toBe("assigned");
    expect(replayLifecycle(f.db())).toEqual(f.state());
  });
  it.each(["before_append", "after_append", "before_acceptance", "after_acceptance"] as const)("preserves honest transfer state across %s and two boots", async boundary => {
    const f = await fixture(); f.assign("one"); await f.ready("run-one"); f.dispatch("run-one"); f.observe("run-one", "accepted"); f.observe("run-one", "terminal"); f.result("one");
    const resultRun = "one:result:run";
    if (boundary === "after_append") await f.record(resultRun, true);
    if (["before_acceptance", "after_acceptance"].includes(boundary)) { await f.ready(resultRun); f.observe("parent", "terminal"); f.dispatch(resultRun); }
    if (boundary === "after_acceptance") f.observe(resultRun, "accepted");
    await f.boot("boot-one"); await f.boot("boot-two");
    const expected = boundary === "before_acceptance" ? "unknown" : boundary === "after_acceptance" ? "consumed" : "pending";
    expect(f.state().transfers["one:result"].state).toBe(expected);
    expect(f.result("one").effects).toEqual([]);
    if (expected === "pending") { await f.record(resultRun); const lines = (await readFile(path.join(f.root, "manager.jsonl"), "utf8")).trim().split("\n"); expect(lines.filter(line => JSON.parse(line).id === "entry-one:result:input")).toHaveLength(1); }
    if (expected === "unknown") expect(f.state().attempts["one:result:attempt"].delivery).toBe("unknown");
  });
  it.each(["provider-switch", "fallback"])("delivers a worker result once after the parent %s changes generation twice", async change => {
    const f = await fixture(); f.assign("one"); await f.ready("run-one"); f.dispatch("run-one"); f.observe("run-one", "accepted");
    f.observe("parent", "terminal");
    for (let index = 0; index < 2; index++) {
      const owner = f.state().threads.manager;
      if (!owner.bindingId) f.run({ type: "thread.prepare_binding", commandId: `prepare-${index}`, now, threadId: "manager", bindingId: `switched-${index}` });
      f.run({ type: "binding.drained", commandId: `model-drain-${index}`, now, threadId: "manager", bindingId: f.state().threads.manager.bindingId!, status: "clean" });
    }
    const owner = f.state().threads.manager; const scope = { threadId: "manager", bindingId: change, generation: owner.generation };
    f.run({ type: "thread.prepare_binding", commandId: "prepare-model", now, threadId: "manager", bindingId: scope.bindingId });
    f.run({ type: "binding.acquired", commandId: "model-acquired", now, threadId: "manager", binding: { scope, conversation: { ...scope, kind: "conversation", nativeId: change }, capabilities: { ...piProviderCapabilities(), provider: change === "provider-switch" ? "claude" : "codex" }, instructionRevision: change, toolContractRevision: "tools" } });
    expect(f.state().threads.manager.generation).toBe(2); expect(f.state().assignments.one.parentGeneration).toBe(0);
    f.observe("run-one", "terminal"); const delivery = f.result("one"); const resultRun = "one:result:run";
    expect(f.state().runs[resultRun]).toBeDefined(); expect(delivery.effects.map(effect => effect.kind)).toContain("transcript.append");
    expect(f.state().assignments.one.parentGeneration).toBe(2); expect(f.state().transfers["one:result"].targetGeneration).toBe(2);
    await f.record(resultRun); f.dispatch(resultRun); f.observe(resultRun, "accepted");
    expect(f.state().transfers["one:result"]).toMatchObject({ state: "consumed", consumingAttemptId: f.state().runs[resultRun].activeAttemptId });
    expect(f.run({ type: "assignment.deliver", commandId: "duplicate-delivery", now, assignmentId: "one", authorized: true }).effects).toEqual([]);
    expect(f.result("one").effects).toEqual([]); expect(Object.values(f.state().runs).filter(run => run.runId === resultRun)).toHaveLength(1);
    expect(replayLifecycle(f.db())).toEqual(f.state());
  });
  it("queues a worker report during a provider drain and delivers it once in-process after binding.drained", async () => {
    const f = await fixture(); f.assign("one"); await f.ready("run-one"); f.dispatch("run-one"); f.observe("run-one", "accepted"); f.observe("parent", "terminal");
    f.run({ type: "transfer.create", commandId: "switch", now, transferId: "switch", kind: "provider_switch", source: { threadId: "manager", runId: "parent", sequence: 0, entryId: f.state().runs.parent.entryId }, targetThreadId: "manager", targetModel: { provider: "claude", modelId: "claude-sonnet-4-6", thinkingLevel: "high" }, authorized: true });
    expect(f.state().threads.manager.shutdown).toBe("pending");
    f.observe("run-one", "terminal"); const delivery = f.result("one"), resultRun = "one:result:run";
    expect(f.state().runs[resultRun]).toMatchObject({ state: "queued" });
    expect(delivery.effects.map(effect => effect.kind)).toContain("transcript.append");
    await f.record(resultRun); expect(f.state().runs[resultRun].state).toBe("queued");
    const drained = f.run({ type: "binding.drained", commandId: "drained", now, threadId: "manager", bindingId: f.state().threads.manager.bindingId!, status: "clean" });
    expect(f.state().runs[resultRun].state).toBe("running"); expect(drained.effects.map(effect => effect.kind)).toContain("runtime.acquire");
    await f.ready(resultRun); f.dispatch(resultRun); f.observe(resultRun, "accepted"); f.observe(resultRun, "terminal");
    expect(f.state().transfers["one:result"].state).toBe("consumed"); expect(f.result("one").effects).toEqual([]);
    await f.boot("report-reboot"); expect(f.state().transfers["one:result"].state).toBe("consumed");
  });
  it("records a late result after stop without admission, and supersedes results after clear", async () => {
    const f = await fixture(); f.assign("one"); await f.ready("run-one"); f.dispatch("run-one"); f.observe("run-one", "accepted"); f.observe("run-one", "terminal");
    f.run({ type: "thread.stop", commandId: "stop", now, threadId: "manager" }); f.result("one");
    expect(f.state().transfers["one:result"].state).toBe("pending"); expect(f.state().runs["one:result:run"]).toBeUndefined();
    f.run({ type: "assignments.clear", commandId: "clear", now, threadId: "manager", authorized: true });
    f.result("one"); expect(f.state().transfers["one:result"].state).toBe("superseded");
  });
  it("enforces concurrent specialist limits and selects the first eligible fallback", async () => {
    const f = await fixture(); f.assign("one", "one", "builder", undefined, 1);
    expect(() => f.assign("two", "two", "builder", undefined, 1)).toThrow(/limit/i);
    f.run({ type: "worker.assign", commandId: "fallback", now, assignmentId: "fallback", parentThreadId: "manager", parentRunId: "parent", workerThreadId: "two", workerRunId: "fallback-run", inputId: "fallback-input", attemptId: "fallback-attempt", bindingId: "fallback-binding", input: { text: "fixture", artifactIds: [] }, authorized: true, selection: { specialistId: "reviewer", provider: "codex", modelId: "blocked", candidates: [{ provider: "codex", modelId: "blocked", available: false }, { provider: "claude", modelId: "fallback", available: true }], maxConcurrent: 1 } });
    expect(f.state().assignments.fallback.selection).toMatchObject({ provider: "claude", modelId: "fallback" });
  });
});
