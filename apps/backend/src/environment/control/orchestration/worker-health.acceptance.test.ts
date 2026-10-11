import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { loadConfiguredSqliteDatabaseConstructor } from "../../../sqlite-database-loader.js";
import { prepareControlDatabase } from "../database.js";
import { createEventSink } from "../event-sink.js";
import { loadState } from "./store.js";
import { findWorkerAssignment } from "./assignments.js";
import type { CoreAgentMessagePort } from "../../../swarm/core-agent-message-port.js";
import { SwarmWorkerHealthService } from "../../../swarm/swarm-worker-health-service.js";
import { SwarmAgentLifecycleService, type SwarmAgentLifecycleServiceOptions } from "../../../swarm/swarm-agent-lifecycle-service.js";
import { WorkerBootRecovery } from "../../../swarm/agents/descriptor-store/worker-boot-recovery.js";
import type { AgentDescriptor } from "../../../swarm/types.js";

const roots: string[] = []; const databases: Database[] = [];
afterEach(async () => { vi.useRealTimers(); for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-health-core-")); roots.push(root);
  const Constructor = await loadConfiguredSqliteDatabaseConstructor(); const db = new Constructor(path.join(root, "control.sqlite")); databases.push(db);
  await prepareControlDatabase(db, { environmentId: "health", streamEpoch: "health" });
  let now = 1_800_000_000_000; let id = 0; const sink = createEventSink(db, () => now, () => `event-${++id}`);
  const manager: AgentDescriptor = { agentId: "manager", managerId: "manager", profileId: "project", displayName: "Manager", role: "manager", cwd: root, sessionFile: path.join(root, "manager.jsonl"), model: { provider: "codex", modelId: "fixture", thinkingLevel: "high" }, status: "streaming", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
  const worker: AgentDescriptor = { ...manager, agentId: "worker", displayName: "Worker", role: "worker", sessionFile: path.join(root, "worker.jsonl") };
  const descriptors = new Map([[manager.agentId, manager], [worker.agentId, worker]]);
  sink.transaction(tx => {
    for (const descriptor of descriptors.values()) sink.commitCommand(tx, { type: "thread.create", commandId: `create-${descriptor.agentId}`, now, threadId: descriptor.agentId, role: descriptor.role, projectId: "project", managerId: descriptor.role === "worker" ? "manager" : undefined });
    sink.commitCommand(tx, { type: "run.submit", commandId: "parent", now, threadId: "manager", runId: "parent", inputId: "parent-input", attemptId: "parent-attempt", bindingId: "binding", input: { text: "fixture", artifactIds: [] }, delivery: "queue" });
    sink.commitCommand(tx, { type: "input.recorded", commandId: "parent-recorded", now, threadId: "manager", inputId: "parent-input", entryId: "parent-entry" });
    sink.commitCommand(tx, { type: "worker.assign", commandId: "assign", now, assignmentId: "assignment", parentThreadId: "manager", parentRunId: "parent", workerThreadId: "worker", workerRunId: "worker-run", inputId: "worker-input", attemptId: "worker-attempt", bindingId: "worker-binding", input: { text: "fixture", artifactIds: [] }, authorized: true, selection: { provider: "codex", modelId: "fixture" } });
  });
  const port: CoreAgentMessagePort = {
    submit: async () => { throw new Error("unused"); }, recordWorkerResult: async () => { throw new Error("Health must never deliver results"); },
    readAssignment: id => findWorkerAssignment(loadState(db), id),
    stopWorker: async input => { sink.transaction(tx => sink.commitCommand(tx, { type: "worker.stop", commandId: `stop-${++id}`, now, threadId: input.workerId, managerId: input.managerId, authorized: true })); },
    clearAssignments: async managerId => { sink.transaction(tx => sink.commitCommand(tx, { type: "assignments.clear", commandId: `clear-${++id}`, now, threadId: managerId, authorized: true })); },
  };
  return { root, db, descriptors, worker, port, now: () => now, advance: (ms: number) => { now += ms; } };
}

it("observes controlled health deadlines without reconciling or retrying results", async () => {
  const f = await fixture(); const messages: string[] = []; const terminations: string[] = [];
  const corePort = { ...f.port, stopWorker: async (input: { managerId: string; workerId: string }) => { await f.port.stopWorker(input); f.worker.status = "terminated"; terminations.push(input.workerId); } };
  const health = new SwarmWorkerHealthService({ descriptors: f.descriptors, runtimes: new Map(),
    sendMessage: async (_from, _target, message) => { messages.push(message); }, publishToUser: async () => {},
    saveStore: async () => {}, reportAttentionStatusTransition: async () => {}, emitAgentsSnapshot: () => {},
    isRuntimeInContextRecovery: () => false, now: () => new Date(f.now()).toISOString(), logDebug: () => {},
  });
  health.installCoreAgentMessages(corePort);
  health.workerStallState.set("worker", { lastProgressAt: f.now(), nudgeSent: false, nudgeSentAt: null, lastToolName: "exec", lastToolInput: "fixture", lastToolOutput: null, lastDetailedReportAt: null });
  f.advance(5 * 60_000 - 1); await health.checkForStalledWorkers(); expect(messages).toEqual([]);
  f.advance(1); await health.checkForStalledWorkers(); expect(messages).toHaveLength(1); expect(terminations).toEqual([]);
  f.advance(25 * 60_000); await health.checkForStalledWorkers(); expect(terminations).toEqual(["worker"]);
  expect(loadState(f.db).threads.worker.desired).toBe("stopped"); expect(loadState(f.db).runs.parent.state).toBe("running");
  const evidenceDir = path.resolve("../../.internal/core/evidence"); await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "worker-health.json"), JSON.stringify({ warningAtMs: 5 * 60_000, stopAtMs: 30 * 60_000, messages, terminations, parentState: loadState(f.db).runs.parent.state }, null, 2));
});

it("never retries a possibly delivered health advisory after the sender loses its acknowledgement", async () => {
  const f = await fixture(); let attemptedMessages = 0;
  const health = new SwarmWorkerHealthService({ descriptors: f.descriptors, runtimes: new Map(),
    sendMessage: async () => { attemptedMessages++; throw new Error("acceptance acknowledgement lost"); }, publishToUser: async () => {},
    saveStore: async () => {}, reportAttentionStatusTransition: async () => {}, emitAgentsSnapshot: () => {},
    isRuntimeInContextRecovery: () => false, now: () => new Date(f.now()).toISOString(), logDebug: () => {},
  });
  health.installCoreAgentMessages(f.port);
  health.workerStallState.set("worker", { lastProgressAt: f.now(), nudgeSent: false, nudgeSentAt: null, lastToolName: null, lastToolInput: null, lastToolOutput: null, lastDetailedReportAt: null });
  f.advance(5 * 60_000); await health.checkForStalledWorkers(); await health.checkForStalledWorkers();
  expect(attemptedMessages).toBe(1);
  f.advance(5 * 60_000); await health.checkForStalledWorkers(); await health.checkForStalledWorkers();
  expect(attemptedMessages).toBe(2);
});

it("recovers worker identity and assignment from durable rows while ignoring orphan transcripts", async () => {
  const f = await fixture();
  // The production location is resolved by the data-path owner; use its database path.
  const { getEnvironmentDbPath } = await import("../../../swarm/storage/data-paths.js");
  const targetPath = getEnvironmentDbPath(f.root); await mkdir(path.dirname(targetPath), { recursive: true });
  f.db.close(); const bytes = await readFile(path.join(f.root, "control.sqlite")); await writeFile(targetPath, bytes);
  const Constructor = await loadConfiguredSqliteDatabaseConstructor(); const db = new Constructor(targetPath); databases.push(db);
  db.prepare("INSERT INTO control_workers (session_id,agent_id,worker_json,updated_sequence,descriptor_json) VALUES (?,?,?,?,?)").run("manager", "worker", "{}", 0, JSON.stringify(f.worker));
  await writeFile(path.join(f.root, "orphan.jsonl"), JSON.stringify({ type: "session", agentId: "orphan", cwd: f.root }) + "\n");
  f.descriptors.delete("worker");
  const recovery = new WorkerBootRecovery({ dataDir: f.root, descriptors: f.descriptors, upsertDescriptor: d => f.descriptors.set(d.agentId, d), logDebug: () => {} });
  expect(await recovery.recoverMissingDescriptors()).toEqual(["worker"]);
  expect(f.descriptors.get("worker")?.workerParentContext?.assignmentId).toBe("assignment");
  expect(f.descriptors.has("orphan")).toBe(false);
});

it("preflights worker selection facts and lets the transaction enforce specialist capacity", async () => {
  const f = await fixture();
  f.worker.specialistId = "builder"; f.worker.delegationRosterId = "roster";
  f.worker.delegationRosterRevision = 3; f.worker.delegationRouteId = "implement";
  f.worker.model = { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "high" };
  f.worker.delegationFallbackModel = { provider: "cursor-sdk", modelId: "fixture-cursor", thinkingLevel: "high" };
  let specialistEnabled = true;
  const service = new SwarmAgentLifecycleService({ descriptors: f.descriptors,
    modelCapacityBlocks: new Map(), now: () => new Date(f.now()).toISOString(),
    getManagedModelProviderAvailability: async () => new Map([["openai-codex", false], ["cursor-sdk", true]]),
    resolveSpecialistRosterForManager: async () => [{ specialistId: "builder", enabled: specialistEnabled }], logDebug: () => {},
  } as unknown as SwarmAgentLifecycleServiceOptions);
  const selection = await service.resolveWorkerAssignmentSelection(f.worker, false, 1);
  expect(selection).toMatchObject({ specialistId: "builder", rosterId: "roster", rosterRevision: 3, routeId: "implement", maxConcurrent: 1,
    candidates: [{ provider: "openai-codex", modelId: "gpt-5.4", available: false }, { provider: "cursor-sdk", modelId: "fixture-cursor", available: true }] });
  let event = 0; const sink = createEventSink(f.db, f.now, () => `selection-event-${++event}`);
  sink.transaction(tx => sink.commitCommand(tx, { type: "worker.stop", commandId: "settle-worker", now: f.now(), threadId: "worker", managerId: "manager", authorized: true }));
  sink.transaction(tx => sink.commitCommand(tx, { type: "binding.drained", commandId: "drain-selected-worker", now: f.now(), threadId: "worker", bindingId: "worker-binding", status: "clean" }));
  sink.transaction(tx => sink.commitCommand(tx, { type: "thread.resume", commandId: "resume-selected-worker", now: f.now(), threadId: "worker" }));
  sink.transaction(tx => sink.commitCommand(tx, { type: "worker.assign", commandId: "selected-assignment", now: f.now(), assignmentId: "selected", parentThreadId: "manager", parentRunId: "parent", workerThreadId: "worker", workerRunId: "selected-run", inputId: "selected-input", attemptId: "selected-attempt", bindingId: "selected-binding", input: { text: "selection fixture", artifactIds: [] }, authorized: true, selection }));
  expect(loadState(f.db).assignments.selected.selection).toMatchObject({ provider: "cursor-sdk", rosterId: "roster", rosterRevision: 3 });
  sink.transaction(tx => sink.commitCommand(tx, { type: "thread.create", commandId: "second-worker", now: f.now(), threadId: "second-worker", role: "worker", projectId: "project", managerId: "manager" }));
  const beforeCapacity = loadState(f.db);
  expect(() => sink.transaction(tx => sink.commitCommand(tx, { type: "worker.assign", commandId: "over-capacity", now: f.now(), assignmentId: "over-capacity", parentThreadId: "manager", parentRunId: "parent", workerThreadId: "second-worker", workerRunId: "second-run", inputId: "second-input", attemptId: "second-attempt", bindingId: "second-binding", input: { text: "capacity fixture", artifactIds: [] }, authorized: true, selection }))).toThrow("Specialist concurrency limit reached");
  expect(loadState(f.db)).toEqual(beforeCapacity);
  expect(loadState(f.db).runs.parent.state).toBe("running");
  const secureSelection = await service.resolveWorkerAssignmentSelection(f.worker, true, 1);
  expect(secureSelection.candidates?.[1].available).toBe(false);
  specialistEnabled = false;
  const disabledSelection = await service.resolveWorkerAssignmentSelection(f.worker, false, 1);
  expect(disabledSelection.candidates?.map(candidate => candidate.available)).toEqual([false, false]);
});
