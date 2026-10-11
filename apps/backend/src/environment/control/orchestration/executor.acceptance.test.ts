import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createControlCore, type ControlCore } from "../database.js";
import { piProviderCapabilities } from "../../../swarm/runtime/pi/pi-provider-adapter.js";
import { ProviderDispatchRejectedError, type ProviderAdapter, type ProviderBinding } from "../../../swarm/runtime/provider-contract.js";
import type { ControlCoreOptions } from "../effect-types.js";
import { loadState, projectLifecycle, replayLifecycle, rebuildLifecycleProjections } from "./store.js";
import { readReceipt } from "../command-service.js";
import { createSwarmControlAdapter } from "../swarm-control-adapter.js";
import { createArtifactService } from "../artifact-service.js";
import { UserMessageCoordinator, type HandleUserMessageOptions, type UserMessageCoordinatorOptions } from "../../../swarm/user-message-coordinator.js";
import { ConversationAttachmentService } from "../../../swarm/conversation-attachment-service.js";
import { projectLifecycleStatus } from "./lifecycle-projection.js";
import { AssistantOutputRouter } from "../../../swarm/assistant-output-router.js";
import { AgentDirectory } from "../../../swarm/agent-directory.js";
import type { AgentDescriptor } from "../../../swarm/types.js";
const roots: string[] = []; const cores: ControlCore[] = [];
afterEach(async () => { for (const core of cores.splice(0)) await core.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const commandId = "00000000-0000-4000-8000-000000000001";
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-core-executor-")); roots.push(root);
  let serial = 0; let revoked = false; let dispatches = 0;
  const canonical = new Set<string>(); const caps = piProviderCapabilities();
  const adapter: ProviderAdapter = {
    capabilities: () => caps,
    open: async () => { throw new Error("fixture port supplies binding"); }, resume: async () => { throw new Error("unused"); },
    start: async input => { dispatches++; return { status: "accepted", turn: { ...input.binding.scope, kind: "turn", conversationId: "native", nativeId: "turn" } }; },
    steer: async () => { throw new Error("unused"); }, interrupt: async () => {}, respond: async () => {}, compact: async () => {},
    async *observations() {}, close: async () => {}, drain: async () => ({ status: "clean" }),
  };
  const options: ControlCoreOptions = { databasePath: path.join(root, "control.sqlite"), clock: () => 1_800_000_000_000, random: () => `00000000-0000-4000-8000-${String(++serial).padStart(12,"0")}`, isDeviceRevoked: () => revoked,
    artifacts: { validateInput: () => [], pinInput: () => {} }, workspace: { prepareLaunch: async () => { throw new Error("unused"); }, isLaunchCurrent: () => true, ensure: async () => ({ cwd: root, branch: null }), reconcile: async () => "retry" },
    swarm: { ensureSession: async () => ({ materialized: true }), stopSession: async () => ({ stopped: true }), applyChoice: async () => "answered",
      acquireProvider: async scope => ({ adapter, binding: { scope, conversation: { ...scope, kind: "conversation", nativeId: "native" }, capabilities: caps, instructionRevision: "fixture", toolContractRevision: "fixture" } satisfies ProviderBinding }),
      applyInput: async input => { canonical.add(input.inputId); return { entryId: input.inputId, runtimeMessage: { text: input.message.text } }; },
    } };
  const open = async () => { const core = await createControlCore(options); cores.push(core); await core.reconcileOnBoot(); return core; };
  const core = await open();
  core.eventSink.transaction(tx => core.eventSink.append(tx, { topic: "shell", sessionId: "manager", event: { type: "session.upsert", session: { sessionId: "manager", projectId: "project", title: "fixture", status: "idle", attention: "none", unread: 0, workerCount: 0, archived: false, updatedAt: new Date(options.clock()).toISOString(), sortKey: "fixture", workspace: { kind: "current_checkout", cwd: root, branch: null } } } }));
  return { core, options, adapter, open, revoke: () => { revoked = true; }, dispatches: () => dispatches, canonical };
}
const principal = { deviceSessionId: "device", scopes: new Set(["session:operate" as const]) };

describe("durable provider outbox", () => {
  it.each(["append", "dispatch"] as const)("waits for the internal worker-result %s before admitting a context mutation", async boundary => {
    const f = await fixture();
    await f.core.controlService.submitInput({ commandId: "parent", threadId: "manager", message: { text: "parent", artifactIds: [] } });
    await f.core.effectWorker.drain();
    await f.core.controlService.submitInput({ commandId: "worker", threadId: "worker", thread: { role: "worker", managerId: "manager", projectId: "project" }, message: { text: "worker", artifactIds: [] },
      assignment: { assignmentId: "assignment", parentThreadId: "manager", parentRunId: "run-parent", selection: { provider: "pi", modelId: "fixture" } } });
    await f.core.effectWorker.drain();
    for (const runId of ["run-parent", "run-worker"]) {
      const state = loadState(f.core.database); const attempt = state.attempts[state.runs[runId].activeAttemptId]; const binding = state.bindings[attempt.bindingId];
      f.core.controlService.record({ type: "provider.observe", commandId: `terminal:${runId}`, now: f.options.clock(), observation: { type: "terminal", scope: binding.scope, attemptId: attempt.attemptId, sequence: 1, origin: { kind: "root", conversation: binding.conversation }, terminalAuthority: "root_attempt", outcome: "completed" } });
    }
    let enter!: () => void; let release!: () => void; let mutated = false;
    const entered = new Promise<void>(resolve => { enter = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    const apply = f.options.swarm.applyInput; const start = f.adapter.start;
    f.options.swarm.applyInput = async input => { if (boundary === "append" && input.runId === "assignment:result:run") { enter(); await held; } return apply(input); };
    f.adapter.start = async input => { if (boundary === "dispatch" && input.runId === "assignment:result:run") { enter(); await held; } return start(input); };
    f.core.controlService.record({ type: "worker.result", commandId: "canonical-report", now: f.options.clock(), assignmentId: "assignment", workerRunId: "run-worker", resultRef: { threadId: "worker", runId: "run-worker", entryId: "worker-final" }, input: { text: "durable worker report", artifactIds: [] } });
    const drain = f.core.effectWorker.drain(); await entered;
    const mutation = f.core.controlService.admitLifecycle(principal, { commandId, command: "worker.continue", sessionIds: ["manager"], intent: "inspect", request: {} }, async () => { mutated = true; return { completed: true }; });
    const outcome = mutation.then(value => ({ value }), error => ({ error }));
    try {
      await new Promise(resolve => setTimeout(resolve, 25)); expect(mutated).toBe(false);
      release(); await drain;
      expect(await outcome).toEqual({ value: { completed: true } });
    } finally { release(); await drain; }
  });
  it.each(["resume", "dismiss"] as const)("repairs a claimed canonical report before its first recovery snapshot and waits for %s", async action => {
    const f = await fixture();
    const canonicalFile = path.join(path.dirname(f.options.databasePath!), "report.jsonl");
    const apply = f.options.swarm.applyInput;
    f.options.swarm.applyInput = async input => {
      if (input.runId === "assignment:result:run") {
        const prior = await readFile(canonicalFile, "utf8").catch(() => "");
        if (!prior) await writeFile(canonicalFile, JSON.stringify({ id: input.inputId, text: input.message.text }) + "\n");
      }
      return apply(input);
    };
    await f.core.controlService.submitInput({ commandId: "parent", threadId: "manager", message: { text: "parent", artifactIds: [] } });
    await f.core.effectWorker.drain();
    await f.core.controlService.submitInput({ commandId: "worker", threadId: "worker", thread: { role: "worker", managerId: "manager", projectId: "project" }, message: { text: "worker", artifactIds: [] },
      assignment: { assignmentId: "assignment", parentThreadId: "manager", parentRunId: "run-parent", selection: { provider: "pi", modelId: "fixture" } } });
    await f.core.effectWorker.drain();
    for (const threadId of ["manager", "worker"]) {
      const state = loadState(f.core.database), run = state.runs[state.threads[threadId].activeRunId!], attempt = state.attempts[run.activeAttemptId], binding = state.bindings[attempt.bindingId];
      f.core.controlService.record({ type: "provider.observe", commandId: `terminal-${threadId}`, now: f.options.clock(), observation: { type: "terminal", scope: binding.scope, attemptId: attempt.attemptId, sequence: 1, origin: { kind: "root", conversation: binding.conversation, turn: attempt.turn }, terminalAuthority: "root_attempt", outcome: "completed" } });
    }
    f.core.controlService.record({ type: "worker.result", commandId: "canonical-report", now: f.options.clock(), assignmentId: "assignment", workerRunId: "run-worker", resultRef: { threadId: "worker", runId: "run-worker", entryId: "worker-final" }, input: { text: "[workerResult] durable report", artifactIds: [] },
      prepared: { runtimeMessage: { text: "[workerResult] durable report" }, presentation: { source: "worker_result", routeOrigin: "worker_result", assistantOutputTarget: { kind: "session_transcript", channel: "web" } } } });
    const report = loadState(f.core.database).runs["assignment:result:run"];
    await f.options.swarm.applyInput({ commandId: report.commandId, inputId: report.inputId, sessionId: report.threadId, runGeneration: 0, message: report.input, runId: report.runId });
    f.core.database.prepare("UPDATE effects SET state='claimed',claimed_boot_id='lost-boot',attempt=1 WHERE kind='transcript.append' AND json_extract(payload_json,'$.runId')=?").run(report.runId);
    expect(report.entryId).toBeUndefined();
    const dispatched = f.dispatches();
    await f.core.close();
    const reboot = await createControlCore(f.options); cores.push(reboot);
    let firstSnapshotEntry: string | undefined;
    reboot.eventSink.subscribe(event => { if (event.eventType === "recovery.upsert") firstSnapshotEntry ??= loadState(reboot.database).runs[report.runId].entryId; });
    await reboot.reconcileOnBoot();
    expect(firstSnapshotEntry).toBe(report.inputId);
    expect(loadState(reboot.database).runs[report.runId].entryId).toBe(report.inputId);
    expect(loadState(reboot.database).transfers["assignment:result"].state).toBe("pending");
    expect(loadState(reboot.database).recovery!.undeliveredReports).toMatchObject([{ deliveryId: "assignment:result" }]);
    await reboot.effectWorker.drain();
    expect(f.dispatches()).toBe(dispatched);
    expect(loadState(reboot.database).runs[report.runId].state).toBe("queued");
    const recoveryId = loadState(reboot.database).recovery!.recoveryId;
    reboot.controlService.record({ type: action === "resume" ? "recovery.resume" : "recovery.dismiss", commandId: "report-decision", now: f.options.clock(), recoveryId, attempts: {}, bindingIds: {} });
    await reboot.effectWorker.drain();
    expect(f.dispatches()).toBe(dispatched + (action === "resume" ? 1 : 0));
    expect(loadState(reboot.database).transfers["assignment:result"].state).toBe(action === "resume" ? "consumed" : "superseded");
    expect((await readFile(canonicalFile, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it.each(["acquire", "pending-start", "claimed-start"] as const)("restarts a canonical run before its dispatch mark at %s without replaying a stale effect", async boundary => {
    const f = await fixture(); const scopes: number[] = []; const acquire = f.options.swarm.acquireProvider;
    f.options.swarm.acquireProvider = async (...args) => { scopes.push(args[0].generation); return acquire(...args); };
    await f.core.controlService.execute(principal, "session.send", { commandId, sessionId: "manager", message: { text: "canonical", artifactIds: [] } });
    const before = loadState(f.core.database); const oldAttempt = before.attempts[before.runs[`run-${commandId}`].activeAttemptId];
    const run = before.runs[oldAttempt.runId];
    await f.options.swarm.applyInput({ commandId, inputId: run.inputId, sessionId: "manager", runGeneration: 0, message: run.input, runId: run.runId });
    f.core.controlService.record({ type: "input.recorded", commandId: "canonical-recorded", now: f.options.clock(), threadId: "manager", inputId: run.inputId, entryId: run.inputId });
    if (boundary !== "acquire") {
      const prepared = await acquire({ threadId: "manager", bindingId: oldAttempt.bindingId, generation: 0 });
      f.core.controlService.record({ type: "binding.acquired", commandId: "native-prepared", now: f.options.clock(), threadId: "manager", binding: prepared.binding });
    }
    f.core.eventSink.transaction(tx => {
      f.core.database.prepare("UPDATE effects SET state='done' WHERE kind='transcript.append' OR (? != 'acquire' AND kind='runtime.acquire')").run(boundary);
      if (boundary === "claimed-start") f.core.database.prepare("UPDATE effects SET state='claimed',claimed_boot_id='previous-process' WHERE kind='provider.start'").run();
      f.core.eventSink.updateReceipt(tx, commandId, { state: "running" });
    });
    await f.core.close(); const reboot = await f.open(); await reboot.effectWorker.drain();
    expect(f.dispatches()).toBe(1); expect(scopes).toEqual([1]); expect(f.canonical.size).toBe(1);
    expect(await reboot.controlService.getReceipt(principal, commandId)).toMatchObject({ state: "succeeded", delivery: "dispatched", error: null });
    const state = loadState(reboot.database); expect(state.threads.manager.activeRunId).toBe(run.runId);
    expect(state.runs[run.runId].state).toBe("running"); expect(state.runs[run.runId].activeAttemptId).not.toBe(oldAttempt.attemptId); expect(state.recovery).toBeNull();
  });

  it.each(["pending", "error"] as const)("quarantines %s runtime cleanup and interrupts the stop receipt before adapter close", async mode => {
    const f = await fixture(); let closes = 0; let now = f.options.clock(); f.options.clock = () => now;
    f.adapter.close = async () => { closes++; };
    f.options.swarm.stopSession = async () => { if (mode === "error") throw new Error("Runtime cleanup failed"); return { stopped: false }; };
    await f.core.controlService.submitInput({ commandId: "held", threadId: "manager", message: { text: "held", artifactIds: [] } }); await f.core.effectWorker.drain();
    await f.core.controlService.execute(principal, "session.stop", { commandId, sessionId: "manager" });
    for (let round = 0; round < 40; round++) { await f.core.effectWorker.drain(); now += 5_000; }
    expect(closes).toBe(0); expect(await f.core.controlService.getReceipt(principal, commandId)).toMatchObject({ state: "interrupted" });
    expect(loadState(f.core.database).threads.manager).toMatchObject({ desired: "stopped", shutdown: "quarantined" });
    await expect(f.core.controlService.submitInput({ commandId: "replacement", threadId: "manager", message: { text: "replacement", artifactIds: [] } })).rejects.toThrow(/shutdown/i);
  });
  it("serializes a newer send behind in-process unknown delivery and settles both resumed terminals", async () => {
    const f = await fixture(); const starts: string[] = [];
    f.adapter.start = async input => {
      starts.push(input.runId); return starts.length === 1 ? { status: "unknown" } : { status: "accepted", turn: { ...input.binding.scope, kind: "turn", conversationId: "native", nativeId: input.runId } };
    };
    await f.core.controlService.submitInput({ commandId: "first", threadId: "manager", message: { text: "first", artifactIds: [] } }); await f.core.effectWorker.drain();
    await f.core.controlService.submitInput({ commandId: "newer", threadId: "manager", message: { text: "newer", artifactIds: [] } }); await f.core.effectWorker.drain();
    expect(starts).toEqual(["run-first"]); expect(loadState(f.core.database).runs["run-newer"].state).toBe("queued");
    const recoveryId = loadState(f.core.database).recovery!.recoveryId;
    f.core.controlService.record({ type: "recovery.resume", commandId: "resume", now: f.options.clock(), recoveryId, attempts: { "run-first": "retry-first" }, bindingIds: { manager: "retry-binding" } }); await f.core.effectWorker.drain();
    expect(starts).toEqual(["run-first", "run-first"]);
    for (const runId of ["run-first", "run-newer"]) {
      const state = loadState(f.core.database); const attempt = state.attempts[state.runs[runId].activeAttemptId]; const binding = state.bindings[attempt.bindingId];
      f.core.controlService.record({ type: "provider.observe", commandId: `terminal-${runId}`, now: f.options.clock(), observation: { type: "terminal", scope: binding.scope, attemptId: attempt.attemptId, sequence: 1, origin: { kind: "root", conversation: binding.conversation }, terminalAuthority: "root_attempt", outcome: "completed" } }); await f.core.effectWorker.drain();
      expect(loadState(f.core.database).runs[runId]).toMatchObject({ state: "terminal", outcome: "completed" });
    }
    expect(starts).toEqual(["run-first", "run-first", "run-newer"]); expect(readReceipt(f.core.eventSink, "newer")).toMatchObject({ state: "succeeded", delivery: "dispatched" });
    const before = loadState(f.core.database); rebuildLifecycleProjections(f.core.database); expect(loadState(f.core.database)).toEqual(before);
  });
  it.each(["runtime.acquire", "stale.effect"] as const)("fences historical unknown attempts from a later %s failure", async boundary => {
    const f = await fixture(); let starts = 0;
    f.adapter.start = async input => ++starts === 1 ? { status: "unknown" } : { status: "accepted", turn: { ...input.binding.scope, kind: "turn", conversationId: "native", nativeId: input.runId } };
    await f.core.controlService.submitInput({ commandId: "first", threadId: "manager", message: { text: "first", artifactIds: [] } }); await f.core.effectWorker.drain();
    const originalAttemptId = loadState(f.core.database).runs["run-first"].activeAttemptId;
    await f.core.controlService.submitInput({ commandId: "newer", threadId: "manager", message: { text: "newer", artifactIds: [] } }); await f.core.effectWorker.drain();
    const recoveryId = loadState(f.core.database).recovery!.recoveryId;
    f.core.controlService.record({ type: "recovery.resume", commandId: "resume", now: f.options.clock(), recoveryId, attempts: { "run-first": "retry-first" }, bindingIds: { manager: "retry-binding" } }); await f.core.effectWorker.drain();
    const state = loadState(f.core.database), attempt = state.attempts[state.runs["run-first"].activeAttemptId], binding = state.bindings[attempt.bindingId];
    f.core.controlService.record({ type: "provider.observe", commandId: "first-completed", now: f.options.clock(), observation: { type: "terminal", scope: binding.scope, attemptId: attempt.attemptId, sequence: 1, origin: { kind: "root", conversation: binding.conversation }, terminalAuthority: "root_attempt", outcome: "completed" } });
    if (boundary === "runtime.acquire") f.options.swarm.acquireProvider = async () => { throw new Error("Newer provider acquisition failed"); };
    else f.core.controlService.record({ type: "effect.failed", commandId: "late-old-failure", now: f.options.clock(), threadId: "manager", attemptId: originalAttemptId, kind: "provider.start", delivery: "not_dispatched" });
    await f.core.effectWorker.drain();
    const after = loadState(f.core.database);
    expect(after.runs["run-first"]).toMatchObject({ state: "terminal", outcome: "completed" });
    expect(after.attempts[originalAttemptId]).toMatchObject({ state: "unknown", delivery: "unknown" });
    if (boundary === "runtime.acquire") {
      expect(after.runs["run-newer"]).toMatchObject({ state: "terminal", outcome: "failed" });
      expect(after.threads.manager.activeRunId).toBeUndefined();
      expect(readReceipt(f.core.eventSink, "newer")).toMatchObject({ state: "failed", delivery: "none" });
    } else expect(after.runs["run-newer"].state).toBe("running");
    const before = loadState(f.core.database); rebuildLifecycleProjections(f.core.database); expect(loadState(f.core.database)).toEqual(before);
  });
  it("attributes a queued canonical append failure to its run instead of the historical unknown attempt", async () => {
    const f = await fixture(); f.adapter.start = async () => ({ status: "unknown" });
    await f.core.controlService.submitInput({ commandId: "first", threadId: "manager", message: { text: "first", artifactIds: [] } }); await f.core.effectWorker.drain();
    const before = loadState(f.core.database), originalAttemptId = before.runs["run-first"].activeAttemptId;
    f.options.swarm.applyInput = async () => { throw new Error("Newer canonical append failed"); };
    await f.core.controlService.submitInput({ commandId: "newer", threadId: "manager", message: { text: "newer", artifactIds: [] } }); await f.core.effectWorker.drain();
    const after = loadState(f.core.database);
    expect(after.runs["run-first"]).toEqual(before.runs["run-first"]);
    expect(after.attempts[originalAttemptId]).toEqual(before.attempts[originalAttemptId]);
    expect(after.runs["run-newer"]).toMatchObject({ state: "terminal", outcome: "failed" });
  });
  it("keeps a cancelled retained worker's late report readable without queuing or recovering delivery", async () => {
    const f = await fixture();
    await f.core.controlService.submitInput({ commandId: "parent", threadId: "manager", message: { text: "parent", artifactIds: [] } }); await f.core.effectWorker.drain();
    await f.core.controlService.submitInput({ commandId: "child", threadId: "worker", thread: { role: "worker", managerId: "manager", projectId: "project" }, message: { text: "child", artifactIds: [] }, assignment: { assignmentId: "assignment", parentThreadId: "manager", parentRunId: "run-parent", selection: { provider: "pi", modelId: "fixture" } } }); await f.core.effectWorker.drain();
    await f.core.controlService.execute(principal, "session.stop", { commandId, sessionId: "manager" }); await f.core.effectWorker.drain();
    expect(loadState(f.core.database).assignments.assignment.state).toBe("cancelled");
    f.core.controlService.record({ type: "worker.result", commandId: "late-result", now: f.options.clock(), assignmentId: "assignment", workerRunId: "run-child", resultRef: { threadId: "worker", runId: "run-child", entryId: "readable-final" }, input: { text: "Readable cancelled work", artifactIds: [] } });
    await f.core.close(); const reboot = await f.open(); await reboot.effectWorker.drain();
    const after = loadState(reboot.database);
    expect(after.assignments.assignment).toMatchObject({ resultRef: { entryId: "readable-final" }, resultInput: { text: "Readable cancelled work" } });
    expect(after.transfers["assignment:result"].state).toBe("superseded");
    expect(after.runs["assignment:result:run"]).toBeUndefined();
    expect(after.recovery?.undeliveredReports ?? []).toEqual([]);
    expect(after.threads.worker.desired).toBe("running"); expect(f.dispatches()).toBe(2);
  });
  it("queues an immediate send after a configure receipt while its provider release is pending", async () => {
    const f = await fixture(); let release!: () => void; const shutdown = new Promise<void>(resolve => { release = resolve; });
    f.options.swarm.stopSession = async () => { await shutdown; return { stopped: true }; };
    const generations: number[] = []; const acquire = f.options.swarm.acquireProvider;
    f.options.swarm.acquireProvider = async (...args) => { generations.push(args[0].generation); return acquire(...args); };
    try {
      await f.core.controlService.submitInput({ commandId: "before-configure", threadId: "manager", message: { text: "before", artifactIds: [] } }); await f.core.effectWorker.drain();
      const state = loadState(f.core.database); const attempt = state.attempts[state.runs["run-before-configure"].activeAttemptId]; const binding = state.bindings[attempt.bindingId];
      f.core.controlService.record({ type: "provider.observe", commandId: "first-terminal", now: f.options.clock(), observation: { type: "terminal", scope: binding.scope, attemptId: attempt.attemptId, sequence: 1, origin: { kind: "root", conversation: binding.conversation }, terminalAuthority: "root_attempt", outcome: "completed" } });
      f.options.policy = { prepare: async (_method, input) => ({ sessionIds: ["manager"], projectIds: ["project"], intent: "inspect", frozen: input }), read: async () => { throw new Error("unused"); }, apply: async (_method, input) => {
        // Seed the settings owner's retained handoff boundary without importing Phase 5 policy.
        f.core.eventSink.transaction(() => {
          const owner = loadState(f.core.database).threads.manager;
          const event = { type: "thread.changed" as const, commandId: input.commandId, at: f.options.clock(), thread: { ...owner, shutdown: "pending" as const } };
          f.core.database.prepare("INSERT INTO lifecycle_events(event_id,command_id,thread_id,event_type,event_json,created_at) VALUES (?,?,?,?,?,?)").run("handoff-fact", input.commandId, "manager", event.type, JSON.stringify(event), event.at); projectLifecycle(f.core.database, event);
          const ordinal = (f.core.database.prepare("SELECT MAX(ordinal)+1 n FROM effects WHERE command_id=?").get(input.commandId) as { n: number }).n;
          f.core.database.prepare("INSERT INTO effects(effect_id,command_id,session_id,kind,ordinal,payload_json,state,not_before) VALUES (?,?,'manager','provider.release',?,?,'pending',?)").run("handoff-release", input.commandId, ordinal, JSON.stringify({ kind: "provider.release", threadId: "manager", bindingId: owner.bindingId }), f.options.clock() + 60_000);
        });
        return {};
      } };
      const configured = await f.core.controlService.execute(principal, "session.configure", { commandId: "00000000-0000-4000-8000-000000000002", sessionId: "manager", contextMode: "fresh" });
      expect(configured.state).toBe("succeeded"); expect(loadState(f.core.database).threads.manager.shutdown).toBe("pending");
      const sent = await f.core.controlService.execute(principal, "session.send", { commandId, sessionId: "manager", message: { text: "immediate", artifactIds: [] } });
      expect(sent.state).toBe("accepted"); expect(loadState(f.core.database).runs[`run-${commandId}`].state).toBe("queued");
      await f.core.effectWorker.drain(); expect(generations).toEqual([0]); expect(f.canonical.size).toBe(1); expect(f.dispatches()).toBe(1);
      f.core.database.prepare("UPDATE effects SET not_before=0 WHERE effect_id='handoff-release'").run(); release(); await f.core.effectWorker.drain();
      expect(generations).toEqual([0, 1]); expect(f.dispatches()).toBe(2); expect(f.canonical.size).toBe(2);
      expect(await f.core.controlService.getReceipt(principal, commandId)).toMatchObject({ state: "succeeded", delivery: "dispatched" });
      expect(loadState(f.core.database).threads.manager).toMatchObject({ shutdown: "clean", activeRunId: `run-${commandId}` }); expect(replayLifecycle(f.core.database)).toEqual(loadState(f.core.database));
    } finally { release(); }
  });
  it("returns typed conflicts for quarantined RPC and internal input admission", async () => {
    const f = await fixture(); await f.core.controlService.submitInput({ commandId: "before", threadId: "manager", message: { text: "before", artifactIds: [] } }); await f.core.effectWorker.drain();
    f.core.controlService.record({ type: "binding.drained", commandId: "unsafe", now: f.options.clock(), threadId: "manager", bindingId: loadState(f.core.database).threads.manager.bindingId!, status: "pending" });
    await expect(f.core.controlService.execute(principal, "session.send", { commandId, sessionId: "manager", message: { text: "unsafe", artifactIds: [] } })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(f.core.controlService.submitInput({ commandId: "unsafe-internal", threadId: "manager", message: { text: "unsafe", artifactIds: [] } })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("settles runtime cleanup before closing the adapter binding", async () => {
    const f = await fixture(); let nativeClosed = false; const order: string[] = [];
    f.adapter.close = async () => { nativeClosed = true; order.push("adapter.close"); };
    f.options.swarm.stopSession = async () => { order.push("runtime.stop"); if (nativeClosed) throw new Error("Runtime cannot interrupt a closed native binding"); return { stopped: true }; };
    await f.core.controlService.submitInput({ commandId: "held", threadId: "manager", message: { text: "held", artifactIds: [] } }); await f.core.effectWorker.drain();
    await f.core.controlService.execute(principal, "session.stop", { commandId, sessionId: "manager" }); await f.core.effectWorker.drain();
    expect(order).toEqual(["runtime.stop", "adapter.close"]); expect(await f.core.controlService.getReceipt(principal, commandId)).toMatchObject({ state: "succeeded" });
    expect(loadState(f.core.database).threads.manager).toMatchObject({ desired: "stopped", shutdown: "clean" });
  });
  it("keeps a slow shutdown tracked until the runtime exits, then settles the stuck run and admits the next send", async () => {
    const f = await fixture(); let now = f.options.clock(); f.options.clock = () => now; let exited = false; let stops = 0;
    f.options.swarm.stopSession = async () => { stops++; return { stopped: exited }; };
    await f.core.controlService.submitInput({ commandId: "held", threadId: "manager", message: { text: "held", artifactIds: [] } }); await f.core.effectWorker.drain();
    await f.core.controlService.execute(principal, "session.stop", { commandId, sessionId: "manager" }); await f.core.effectWorker.drain();
    // Slow is not unsafe: the drain stays owed, the stop stays in flight, and nothing reports a failure.
    expect(loadState(f.core.database).threads.manager).toMatchObject({ desired: "stopped", shutdown: "pending", activeRunId: "run-held" });
    expect(await f.core.controlService.getReceipt(principal, commandId)).toMatchObject({ state: "running", error: null });
    await f.core.effectWorker.drain(); expect(stops).toBe(1);
    now += 5_000; await f.core.effectWorker.drain(); expect(stops).toBe(2);
    expect(loadState(f.core.database).threads.manager.shutdown).toBe("pending");
    exited = true; now += 5_000; await f.core.effectWorker.drain();
    const settled = loadState(f.core.database);
    expect(settled.threads.manager).toMatchObject({ desired: "stopped", shutdown: "clean" }); expect(settled.threads.manager.activeRunId).toBeUndefined();
    expect(settled.runs["run-held"]).toMatchObject({ state: "terminal", outcome: "cancelled" });
    expect(await f.core.controlService.getReceipt(principal, commandId)).toMatchObject({ state: "succeeded", error: null });
    expect(JSON.parse((f.core.database.prepare("SELECT summary_json FROM control_sessions WHERE session_id='manager'").get() as { summary_json: string }).summary_json).status).toBe("stopped");
    const next = "00000000-0000-4000-8000-000000000002";
    await f.core.controlService.execute(principal, "session.send", { commandId: next, sessionId: "manager", message: { text: "again", artifactIds: [] } }); await f.core.effectWorker.drain();
    expect(await f.core.controlService.getReceipt(principal, next)).toMatchObject({ state: "succeeded", delivery: "dispatched" });
    expect(loadState(f.core.database).threads.manager).toMatchObject({ desired: "running", shutdown: "clean", activeRunId: `run-${next}` });
    expect(f.dispatches()).toBe(2); expect(replayLifecycle(f.core.database)).toEqual(loadState(f.core.database));
  });
  it("quarantines only an unconfirmable shutdown, explains it, and recovers when the user stops again", async () => {
    const f = await fixture(); let now = f.options.clock(); f.options.clock = () => now; let exited = false; let stops = 0;
    f.options.swarm.stopSession = async () => { stops++; return { stopped: exited }; };
    await f.core.controlService.submitInput({ commandId: "held", threadId: "manager", message: { text: "held", artifactIds: [] } }); await f.core.effectWorker.drain();
    await f.core.controlService.execute(principal, "session.stop", { commandId, sessionId: "manager" });
    for (let round = 0; round < 40; round++) { await f.core.effectWorker.drain(); now += 5_000; }
    const attempts = stops; await f.core.effectWorker.drain(); expect(stops).toBe(attempts); expect(attempts).toBeGreaterThan(3); expect(attempts).toBeLessThan(40);
    expect(loadState(f.core.database).threads.manager).toMatchObject({ desired: "stopped", shutdown: "quarantined", activeRunId: "run-held" });
    const failed = await f.core.controlService.getReceipt(principal, commandId);
    expect(failed).toMatchObject({ state: "interrupted", error: { code: "UNAVAILABLE", retryable: true } }); expect(failed.error!.message).toMatch(/could not be confirmed stopped.*Stop the session again/i);
    const next = "00000000-0000-4000-8000-000000000002"; const send = { commandId: next, sessionId: "manager", message: { text: "again", artifactIds: [] } };
    await expect(f.core.controlService.execute(principal, "session.send", send)).rejects.toMatchObject({ code: "CONFLICT" });
    exited = true; const again = "00000000-0000-4000-8000-000000000003";
    await f.core.controlService.execute(principal, "session.stop", { commandId: again, sessionId: "manager" }); await f.core.effectWorker.drain();
    expect(await f.core.controlService.getReceipt(principal, again)).toMatchObject({ state: "succeeded", error: null });
    expect(loadState(f.core.database).runs["run-held"]).toMatchObject({ state: "terminal", outcome: "cancelled" });
    await f.core.controlService.execute(principal, "session.send", send); await f.core.effectWorker.drain();
    expect(await f.core.controlService.getReceipt(principal, next)).toMatchObject({ state: "succeeded", delivery: "dispatched" }); expect(f.dispatches()).toBe(2);
  });
  it.each(["pending", "quarantined"] as const)("recovers a stopped thread whose drain was %s at restart without a recovery decision", async shutdown => {
    const f = await fixture(); let now = f.options.clock(); f.options.clock = () => now; let stops = 0;
    f.options.swarm.stopSession = async () => { stops++; return { stopped: false }; };
    await f.core.controlService.submitInput({ commandId: "held", threadId: "manager", message: { text: "held", artifactIds: [] } }); await f.core.effectWorker.drain();
    await f.core.controlService.execute(principal, "session.stop", { commandId, sessionId: "manager" }); await f.core.effectWorker.drain();
    if (shutdown === "quarantined") for (let round = 0; round < 40; round++) { now += 5_000; await f.core.effectWorker.drain(); }
    expect(loadState(f.core.database).threads.manager).toMatchObject({ desired: "stopped", shutdown, activeRunId: "run-held" });
    await f.core.close(); const stopsBeforeBoot = stops;
    // The old process is gone, so its writer is too. The runtime must not be stopped a second time.
    f.options.swarm.stopSession = async () => { stops++; return { stopped: true }; };
    const reboot = await f.open(); now += 5_000; await reboot.effectWorker.drain();
    const recovered = loadState(reboot.database);
    expect(recovered.threads.manager).toMatchObject({ desired: "stopped", shutdown: "clean" }); expect(recovered.threads.manager.activeRunId).toBeUndefined();
    expect(recovered.runs["run-held"]).toMatchObject({ state: "terminal", outcome: "cancelled" }); expect(recovered.recovery).toBeNull();
    expect(JSON.parse((reboot.database.prepare("SELECT summary_json FROM control_sessions WHERE session_id='manager'").get() as { summary_json: string }).summary_json).status).toBe("stopped");
    if (shutdown === "pending") expect(readReceipt(reboot.eventSink, commandId)).toMatchObject({ state: "succeeded" });
    const next = "00000000-0000-4000-8000-000000000002";
    await reboot.controlService.execute(principal, "session.send", { commandId: next, sessionId: "manager", message: { text: "again", artifactIds: [] } }); await reboot.effectWorker.drain();
    expect(readReceipt(reboot.eventSink, next)).toMatchObject({ state: "succeeded", delivery: "dispatched" });
    expect(loadState(reboot.database).threads.manager).toMatchObject({ desired: "running", shutdown: "clean", activeRunId: `run-${next}` });
    expect(stops).toBe(stopsBeforeBoot); expect(f.dispatches()).toBe(2);
  });
  it("retains an idle worker after session stop on live and reboot projections, then dispatches a new assignment", async () => {
    const f = await fixture(); const order: string[] = []; const visible: string[] = [];
    f.core.eventSink.transaction(tx => f.core.eventSink.append(tx, { topic: "detail", sessionId: "manager", event: { type: "worker.upsert", worker: { agentId: "worker", title: "Worker", status: "idle" } } }));
    f.core.eventSink.subscribe(event => { if (event.event.type === "worker.upsert") visible.push(event.event.worker.status); });
    await f.core.controlService.submitInput({ commandId: "parent", threadId: "manager", message: { text: "held", artifactIds: [] } }); await f.core.effectWorker.drain();
    await f.core.controlService.submitInput({ commandId: "child", threadId: "worker", thread: { role: "worker", projectId: "project", managerId: "manager" }, message: { text: "held", artifactIds: [] },
      assignment: { assignmentId: "first", parentThreadId: "manager", parentRunId: "run-parent", selection: { provider: "pi", modelId: "fixture" } } }); await f.core.effectWorker.drain();
    await f.core.controlService.submitInput({ commandId: "queued-child", threadId: "worker", message: { text: "queued", artifactIds: [] } });
    f.options.swarm.stopSession = async input => { order.push(input.sessionId); return { stopped: true }; };
    await f.core.controlService.execute(principal, "session.stop", { commandId, sessionId: "manager" }); await f.core.effectWorker.drain();
    const stopped = loadState(f.core.database);
    expect(stopped.threads.manager).toMatchObject({ desired: "stopped", shutdown: "clean" });
    expect(stopped.threads.worker).toMatchObject({ desired: "running", shutdown: "clean" });
    expect(stopped.threads.worker.activeRunId).toBeUndefined(); expect(stopped.threads.worker.bindingId).toBeUndefined();
    expect(order).toEqual(["manager", "worker"]); expect(await f.core.controlService.getReceipt(principal, commandId)).toMatchObject({ state: "succeeded" });
    for (const id of ["run-child", "run-queued-child"]) expect(stopped.runs[id]).toMatchObject({ state: "terminal", outcome: "cancelled" });
    expect(stopped.assignments.first.state).toBe("cancelled"); expect(visible.at(-1)).toBe("idle");
    const workerRow = (core: ControlCore) => JSON.parse((core.database.prepare("SELECT worker_json FROM control_workers WHERE agent_id='worker'").get() as { worker_json: string }).worker_json);
    expect(workerRow(f.core).status).toBe("idle"); expect(projectLifecycleStatus(stopped, "worker")?.agentStatus).toBe("idle");
    await f.core.close(); const reboot = await f.open();
    expect(workerRow(reboot).status).toBe("idle"); expect(projectLifecycleStatus(loadState(reboot.database), "worker")?.agentStatus).toBe("idle");
    await reboot.controlService.submitInput({ commandId: "resumed-parent", threadId: "manager", message: { text: "continue", artifactIds: [] } }); await reboot.effectWorker.drain();
    const continuation = await reboot.controlService.submitInput({ commandId: "continued-child", threadId: "worker", message: { text: "reuse retained worker", artifactIds: [] },
      assignment: { assignmentId: "second", parentThreadId: "manager", parentRunId: "run-resumed-parent", selection: { provider: "pi", modelId: "fixture" } } }); await reboot.effectWorker.drain();
    expect(readReceipt(reboot.eventSink, "continued-child")).toMatchObject({ state: "succeeded", delivery: "dispatched" });
    expect(loadState(reboot.database).runs[continuation.runId].state).toBe("running"); expect(f.dispatches()).toBe(4);
  });
  it.each(["resume", "dismiss"] as const)("commits recovery %s facts with the submitted receipt and outbox before presentation", async action => {
    const f = await fixture();
    await f.core.controlService.submitInput({ commandId: "interrupted", threadId: "manager", message: { text: "held", artifactIds: [] } }); await f.core.effectWorker.drain();
    await f.core.close(); const reboot = await f.open();
    const snapshot = loadState(reboot.database).recovery!; let publications = 0;
    reboot.eventSink.subscribe(event => {
      if (event.event.type !== "recovery.upsert" || !event.event.recovery[ action === "resume" ? "resumedAt" : "dismissedAt" ]) return;
      expect(reboot.database.inTransaction).toBe(false); expect(readReceipt(reboot.eventSink, commandId).state).toBe("running"); publications++;
      const facts = reboot.database.prepare("SELECT event_json FROM lifecycle_events WHERE command_id=? AND event_type='recovery.resolved'").all(commandId) as { event_json: string }[];
      expect(facts).toHaveLength(1);
    });
    const input = { commandId, command: "recovery.decide", request: { commandId, recoveryId: snapshot.recoveryId, action }, sessionIds: ["manager"], intent: "inspect" as const, receipt: { method: "recovery.decide" as const }, receiptReplay: true };
    let presentations = 0;
    const present = async () => { presentations++; expect(loadState(reboot.database).recovery?.[action === "resume" ? "resumedAt" : "dismissedAt"]).toBeTruthy(); return {}; };
    await reboot.controlService.admitLifecycle(principal, input, present); await reboot.controlService.admitLifecycle(principal, input, present);
    expect(presentations).toBe(1); expect(publications).toBe(1); expect(readReceipt(reboot.eventSink, commandId).state).toBe("succeeded");
    await reboot.effectWorker.drain();
    const nextCommandId = "00000000-0000-4000-8000-000000000002";
    await expect(reboot.controlService.admitLifecycle(principal, { ...input, commandId: nextCommandId, request: { ...input.request, commandId: nextCommandId } }, present)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(presentations).toBe(1); expect(publications).toBe(1);
    const resumed = loadState(reboot.database).runs["run-interrupted"];
    expect(resumed.state).toBe(action === "resume" ? "running" : "terminal");
    if (action === "resume") expect(reboot.database.prepare("SELECT COUNT(*) n FROM effects WHERE command_id=? AND kind='runtime.acquire'").get(commandId)).toEqual({ n: 1 });
  });
  it("session deletion terminates retained workers in the same lifecycle transaction", async () => {
    const f = await fixture();
    await f.core.controlService.submitInput({ commandId: "child", threadId: "worker", thread: { role: "worker", projectId: "project", managerId: "manager" }, message: { text: "held", artifactIds: [] } }); await f.core.effectWorker.drain();
    await f.core.controlService.admitLifecycle(principal, { commandId, command: "session.delete", sessionIds: ["manager"], intent: "stop", request: {} }, async () => {
      expect(loadState(f.core.database).threads.worker).toMatchObject({ desired: "stopped", shutdown: "clean" });
      expect(projectLifecycleStatus(loadState(f.core.database), "worker")?.agentStatus).toBe("terminated");
    });
  });
  it("retained worker continuation remains fenced while its session-stop drain is quarantined", async () => {
    const f = await fixture(); let now = f.options.clock(); f.options.clock = () => now;
    await f.core.controlService.submitInput({ commandId: "child", threadId: "worker", thread: { role: "worker", projectId: "project", managerId: "manager" }, message: { text: "held", artifactIds: [] } }); await f.core.effectWorker.drain();
    f.options.swarm.stopSession = async input => ({ stopped: input.sessionId !== "worker" });
    await f.core.controlService.execute(principal, "session.stop", { commandId, sessionId: "manager" });
    for (let round = 0; round < 40; round++) { await f.core.effectWorker.drain(); now += 5_000; }
    expect(loadState(f.core.database).threads.worker).toMatchObject({ desired: "running", shutdown: "quarantined" });
    expect((await f.core.controlService.getReceipt(principal, commandId)).state).toBe("interrupted");
    await expect(f.core.controlService.submitInput({ commandId: "unsafe-continuation", threadId: "worker", message: { text: "continue", artifactIds: [] } })).rejects.toThrow(/shutdown/i);
    expect(f.dispatches()).toBe(1);
  });
  it("rebuilds provider images from pinned prepared-message attachments after restart", async () => {
    const f = await fixture(); const root = path.dirname(f.options.databasePath!);
    const descriptor = { agentId: "manager", role: "manager", status: "idle", profileId: "project" } as AgentDescriptor;
    const attachments = new ConversationAttachmentService({ dataDir: root, uploadsDir: path.join(root, "uploads") });
    const coordinator = new UserMessageCoordinator({
      targeting: { getAgentForInternalUse: () => descriptor, assertDescriptorNotEffectivelyArchived() {} }, attachments,
      codex: { plugin: { assertWorkerNotUserTargetable() { throw new Error("Internal prepared inputs are user-gated"); } } }, projectAgents: { async preflightRuntime() {} },
      runtime: { withRuntimeAdmission: async (_id: string, work: () => Promise<unknown>) => work() },
      inboundConversation: { async append(_target: unknown, input: { attachments: import("../../../swarm/types.js").ConversationAttachment[] }) { return { event: { id: "canonical", timelineEntryId: "canonical" }, runtimeAttachments: input.attachments }; } },
      turns: { async enqueue() {} },
    } as unknown as UserMessageCoordinatorOptions);
    const acquire = f.options.swarm.acquireProvider;
    const swarm = { installProviderScopeOwner() {}, installAuthoritativeInputOwner() {}, installControlledTurnProjection() {}, installControlledChoicePort() {}, reflectControlledTurns() {}, installCoreAgentMessagePort() {},
      getAgentForInternalUse: () => descriptor, acquireControlledProvider: acquire, applyControlledInput: coordinator.applyControlledInput.bind(coordinator),
    } as unknown as Parameters<typeof createSwarmControlAdapter>[0]["swarmManager"];
    const artifactService = createArtifactService({ database: f.core.database, dataDir: root });
    const imageRows = await artifactService.prepareInternalInput({ commandId: "prepared-image", threadId: "manager", projectId: "project", attachments: [{ type: "image", mimeType: "image/png", fileName: "image.png", data: Buffer.from("fixture image bytes").toString("base64") }] });
    f.options.artifacts = artifactService;
    await f.core.controlService.submitInput({ commandId: "prepared-image", threadId: "manager", message: { text: "Prepared text with guidance.", artifactIds: imageRows.map(row => row.artifactId) }, artifactRows: imageRows,
      prepared: { runtimeMessage: { text: "Prepared text with guidance." }, presentation: { source: "agent_message" } } });
    await f.core.close(); const second = await f.open();
    const reloadedArtifacts = createArtifactService({ database: second.database, dataDir: root });
    Object.assign(f.options.swarm, createSwarmControlAdapter({ swarmManager: swarm, database: second.database, eventSink: second.eventSink, controlService: second.controlService, workspaceService: f.options.workspace, artifactService: reloadedArtifacts }));
    let nativeInput: import("../../../swarm/runtime-contracts.js").RuntimeUserMessage | undefined;
    f.adapter.start = async input => { nativeInput = input.input; return { status: "accepted", turn: { ...input.binding.scope, kind: "turn", conversationId: "native", nativeId: "turn" } }; };
    await second.effectWorker.drain();
    expect(nativeInput).toEqual({ text: "Prepared text with guidance.", images: [{ mimeType: "image/png", data: Buffer.from("fixture image bytes").toString("base64") }] });
  });
  it("persists the internal worker-result envelope and routing through recovery before dispatch", async () => {
    const f = await fixture(); const root = path.dirname(f.options.databasePath!);
    const manager = { agentId: "manager", role: "manager", status: "idle", profileId: "project" } as AgentDescriptor;
    const worker = { ...manager, agentId: "worker", managerId: "manager", role: "worker", displayName: "Fixture Worker" } as AgentDescriptor;
    const canonical: Array<Record<string, unknown>> = [];
    const coordinator = new UserMessageCoordinator({ targeting: { getAgentForInternalUse: (id: string) => new Map([["manager", manager], ["worker", worker]]).get(id), assertDescriptorNotEffectivelyArchived() {} },
      attachments: new ConversationAttachmentService({ dataDir: root, uploadsDir: path.join(root, "uploads") }),
      codex: { plugin: { assertWorkerNotUserTargetable() { throw new Error("Internal result must bypass the user gate"); } } },
      projectAgents: { async preflightRuntime() {} }, runtime: { withRuntimeAdmission: async (_id: string, work: () => Promise<unknown>) => work() },
      agentMessages: { async prepareModelInboundMessage(_id: string, input: { text: string }, origin: string) { expect(origin).toBe("internal"); return input.text; } },
      assistantOutput: new AssistantOutputRouter({} as ConstructorParameters<typeof AssistantOutputRouter>[0]),
      inboundConversation: { async append(_target: unknown, input: Record<string, unknown>) { canonical.push(input); const entryId = (input.controlledInput as { inputId: string }).inputId; return { event: { id: entryId, timelineEntryId: entryId }, runtimeAttachments: [] }; } },
      turns: { async enqueue() {} },
    } as unknown as UserMessageCoordinatorOptions);
    f.options.swarm.extractWorkerResult = async () => ({ entryId: "worker-final", resultText: "status: done\nsummary: Finished the bounded task." });
    f.options.swarm.prepareWorkerResult = (assignment, resultText) => coordinator.prepareWorkerResult(assignment, resultText);
    await f.core.controlService.submitInput({ commandId: "parent", threadId: "manager", message: { text: "parent", artifactIds: [] } }); await f.core.effectWorker.drain();
    await f.core.controlService.submitInput({ commandId: "worker", threadId: "worker", thread: { role: "worker", managerId: "manager", projectId: "project" }, message: { text: "worker", artifactIds: [] },
      assignment: { assignmentId: "assignment", parentThreadId: "manager", parentRunId: "run-parent", selection: { provider: "pi", modelId: "fixture" }, parentContext: { outputTarget: { kind: "internal_only", reason: "result-fixture" }, rootTurnId: "parent-root" } } }); await f.core.effectWorker.drain();
    const terminal = (core: ControlCore, threadId: string) => { const state = loadState(core.database); const run = state.runs[state.threads[threadId].activeRunId!]; const attempt = state.attempts[run.activeAttemptId]; const binding = state.bindings[attempt.bindingId];
      core.controlService.record({ type: "provider.observe", commandId: `terminal-${threadId}`, now: f.options.clock(), observation: { type: "terminal", scope: binding.scope, attemptId: attempt.attemptId, sequence: 1, origin: { kind: "root", conversation: binding.conversation, turn: attempt.turn }, terminalAuthority: "root_attempt", outcome: "completed" } }); };
    terminal(f.core, "worker"); await f.core.effectWorker.drain();
    const row = f.core.database.prepare("SELECT prepared_json FROM orchestration_run_inputs WHERE run_id='assignment:result:run'").get() as { prepared_json: string } | undefined;
    expect(row).toBeDefined(); const prepared = JSON.parse(row!.prepared_json);
    expect(prepared.runtimeMessage.text).toContain("[workerResult]"); expect(prepared.runtimeMessage.text).toContain("Fixture Worker");
    expect(prepared.presentation).toMatchObject({ source: "worker_result", routeOrigin: "worker_result", sourceWorkerId: "worker", parentRootTurnId: "parent-root", assistantOutputTarget: { kind: "internal_only", reason: "result-fixture" } });
    terminal(f.core, "manager"); await f.core.close(); const reboot = await f.open();
    expect(JSON.parse((reboot.database.prepare("SELECT prepared_json FROM orchestration_run_inputs WHERE run_id='assignment:result:run'").get() as typeof row & {}).prepared_json)).toEqual(prepared);
    const state = loadState(reboot.database);
    reboot.controlService.record({ type: "recovery.resume", commandId: "resume-result", now: f.options.clock(), recoveryId: state.recovery!.recoveryId, attempts: { "assignment:result:run": "result-retry" }, bindingIds: { manager: "result-binding" } });
    f.options.swarm.applyInput = input => coordinator.applyControlledInput(input.message.text, { targetAgentId: input.sessionId, runId: input.runId, controlledInput: { inputId: input.inputId, commandId: input.commandId, contentHash: "fixture" }, prepared: input.prepared });
    let nativeText = ""; f.adapter.start = async input => { nativeText = input.input.text; return { status: "accepted", turn: { ...input.binding.scope, kind: "turn", conversationId: "native", nativeId: "result-turn" } }; };
    await reboot.effectWorker.drain(); expect(nativeText).toBe(prepared.runtimeMessage.text);
    expect(canonical).toEqual([expect.objectContaining({ role: "system", source: "worker_report", sourceWorkerId: "worker", text: "status: done\nsummary: Finished the bounded task." })]);
  });
  it("persists every user input option and pinned attachment through restart before dispatch", async () => {
    const f = await fixture(); let submit!: (text: string, options: HandleUserMessageOptions) => Promise<void>;
    const delivered: Array<HandleUserMessageOptions> = []; const acquire = f.options.swarm.acquireProvider;
    const descriptor = { agentId: "manager", role: "manager", profileId: "project", managerId: "manager", model: { provider: "pi", modelId: "fixture" } };
    const swarm = {
      installProviderScopeOwner() {}, installAuthoritativeInputOwner(callback: typeof submit) { submit = callback; }, installControlledTurnProjection() {}, installControlledChoicePort() {}, reflectControlledTurns() {}, installCoreAgentMessagePort() {},
      getAgentForInternalUse: () => descriptor, acquireControlledProvider: acquire,
      async applyControlledInput(text: string, options: HandleUserMessageOptions) { delivered.push(options); return { entryId: "canonical", runtimeMessage: { text } }; },
    } as unknown as Parameters<typeof createSwarmControlAdapter>[0]["swarmManager"];
    const compose = (core: ControlCore) => {
      const artifacts = createArtifactService({ database: core.database, dataDir: path.dirname(f.options.databasePath!) });
      const adapter = createSwarmControlAdapter({ swarmManager: swarm, database: core.database, eventSink: core.eventSink, controlService: core.controlService, workspaceService: f.options.workspace, artifactService: artifacts });
      Object.assign(f.options.swarm, adapter); f.options.artifacts = artifacts;
    };
    compose(f.core);
    const options: HandleUserMessageOptions = { targetAgentId: "manager", delivery: "auto", sourceContext: { channel: "cli", messageId: "source-id" }, replyTo: { messageId: "reply-id" }, clientRequestId: "client-id", commandId: "user-input-command", sessionReferenceAgentIds: ["peer-1", "peer-2"],
      attachments: [{ type: "text", mimeType: "text/plain", fileName: "input.txt", text: "Pinned input bytes" }] };
    await submit("input with options", options); await f.core.close();
    const second = await f.open(); compose(second); await second.effectWorker.drain();
    const { attachments, ...metadata } = options;
    expect(delivered).toHaveLength(1); expect(delivered[0]).toMatchObject(metadata);
    expect(delivered[0].attachments).toEqual([expect.objectContaining(attachments![0])]);
    expect(delivered[0].attachments?.[0].filePath).toContain("artifacts");
    const saved = second.database.prepare("SELECT prepared_json FROM orchestration_run_inputs WHERE run_id=?").get("run-user-input-command") as { prepared_json: string };
    expect(JSON.parse(saved.prepared_json).userOptions).toEqual(metadata);
    expect((await second.controlService.submitInput({ commandId: "unrelated", threadId: "manager", message: { text: "queued", artifactIds: [] } })).receipt.delivery).toBe("pending");
  });
  it("cancels an unmaterialized launch transactionally without creating or stopping a runtime", async () => {
    const f = await fixture(); let materialized = 0; let stops = 0;
    f.options.workspace.prepareLaunch = async input => ({ project: { projectId: "project", title: "Project", cwd: "/fixture", repository: null, isGit: false, defaultBranch: null, updatedAt: new Date(f.options.clock()).toISOString(), sortKey: "project", archived: false }, revision: "1", cwd: "/fixture", model: input.model,
      reservation: { reservationId: input.commandId, repositoryRoot: "/fixture", repositoryCommonDir: "/fixture/.git", kind: input.workspaceStrategy.kind, path: "/fixture", pathKey: "/fixture", branch: null, baseCommit: null, owned: false } });
    f.options.swarm.ensureSession = async () => { materialized++; return { materialized: true }; };
    f.options.swarm.stopSession = async () => { stops++; return { stopped: true }; };
    await f.core.controlService.execute(principal, "session.launch", { commandId, projectId: "project", title: "launch", workspaceStrategy: { kind: "current_checkout" }, initialMessage: { text: "launch", artifactIds: [] } });
    const stopId = "00000000-0000-4000-8000-000000000002"; const threadId = `v2-${commandId}`;
    await f.core.controlService.execute(principal, "session.stop", { commandId: stopId, sessionId: threadId });
    expect(loadState(f.core.database).runs[`run-${commandId}`].state).toBe("terminal");
    await f.core.effectWorker.drain();
    expect({ materialized, stops, dispatches: f.dispatches() }).toEqual({ materialized: 0, stops: 0, dispatches: 0 });
    expect((await f.core.controlService.getReceipt(principal, stopId)).state).toBe("succeeded");
    expect(f.core.database.prepare("SELECT COUNT(*) n FROM workspace_reservations").get()).toEqual({ n: 1 });
  });
  it.each(["clear_session", "delete_session", "archive_session", "stop_all_agents"])("%s fences a claimed canonical append and waits for kernel drain before mutation", async command => {
    const f = await fixture(); let entered!: () => void; let release!: () => void; let mutated = false;
    const enteredAppend = new Promise<void>(resolve => { entered = resolve; }); const heldAppend = new Promise<void>(resolve => { release = resolve; });
    f.options.swarm.applyInput = async input => { entered(); await heldAppend; return { entryId: input.inputId, runtimeMessage: { text: input.message.text } }; };
    await f.core.controlService.execute(principal, "session.send", { commandId, sessionId: "manager", message: { text: "held", artifactIds: [] } });
    const drain = f.core.effectWorker.drain(); await enteredAppend;
    const mutation = f.core.controlService.admitLifecycle(principal, { commandId: "00000000-0000-4000-8000-000000000002", command, sessionIds: ["manager"], intent: "stop", request: { command } }, async () => { expect(loadState(f.core.database).threads.manager.shutdown).toBe("clean"); mutated = true; return { completed: true }; });
    const outcome = mutation.then(value => ({ value }), error => ({ error }));
    const desired = loadState(f.core.database).threads.manager.desired; const mutatedBeforeRelease = mutated;
    release(); await drain;
    expect(desired).toBe("stopped"); expect(mutatedBeforeRelease).toBe(false);
    expect(await outcome).toEqual({ value: { completed: true } });
    expect(f.dispatches()).toBe(0);
    expect((await f.core.controlService.getReceipt(principal, commandId))).toMatchObject({ state: "interrupted", delivery: "none" });
    expect(loadState(f.core.database).runs[`run-${commandId}`].state).toBe("terminal");
  });
  it.each(["session.stop", "worker.kill"] as const)("%s stops the worker in the kernel while preserving its manager", async method => {
    const f = await fixture(); const stopped: string[] = [];
    f.options.swarm.resolveSession = agentId => agentId === "worker" ? { sessionId: "manager", workerId: "worker" } : { sessionId: agentId };
    f.options.swarm.stopSession = async input => { stopped.push(input.sessionId); return { stopped: true }; };
    f.core.eventSink.transaction(tx => f.core.eventSink.append(tx, { topic: "detail", sessionId: "manager", event: { type: "worker.upsert", worker: { agentId: "worker", title: "Worker", status: "idle" } } }));
    await f.core.controlService.submitInput({ commandId: "worker-input", threadId: "worker", thread: { role: "worker", projectId: "project", managerId: "manager" }, message: { text: "worker", artifactIds: [] } });
    await f.core.effectWorker.drain();
    await f.core.controlService.execute(principal, method, method === "worker.kill" ? { commandId, sessionId: "manager", workerId: "worker" } : { commandId, sessionId: "worker" });
    await f.core.effectWorker.drain();
    const state = loadState(f.core.database);
    expect(state.threads.worker).toMatchObject({ desired: "stopped", shutdown: "clean" });
    expect(state.threads.manager.desired).toBe("running");
    expect(stopped).toEqual(["worker"]);
    const row = f.core.database.prepare("SELECT worker_json FROM control_workers WHERE agent_id='worker'").get() as { worker_json: string };
    expect(JSON.parse(row.worker_json).status).toBe("terminated");
    await f.core.close(); const reboot = await f.open();
    expect(JSON.parse((reboot.database.prepare("SELECT worker_json FROM control_workers WHERE agent_id='worker'").get() as typeof row).worker_json).status).toBe("terminated");
    expect((await reboot.controlService.getReceipt(principal, commandId)).state).toBe("succeeded");
  });
  it("accepts and dispatches an input once while receipt completion is independent of run completion", async () => {
    const f = await fixture(); const input = { commandId, sessionId: "manager", message: { text: "fixture", artifactIds: [] } };
    await f.core.controlService.execute(principal, "session.send", input); await f.core.effectWorker.drain();
    const receipt = await f.core.controlService.execute(principal, "session.send", input);
    expect(receipt.delivery).toBe("dispatched"); expect(receipt.state).toBe("succeeded"); expect(f.dispatches()).toBe(1); expect(f.canonical.size).toBe(1);
    expect(loadState(f.core.database).runs[`run-${commandId}`].state).toBe("running");
  });
  it("rechecks revocation after runtime acquisition and before native dispatch", async () => {
    const f = await fixture(); f.options.swarm.applyInput = async input => { f.revoke(); return { entryId: input.inputId, runtimeMessage: { text: input.message.text } }; };
    await f.core.controlService.execute(principal, "session.send", { commandId, sessionId: "manager", message: { text: "fixture", artifactIds: [] } }); await f.core.effectWorker.drain();
    expect(f.dispatches()).toBe(0); expect((await f.core.controlService.getReceipt(principal, commandId)).state).toBe("interrupted");
  });
  it("retains a marked unknown dispatch through two restarts without invoking the provider again", async () => {
    const f = await fixture(); f.adapter.start = async () => { throw new Error("lost acknowledgment"); };
    await f.core.controlService.execute(principal, "session.send", { commandId, sessionId: "manager", message: { text: "fixture", artifactIds: [] } }); await f.core.effectWorker.drain();
    const drained = loadState(f.core.database);
    expect(drained.threads.manager.activeRunId).toBeUndefined();
    expect(drained.runs[`run-${commandId}`].state).toBe("recovery");
    expect(projectLifecycleStatus(drained, "manager")).toEqual({ agentStatus: "error", sessionStatus: "interrupted" });
    expect(JSON.parse((f.core.database.prepare("SELECT summary_json FROM control_sessions WHERE session_id='manager'").get() as { summary_json: string }).summary_json).status).toBe("interrupted");
    const before = loadState(f.core.database).recovery!; expect(before).not.toBeNull(); await f.core.close();
    const second = await f.open(); await second.effectWorker.drain(); expect(loadState(second.database).recovery?.recoveryId).toBe(before.recoveryId); await second.close();
    const third = await f.open(); await third.effectWorker.drain(); expect(loadState(third.database).recovery?.recoveryId).toBe(before.recoveryId);
    expect((await third.controlService.getReceipt(principal, commandId)).delivery).toBe("unknown");
  });
  it.each(["busy", "closed", "stale_scope"] as const)("keeps a typed %s pre-dispatch rejection out of unknown recovery", async reason => {
    const f = await fixture();
    let starts = 0;
    f.adapter.start = async () => {
      // Make an unbounded recovery fail decisively instead of starving timers.
      if (++starts > 2) throw new Error("Fixture exhausted the binding replacement budget");
      throw new ProviderDispatchRejectedError(reason);
    };
    await f.core.controlService.execute(principal, "session.send", { commandId, sessionId: "manager", message: { text: "rejected", artifactIds: [] } });
    await f.core.effectWorker.drain();
    const state = loadState(f.core.database); const run = state.runs[`run-${commandId}`];
    expect(state.attempts[run.activeAttemptId]).toMatchObject({ state: "terminal", delivery: "pending", outcome: "failed" });
    expect(run.state).toBe("terminal");
    expect(state.recovery).toBeNull();
    expect(state.threads.manager.shutdown).toBe("clean");
    expect(starts).toBe(reason === "closed" ? 2 : 1);
    const receipt = await f.core.controlService.getReceipt(principal, commandId);
    expect(receipt.state).toBe("failed"); expect(receipt.delivery).toBe("none");
    await f.core.controlService.execute(principal, "session.send", { commandId: "00000000-0000-4000-8000-000000000002", sessionId: "manager", message: { text: "retry", artifactIds: [] } });
    f.adapter.start = async input => ({ status: "accepted", turn: { ...input.binding.scope, kind: "turn", conversationId: "native", nativeId: "retry-turn" } });
    await f.core.effectWorker.drain();
    expect((await f.core.controlService.getReceipt(principal, "00000000-0000-4000-8000-000000000002")).delivery).toBe("dispatched");
  });
  it("gives internal scoped calls the same durable input, receipt and outbox admission", async () => {
    const f = await fixture();
    const input = { commandId: "tool:manager:attempt:call-1:manager", threadId: "manager", message: { text: "tool input", artifactIds: [] } };
    const first = await f.core.controlService.submitInput(input);
    const second = await f.core.controlService.submitInput(input);
    expect(second.runId).toBe(first.runId);
    expect(second.receipt.acceptedSequence).toBe(first.receipt.acceptedSequence);
    expect(f.core.database.prepare("SELECT COUNT(*) n FROM control_inputs").get()).toEqual({ n: 1 });
    await f.core.effectWorker.drain();
    expect(f.dispatches()).toBe(1);
    expect(JSON.parse((f.core.database.prepare("SELECT receipt_json FROM command_receipts WHERE command_id=?").get(input.commandId) as {receipt_json:string}).receipt_json).delivery).toBe("dispatched");
  });
  it("resumes with the retained conversation locator and a new generation scope", async () => {
    const f = await fixture();
    const acquired: Array<{ scope: import("@forge/protocol").ProviderScope; conversation?: import("@forge/protocol").ProviderConversationRef }> = [];
    const original = f.options.swarm.acquireProvider;
    f.options.swarm.acquireProvider = async (scope, conversation) => { acquired.push({ scope, conversation }); return original(scope, conversation); };
    await f.core.controlService.execute(principal, "session.send", { commandId, sessionId: "manager", message: { text: "fixture", artifactIds: [] } });
    await f.core.effectWorker.drain();
    const old = acquired[0]; await f.core.close();
    const second = await f.open(); const state = loadState(second.database);
    second.controlService.record({ type:"recovery.resume", commandId:"resume", now:f.options.clock(), recoveryId:state.recovery!.recoveryId,
      attempts:{[`run-${commandId}`]:"new-attempt"}, bindingIds:{manager:"new-binding"} });
    await second.effectWorker.drain();
    expect(acquired.at(-1)?.conversation).toEqual({ ...old.scope, kind:"conversation", nativeId:"native" });
    expect(acquired.at(-1)?.scope).toEqual({ threadId:"manager", bindingId:"new-binding", generation:old.scope.generation+1 });
  });

  it("acquires the fallback model selected in the assignment transaction", async () => {
    const f=await fixture(); const models:Array<{threadId:string;model?: {provider:string;modelId:string}}>=[]; const original=f.options.swarm.acquireProvider;
    f.options.swarm.acquireProvider=async (scope,conversation,model)=>{ models.push({ threadId:scope.threadId,model }); return original(scope,conversation,model); };
    await f.core.controlService.execute(principal,"session.send",{ commandId,sessionId:"manager",message:{ text:"parent",artifactIds:[] } });
    await f.core.effectWorker.drain();
    await f.core.controlService.submitInput({ commandId:"assign-call",threadId:"worker",thread:{ role:"worker",projectId:"project",managerId:"manager" },message:{ text:"assignment",artifactIds:[] },
      assignment:{ assignmentId:"assignment",parentThreadId:"manager",parentRunId:`run-${commandId}`,selection:{ specialistId:"specialist",provider:"codex",modelId:"unavailable",maxConcurrent:1,
        candidates:[{ provider:"codex",modelId:"unavailable",available:false },{ provider:"codex",modelId:"selected-fallback",available:true }] } } });
    await f.core.effectWorker.drain();
    expect(models.find(value=>value.threadId === "worker")).toEqual({ threadId:"worker",model:{ provider:"codex",modelId:"selected-fallback" } });
    expect(loadState(f.core.database).assignments.assignment.selection.modelId).toBe("selected-fallback");
  });

});

it("projects authoritative worker status across all directory reads without changing the descriptor", () => {
  const manager = { agentId: "manager", role: "manager", status: "idle", createdAt: "2026-01-01", updatedAt: "2026-01-01", model: { provider: "pi", modelId: "fixture" } } as AgentDescriptor;
  const worker = { ...manager, agentId: "worker", managerId: "manager", role: "worker" } as AgentDescriptor;
  const directory = new AgentDirectory({ descriptors: new Map([["manager", manager], ["worker", worker]]), profiles: new Map(), getPendingChoiceCount: () => 0 });
  directory.installLifecycleStatus(id => id === "worker" ? "terminated" : undefined);
  expect(directory.getAgent("worker")?.status).toBe("terminated");
  expect(directory.getAgentForInternalUse("worker")?.status).toBe("terminated");
  expect(directory.listAgents().find(agent => agent.agentId === "worker")?.status).toBe("terminated");
  expect(directory.listAgentsForInternalUse().find(agent => agent.agentId === "worker")?.status).toBe("terminated");
  expect(directory.listWorkersForSession("manager")[0].status).toBe("terminated");
  expect(worker.status).toBe("idle");
});
