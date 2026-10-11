import { createDetailStream } from "../streams/detail-stream.js";
import { createControlDescriptorPersistence } from './descriptor-persistence.js';
import { createTestEnvironment } from '../../test-support/environment-auth.js';
import * as controlDatabase from './database.js';
import { loadState } from './orchestration/store.js';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { createSessionLifecycleRpc } from "../../ws/rpc/session-lifecycle-rpc.js";
import { SessionFeaturePublisher } from "../../ws/session-feature-publisher.js";
import { createDetailFeatureRpc } from "../../ws/rpc/detail-feature-rpc.js";
import { randomUUID } from "node:crypto";
import { getSessionDir } from "../../swarm/storage/data-paths.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempConfig, TestSwarmManager } from "../../test-support/index.js";
import { createSwarmEventMirror } from "./swarm-event-mirror.js";
import { createProjectPolicy } from "./project-policy.js";
import { createControlCore } from "./database.js";
import { createWorkspaceService } from "./workspace-service.js";
import { createArtifactService } from "./artifact-service.js";
import { createSwarmControlAdapter, createControlledInputRoutePreflight } from "./swarm-control-adapter.js";
import type { SwarmControlPort } from "./control-types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function createFixtureEnvironment(manager: TestSwarmManager) {
  // Capture the actual environment owner only to drain its worker deterministically.
  let core!: Awaited<ReturnType<typeof createControlCore>>;
  const onCreateRuntime = manager.onCreateRuntime;
  manager.onCreateRuntime = async input => {
    await onCreateRuntime?.(input);
    const descriptor = input.descriptor;
    if (!loadState(core.database).threads[descriptor.agentId]) core.controlService.record({ type: "thread.create", commandId: `thread:${descriptor.agentId}`, now: Date.now(), threadId: descriptor.agentId, role: descriptor.role, projectId: descriptor.profileId ?? descriptor.managerId, managerId: descriptor.role === "worker" ? descriptor.managerId : undefined });
    core.controlService.record({ type: "thread.prepare_binding", commandId: `prepare:${randomUUID()}`, now: Date.now(), threadId: descriptor.agentId, bindingId: randomUUID() });
  };
  const create = controlDatabase.createControlCore;
  const capture = vi.spyOn(controlDatabase, "createControlCore").mockImplementation(async options => {
    core = await create({ ...options, isDeviceRevoked: () => false });
    return core;
  });
  try { return { ...await createTestEnvironment(manager, { boot: true }), core }; } finally { capture.mockRestore(); }
}
async function fixture(auth = false) {
  const config = await makeTempConfig({ prefix: "v2-swarm-", omitSharedAuthFile: !auth, ...(auth ? { sharedAuthContent: { "openai-codex": { type: "api_key", key: "forge-fixture-inert-not-a-provider-key" } } } : {}), omitSharedSecretsFile: true });
  const manager = new TestSwarmManager(config);
  const runtimeTokens = new Map<string, number>();
  manager.onCreateRuntime = ({ descriptor, runtime, runtimeToken }) => {
    if (runtimeToken !== undefined) runtimeTokens.set(descriptor.agentId, runtimeToken);
    const native = (runtime as unknown as { sessionManager: SessionManager }).sessionManager;
    native.appendMessage({ role: "assistant", content: [{ type: "text", text: "fixture ready" }] } as never);
  };
  const { environment, core, paired } = await createFixtureEnvironment(manager);
  if (!manager.getAgent("manager")) await manager.createManager("manager", { name: "Manager", cwd: config.defaultCwd });
  await core.effectWorker.drain();
  const bootstrap = manager.runtimeByAgentId.get("manager"); if (bootstrap) { bootstrap.sendCalls = []; bootstrap.nextDeliveryId = 0; }
  const database = environment.database; const eventSink = core.eventSink;
  const workspace = createWorkspaceService({ database, dataDir: config.paths.dataDir, swarmManager: manager });
  const artifacts = createArtifactService({ database, dataDir: config.paths.dataDir, swarmManager: manager });
  const adapter = createSwarmControlAdapter({ swarmManager: manager, database, eventSink, controlService: core.controlService, workspaceService: workspace, artifactService: artifacts });
  let coreClosed = false;
  const close = core.close.bind(core); core.close = async () => { coreClosed = true; await close(); };
  const commandId = randomUUID(); const sessionId = `v2-${commandId}`;
  await adapter.ensureSession({ commandId, sessionId, projectId: "manager", title: "Controlled", cwd: config.defaultCwd });
  await core.effectWorker.drain();
  cleanup.push(async () => { await manager.disposeHistoryRecall(); await environment.stop(); await core.close(); await rm(config.paths.dataDir, { recursive: true, force: true }); });
  const inputId = `input-${randomUUID()}`;
  const input: Parameters<SwarmControlPort["applyInput"]>[0] = {
    commandId: randomUUID(), inputId, sessionId, runGeneration: 1, message: { text: "durable fixture input", artifactIds: [] },
    runId:`run-${inputId}`,
  };
  return { config, manager, database, eventSink, adapter, input, sessionId, commandId, core, artifacts, environment, paired, runtimeTokens, get coreClosed() { return coreClosed; } };
}
function makeMirror(f: Awaited<ReturnType<typeof fixture>>, unread: () => number = () => 0) {
  return createSwarmEventMirror({ swarmManager: f.manager, database: f.database, eventSink: f.eventSink, wireProjection: {
    unread,
    project: async profile => ({ projectId: profile.profileId, title: profile.displayName, cwd: f.config.defaultCwd, repository: null, isGit: false, defaultBranch: null, updatedAt: profile.updatedAt, sortKey: profile.createdAt, archived: false }),
  } });
}
async function makeCore(f: Awaited<ReturnType<typeof fixture>>, manager = f.manager, database = f.database) {
  if (manager === f.manager && database === f.database && !f.coreClosed) return { core: f.core, adapter: f.adapter, artifacts: f.artifacts };
  const workspace = createWorkspaceService({ database, dataDir: f.config.paths.dataDir, swarmManager: manager });
  const artifacts = createArtifactService({ database, dataDir: f.config.paths.dataDir, swarmManager: manager });
  const swarm = new Proxy<SwarmControlPort>(Object.create(null), {
    get(_target,key) { const member=Reflect.get(adapter,key);return typeof member==='function' ? member.bind(adapter):member; },
  });
  const core = await createControlCore({ database, dataDir:f.config.paths.dataDir, clock: Date.now, random: randomUUID,
    swarm,
    policy: createProjectPolicy(manager), workspace, artifacts, isDeviceRevoked: () => false, inputRoute: createControlledInputRoutePreflight({ swarmManager: manager }) });
  const adapter = createSwarmControlAdapter({ swarmManager: manager, database, eventSink: core.eventSink, controlService:core.controlService,workspaceService: workspace, artifactService: artifacts });
  manager.installDescriptorPersistence(createControlDescriptorPersistence({ database, eventSink: core.eventSink, dataDir: f.config.paths.dataDir, storeFilePath: f.config.paths.agentsStoreFile }));
  cleanup.unshift(() => core.close());
  return { core, adapter, artifacts };
}
async function countInputs(file: string, inputId: string) {
  return (await readFile(file, "utf8")).split("\n").filter(line => { try { return JSON.parse(line).data?.id === inputId; } catch { return false; } }).length;
}
describe("controlled swarm canonical/provider boundaries", () => {
  it("publishes boot recovery for cached shell clients resuming the existing epoch", async () => {
    const f = await fixture();
    f.manager.runtimeByAgentId.get(f.sessionId)!.busy = true;
    const principal = f.paired.principal;
    await f.core.controlService.execute(principal, "session.send", { commandId: randomUUID(), sessionId: f.sessionId, message: { text: "interrupted work", artifactIds: [] } });
    await f.core.effectWorker.drain();
    const cursor = f.eventSink.highWater; const epoch = f.eventSink.streamEpoch;
    await f.core.close(); const { core } = await makeCore(f); await core.reconcileOnBoot();
    const snapshot = loadState(f.database).recovery!;
    expect(snapshot.interruptedManagers).toEqual([f.sessionId]);
    expect(core.eventSink.streamEpoch).toBe(epoch);
    const updates = f.database.prepare("SELECT payload_json FROM events WHERE event_type='recovery.upsert' AND sequence>?").all(cursor) as { payload_json: string }[];
    expect(updates.map(row => JSON.parse(row.payload_json).recovery)).toEqual([snapshot]);
    expect(f.manager.getRestartRecoverySnapshot()).toEqual(snapshot);
  });
  it("replays a recovery decision receipt and rejects a fresh decision after resolution", async () => {
    const f = await fixture(); f.manager.runtimeByAgentId.get(f.sessionId)!.busy = true;
    const principal = f.paired.principal;
    await f.core.controlService.execute(principal, "session.send", { commandId: randomUUID(), sessionId: f.sessionId, message: { text: "interrupted work", artifactIds: [] } });
    await f.core.effectWorker.drain(); await f.core.close(); const { core } = await makeCore(f); await core.reconcileOnBoot();
    const snapshot = loadState(f.database).recovery!; const cursor = core.eventSink.highWater;
    const rpc = createDetailFeatureRpc({ swarmManager: f.manager, control: core.controlService });
    const input = { commandId: randomUUID(), recoveryId: snapshot.recoveryId, action: "dismiss" };
    await rpc.execute(principal, "recovery.decide", input); await rpc.execute(principal, "recovery.decide", input);
    await expect(rpc.execute(principal, "recovery.decide", { ...input, commandId: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    const decided = loadState(f.database).recovery!;
    expect(decided).toMatchObject({ ...snapshot, dismissedAt: expect.any(String) });
    const updates = f.database.prepare("SELECT payload_json FROM events WHERE event_type='recovery.upsert' AND sequence>?").all(cursor) as { payload_json: string }[];
    expect(updates.map(row => JSON.parse(row.payload_json).recovery)).toEqual([decided]);
    expect(f.database.prepare("SELECT COUNT(*) n FROM lifecycle_events WHERE event_type='recovery.resolved'").get()).toEqual({ n: 1 });
  });
  it("materializes one reserved ID and one input for concurrent same-command retries", async () => {
    const f = await fixture();
    await Promise.all([f.adapter.ensureSession({ commandId: f.commandId, sessionId: f.sessionId, projectId: "manager", title: "Controlled", cwd: f.config.defaultCwd }), f.adapter.ensureSession({ commandId: f.commandId, sessionId: f.sessionId, projectId: "manager", title: "Controlled", cwd: f.config.defaultCwd })]);
    const principal = f.paired.principal;
    const input = { commandId: f.input.commandId, sessionId: f.sessionId, message: f.input.message };
    const receipts = await Promise.all([f.core.controlService.execute(principal, "session.send", input), f.core.controlService.execute(principal, "session.send", input)]);
    expect(receipts[0]).toEqual(receipts[1]); await f.core.effectWorker.drain();
    expect(await countInputs(f.manager.getAgent(f.sessionId)!.sessionFile, `input-${input.commandId}`)).toBe(1);
    expect(f.manager.runtimeByAgentId.get(f.sessionId)?.sendCalls).toHaveLength(1);
    expect(Object.values(loadState(f.database).runs).filter(run => run.commandId === input.commandId)).toHaveLength(1);
    expect(f.database.prepare("SELECT COUNT(*) n FROM lifecycle_events WHERE event_type='attempt.accepted' AND thread_id=?").get(f.sessionId)).toEqual({ n: 1 });
  });
  it("reconciles JSONL after append/DB crash without a second append", async () => {
    const f = await fixture();
    f.database.exec("CREATE TRIGGER fail_locator BEFORE INSERT ON mirror_sources WHEN NEW.source_key LIKE 'input:%' BEGIN SELECT RAISE(ABORT, 'kill after canonical append'); END");
    await expect(f.adapter.applyInput(f.input)).rejects.toThrow("kill after canonical append");
    expect(f.manager.runtimeByAgentId.get(f.sessionId)?.sendCalls).toHaveLength(0);
    expect(await countInputs(f.manager.getAgent(f.sessionId)!.sessionFile, f.input.inputId)).toBe(1);
    f.database.exec("DROP TRIGGER fail_locator");
    const restartedAdapter = createSwarmControlAdapter({ swarmManager: f.manager, database: f.database, eventSink: f.eventSink, controlService: f.core.controlService, workspaceService: { ensure: async () => ({ cwd: f.config.defaultCwd, branch: null }) }, artifactService: f.artifacts });
    const recorded = await restartedAdapter.applyInput(f.input);
    const canonical = (await readFile(f.manager.getAgent(f.sessionId)!.sessionFile, "utf8")).split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(row => row.data?.id === f.input.inputId);
    expect(recorded.entryId).toBe(canonical.data.timelineEntryId);
    expect(await countInputs(f.manager.getAgent(f.sessionId)!.sessionFile, f.input.inputId)).toBe(1);
    expect(f.manager.runtimeByAgentId.get(f.sessionId)?.sendCalls).toHaveLength(0);
  });
  it("fails closed on writer failure and never dispatches across an unknown marker", async () => {
    const f = await fixture(); const runtime = f.manager.runtimeByAgentId.get(f.sessionId)!;
    const principal = f.paired.principal;
    const commandId = randomUUID();
    const original = runtime.appendCustomEntry.bind(runtime); runtime.appendCustomEntry = () => { throw new Error("disk failed"); };
    await f.core.controlService.execute(principal, "session.send", { commandId, sessionId: f.sessionId, message: f.input.message });
    await f.core.effectWorker.drain();
    expect(await f.core.controlService.getReceipt(principal, commandId)).toMatchObject({ state: "failed", delivery: "none", error: { message: "disk failed" } });
    expect(loadState(f.database).runs[`run-${commandId}`]).toMatchObject({ state: "terminal", outcome: "failed" });
    expect(runtime.sendCalls).toHaveLength(0); runtime.appendCustomEntry = original;
    const ambiguous = randomUUID();
    await f.core.controlService.execute(principal, "session.send", { commandId: ambiguous, sessionId: f.sessionId, message: f.input.message });
    const state = loadState(f.database); const run = state.runs[`run-${ambiguous}`]; const attempt = state.attempts[run.activeAttemptId];
    const result = await f.adapter.applyInput({ ...f.input, commandId: ambiguous, inputId: run.inputId, runId: run.runId, runGeneration: attempt.generation });
    f.core.controlService.record({ type: "input.recorded", commandId: "ambiguous-recorded", now: Date.now(), threadId: f.sessionId, inputId: run.inputId, entryId: result.entryId });
    const resource=await f.adapter.acquireProvider({threadId:f.sessionId,bindingId:attempt.bindingId,generation:attempt.generation});
    f.core.controlService.record({type:'binding.acquired',commandId:'ambiguous-acquired',now:Date.now(),threadId:f.sessionId,binding:resource.binding});
    f.core.controlService.record({ type: "attempt.dispatch", commandId: "ambiguous-marked", now: Date.now(), threadId: f.sessionId, attemptId: attempt.attemptId, authorized: true });
    await f.core.close(); const { core } = await makeCore(f); await core.reconcileOnBoot(); await core.effectWorker.drain();
    expect(await core.controlService.getReceipt(principal, ambiguous)).toMatchObject({ state: "interrupted", delivery: "unknown" });
    expect(runtime.sendCalls).toHaveLength(0);
    expect(loadState(f.database).attempts[attempt.attemptId].state).toBe("unknown");
  });
  it("does not answer a destroyed or different-generation choice continuation", async () => {
    const f = await fixture(); const promise = f.manager.requestUserChoice(f.sessionId, [{ id: "q", question: "Which?", options: [{ id: "a", label: "A" }] }]);
    void promise.catch(() => {}); const choice = f.manager.getPendingChoiceRequestsForSession(f.sessionId)[0]!;
    const generation = (choice as typeof choice & { runtimeGeneration: string }).runtimeGeneration;
    expect(JSON.parse(JSON.stringify(choice))).not.toHaveProperty("runtimeGeneration");
    f.manager.cancelChoiceRequest(choice.choiceId, "cancelled");
    expect(await f.adapter.applyChoice({ commandId: randomUUID(), sessionId: f.sessionId, choiceId: choice.choiceId, runtimeGeneration: generation, answers: [{ questionId: "q", selectedOptionIds: ["a"] }] })).toBe("interrupted");
  });
  it("retains ownership after restart and refuses unsafe runtime cleanup", async () => {
    const f = await fixture(); const descriptor = f.manager.getAgent(f.sessionId)!;
    expect(JSON.parse(await readFile(`${f.config.paths.dataDir}/profiles/manager/sessions/${f.sessionId}/meta.json`, "utf8")).controlCommandId).toBe(f.commandId);
    const stop = vi.spyOn(f.manager, "releaseControlledProvider").mockRejectedValue(new Error("Runtime shutdown is still pending"));
    await expect(f.adapter.stopSession({ commandId: randomUUID(), sessionId: descriptor.agentId })).rejects.toThrow("still pending"); stop.mockRestore();
    for (const agent of f.manager.listAgents().filter(agent => agent.role === "manager")) await f.manager.stopSession(agent.agentId);
    await f.environment.stop();
    const restarted = new TestSwarmManager(f.config);
    const reopened = await createFixtureEnvironment(restarted);
    const artifacts = createArtifactService({ database: reopened.environment.database, dataDir: f.config.paths.dataDir, swarmManager: restarted });
    const resumed = createSwarmControlAdapter({ swarmManager: restarted, database: reopened.environment.database, eventSink: reopened.core.eventSink, controlService: reopened.core.controlService, workspaceService: { ensure: async () => ({ cwd: f.config.defaultCwd, branch: null }) }, artifactService: artifacts });
    await expect(resumed.ensureSession({ commandId: f.commandId, sessionId: f.sessionId, projectId: "manager", title: "Controlled", cwd: f.config.defaultCwd })).resolves.toEqual({ materialized: true });
    expect(restarted.listAgents().filter(agent => agent.agentId === f.sessionId)).toHaveLength(1); for (const agent of restarted.listAgents().filter(agent => agent.role === "manager")) await restarted.stopSession(agent.agentId); await restarted.disposeHistoryRecall();
  });
  it("mirrors bounded lazy detail, repairs a missed canonical append after restart, and reflects unread ownership", async () => {
    const f = await fixture(); let unread = 4; const mirror = makeMirror(f, () => unread);
    mirror.attach(); await mirror.reconcileBeforeReady();
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM detail_items").get()).toEqual({ count: 0 });
    await f.adapter.applyInput(f.input); await mirror.ensureDetailInitialized(f.sessionId);
    const baseline = f.database.prepare("SELECT COUNT(*) AS count FROM detail_items WHERE session_id=?").get(f.sessionId) as { count: number };
    expect(baseline.count).toBe(1); mirror.dispose();
    const runtime = f.manager.runtimeByAgentId.get(f.sessionId)!;
    const id = randomUUID(); runtime.appendCustomEntry("swarm_conversation_entry", { type: "conversation_message", agentId: f.sessionId, role: "assistant", source: "system", text: "synthetic finalized answer", timestamp: new Date().toISOString(), id, timelineEntryId: id });
    const restarted = makeMirror(f, () => unread); restarted.attach(); await restarted.reconcileBeforeReady(); await restarted.ensureDetailInitialized(f.sessionId);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM detail_items WHERE session_id=?").get(f.sessionId)).toEqual({ count: 2 });
    await restarted.ensureDetailInitialized(f.sessionId); expect(f.database.prepare("SELECT COUNT(*) AS count FROM events WHERE source_key LIKE ?").get(`%${id}`)).toEqual({ count: 1 });
    unread = 0; restarted.notifyUnreadChanged(f.sessionId);
    const row = f.database.prepare("SELECT summary_json FROM control_sessions WHERE session_id=?").get(f.sessionId) as { summary_json: string };
    expect(JSON.parse(row.summary_json).unread).toBe(0);
    const catalog = vi.spyOn(f.manager, "listAgentsForInternalUse");
    for (let index = 0; index < 40; index++) f.manager.emit("agent_status", { type: "agent_status", agentId: f.sessionId, status: "idle", pendingCount: 0, contextUsage: { tokens: index } });
    expect(catalog).not.toHaveBeenCalled(); catalog.mockRestore(); restarted.dispose();
  });
  it("mirrors only persisted deltas and repairs skipped events without losing the source checkpoint", async () => {
    const f = await fixture(); const mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady(); await mirror.ensureDetailInitialized(f.sessionId);
    const runtime = f.manager.runtimeByAgentId.get(f.sessionId)!;
    const ghost = { type: "conversation_message" as const, agentId: f.sessionId, role: "assistant" as const, source: "system" as const, text: "not persisted", timestamp: new Date().toISOString(), id: randomUUID(), timelineEntryId: randomUUID() };
    f.manager.emit("conversation_message", ghost);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM detail_items WHERE session_id=?").get(f.sessionId)).toEqual({ count: 0 });
    const missed = { ...ghost, id: randomUUID(), timelineEntryId: randomUUID(), text: "missed live event" };
    runtime.appendCustomEntry("swarm_conversation_entry", missed);
    const observed = { ...ghost, id: randomUUID(), timelineEntryId: randomUUID(), text: "observed live event" };
    runtime.appendCustomEntry("swarm_conversation_entry", observed); f.manager.emit("conversation_message", observed);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM detail_items WHERE session_id=?").get(f.sessionId)).toEqual({ count: 2 });
    const file = f.manager.getAgent(f.sessionId)!.sessionFile;
    const header = (await readFile(file, "utf8")).split("\n")[0]!; await writeFile(file, `${header}\n`);
    await mirror.ensureDetailInitialized(f.sessionId);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM detail_items WHERE session_id=?").get(f.sessionId)).toEqual({ count: 0 });
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM events WHERE payload_json LIKE '%detail.reset%'").get()).toEqual({ count: 1 }); mirror.dispose();
  });

  it("pages canonical user turns, reads bounded content and fences history cursors after reset", async () => {
    const f = await fixture(); const runtime = f.manager.runtimeByAgentId.get(f.sessionId)!;
    const principal = { deviceSessionId: "history-device", scopes: new Set(["session:read"] as const) };
    f.database.prepare("INSERT INTO device_sessions (device_session_id,token_hash,proof_thumbprint,device_name,kind,scopes_json,created_at,last_seen_at,expires_at) VALUES ('history-device','fixture-token','fixture-proof','Fixture','cli','[]',0,0,?)").run(Date.now() + 86_400_000);
    const longId = randomUUID(); const fullText = "é".repeat(10000);
    for (let turn = 0; turn < 25; turn++) {
      for (const role of ["user", "assistant"] as const) {
        const id = turn === 0 && role === "assistant" ? longId : randomUUID();
        runtime.appendCustomEntry("swarm_conversation_entry", { type: "conversation_message", agentId: f.sessionId, role, source: role === "user" ? "user_input" : "system", text: id === longId ? fullText : `${role} ${turn}`, timestamp: new Date(Date.now() + turn * 2 + (role === "assistant" ? 1 : 0)).toISOString(), id, timelineEntryId: id });
      }
    }
    let mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady();
    const detail = await mirror.ensureDetailInitialized(f.sessionId); expect(detail.historyCursor).toBeTruthy(); expect(detail.historyCursor!.length).toBeLessThanOrEqual(512);
    const recent = f.database.prepare("SELECT item_json FROM detail_items WHERE session_id=?").all(f.sessionId) as { item_json: string }[];
    expect(recent.filter(row => JSON.parse(row.item_json).kind === "user")).toHaveLength(20);
    mirror.dispose(); mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady();
    const older = await mirror.readHistory(principal, { sessionId: f.sessionId, before: detail.historyCursor!, turns: 3 });
    expect(older.items.filter(item => item.kind === "user").map(item => item.text)).toEqual(["user 2", "user 3", "user 4"]); expect(older.nextCursor).toBeTruthy();
    const oldest = await mirror.readHistory(principal, { sessionId: f.sessionId, before: older.nextCursor!, turns: 3 });
    expect(oldest.items.filter(item => item.kind === "user").map(item => item.text)).toEqual(["user 0", "user 1"]); expect(oldest.nextCursor).toBeNull();
    const content = await mirror.readContent(principal, { sessionId: f.sessionId, contentRef: longId, offset: 0, maxBytes: 1001 });
    expect(Buffer.byteLength(content.text)).toBe(1000); expect(content.nextOffset).toBe(1000);
    const rest = await mirror.readContent(principal, { sessionId: f.sessionId, contentRef: longId, offset: content.nextOffset!, maxBytes: 262144 });
    expect(content.text + rest.text).toBe(fullText); expect(rest.nextOffset).toBeNull();
    const latestTurn = JSON.parse(recent.find(row => JSON.parse(row.item_json).text === "user 24")!.item_json).userTurnId;
    const live = { type: "conversation_message" as const, agentId: f.sessionId, role: "assistant" as const, source: "system" as const, text: "answer after reading old history", timestamp: new Date(Date.now() + 1000).toISOString(), id: randomUUID(), timelineEntryId: randomUUID() };
    runtime.appendCustomEntry("swarm_conversation_entry", live); f.manager.emit("conversation_message", live);
    const projected = f.database.prepare("SELECT item_json FROM detail_items WHERE session_id=? AND item_id=?").get(f.sessionId, live.timelineEntryId) as { item_json: string };
    expect(JSON.parse(projected.item_json).userTurnId).toBe(latestTurn);
    const giantId = randomUUID(); runtime.appendCustomEntry("swarm_conversation_entry", { type: "conversation_message", agentId: f.sessionId, role: "assistant", source: "system", text: "g".repeat(5 * 1024 * 1024), timestamp: new Date().toISOString(), id: giantId, timelineEntryId: giantId });
    expect(await mirror.readContent(principal, { sessionId: f.sessionId, contentRef: giantId, offset: 100, maxBytes: 100 })).toEqual({ text: "g".repeat(100), nextOffset: 200 });
    const file = f.manager.getAgent(f.sessionId)!.sessionFile; const header = (await readFile(file, "utf8")).split("\n")[0]!; await writeFile(file, `${header}\n`);
    await expect(mirror.readHistory(principal, { sessionId: f.sessionId, before: detail.historyCursor!, turns: 3 })).rejects.toMatchObject({ code: "RESYNC_REQUIRED" });
    await expect(mirror.readContent({ ...principal, scopes: new Set() }, { sessionId: f.sessionId, contentRef: longId, offset: 0, maxBytes: 10 })).rejects.toMatchObject({ code: "FORBIDDEN" }); mirror.dispose();
  });

  it("rejects unowned reserved directories and conflicting manifests while retaining their files", async () => {
    const f = await fixture(); const commandId = randomUUID(); const sessionId = `v2-${commandId}`;
    const directory = getSessionDir(f.config.paths.dataDir, "manager", sessionId); await mkdir(directory); await writeFile(`${directory}/foreign`, "retained");
    await expect(f.adapter.ensureSession({ commandId, sessionId, projectId: "manager", title: "Unowned", cwd: f.config.defaultCwd })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(`${directory}/foreign`, "utf8")).toBe("retained"); expect(f.manager.getAgent(sessionId)).toBeUndefined();
    const metaPath = `${getSessionDir(f.config.paths.dataDir, "manager", f.sessionId)}/meta.json`; const meta = JSON.parse(await readFile(metaPath, "utf8"));
    await writeFile(metaPath, JSON.stringify({ ...meta, controlCommandId: randomUUID() }));
    await expect(f.adapter.ensureSession({ commandId: f.commandId, sessionId: f.sessionId, projectId: "manager", title: "Conflict", cwd: f.config.defaultCwd })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.manager.runtimeByAgentId.get(f.sessionId)).toBeDefined();
    const recoveredCommand = randomUUID(); const recoveredId = `v2-${recoveredCommand}`;
    const recoveredDirectory = getSessionDir(f.config.paths.dataDir, "manager", recoveredId); await mkdir(recoveredDirectory);
    await writeFile(`${recoveredDirectory}/meta.json`, JSON.stringify({ ...meta, sessionId: recoveredId, controlCommandId: recoveredCommand }));
    await expect(f.adapter.ensureSession({ commandId: recoveredCommand, sessionId: recoveredId, projectId: "manager", title: "Recovered partial", cwd: f.config.defaultCwd })).resolves.toEqual({ materialized: true });
    expect(f.manager.listAgents().filter(agent => agent.agentId === recoveredId)).toHaveLength(1); expect(f.manager.runtimeByAgentId.get(recoveredId)).toBeDefined();
    expect(f.manager.getAgent(recoveredId)).not.toHaveProperty("controlCommandId"); expect(f.manager.getAgentForInternalUse(recoveredId)?.controlCommandId).toBe(recoveredCommand);
  });

  it("interrupts persisted choices whose Promise generation was destroyed", async () => {
    const f = await fixture();
    const pending = f.manager.requestUserChoice(f.sessionId, [{ id: "q", question: "Decision?", options: [{ id: "a", label: "A" }] }]); void pending.catch(() => {});
    const choice = f.manager.getPendingChoiceRequestsForSession(f.sessionId)[0]!;
    expect(f.database.prepare("SELECT state FROM control_choices WHERE choice_id=?").get(choice.choiceId)).toEqual({ state: "pending" });
    await f.environment.stop();
    const restarted = new TestSwarmManager(f.config);
    const { environment } = await createFixtureEnvironment(restarted);
    expect(restarted.getPendingChoiceRequestsForSession(f.sessionId)).toEqual([]);
    expect(environment.database.prepare("SELECT state FROM control_choices WHERE choice_id=?").get(choice.choiceId)).toEqual({ state: "interrupted" });
    await restarted.disposeHistoryRecall();
  });
  it("reports incomplete cleanup from the real shutdown barrier without creating a second writer", async () => {
    const f = await fixture(); const runtime = f.manager.runtimeByAgentId.get(f.sessionId)!;
    const terminate = vi.spyOn(runtime, "terminate").mockRejectedValue(new Error("synthetic shutdown failure"));
    expect(await f.adapter.stopSession({ commandId: randomUUID(), sessionId: f.sessionId })).toEqual({ stopped: false });
    await expect(f.adapter.applyInput(f.input)).rejects.toThrow(); expect(runtime.sendCalls).toHaveLength(0); terminate.mockRestore();
    await f.manager.stopSession(f.sessionId);
  });

  it("uses the real durable core for concurrent launch/send retries, route rejection, choices and safe stop", async () => {
    const f = await fixture(true); const { core } = await makeCore(f);
    cleanup.unshift(() => core.close());
    const principal = { deviceSessionId: "fixture-device", scopes: new Set(["session:operate", "session:read", "workspace:write"] as const) };
    f.database.prepare("INSERT INTO device_sessions (device_session_id,token_hash,proof_thumbprint,device_name,kind,scopes_json,created_at,last_seen_at,expires_at) VALUES ('fixture-device','fixture-token','fixture-proof','Fixture','cli','[]',0,0,?)").run(Date.now() + 86_400_000);
    const launch = { commandId: randomUUID(), projectId: "manager", title: "Core controlled", workspaceStrategy: { kind: "current_checkout" as const }, initialMessage: { text: "first persisted core input", artifactIds: [] } };
    const receipts = await Promise.all(Array.from({ length: 10 }, () => core.controlService.execute(principal, "session.launch", launch)));
    expect(new Set(receipts.map(receipt => receipt.sessionId)).size).toBe(1); await core.reconcileOnBoot(); await core.effectWorker.drain();
    const sessionId = receipts[0]!.sessionId!;
    expect((await core.controlService.getReceipt(principal, launch.commandId)).state).toBe("succeeded");
    expect(await countInputs(f.manager.getAgent(sessionId)!.sessionFile, `input-${launch.commandId}`)).toBe(1);
    const send = { commandId: randomUUID(), sessionId, message: { text: "second persisted core input", artifactIds: [] } };
    await Promise.all([core.controlService.execute(principal, "session.send", send), core.controlService.execute(principal, "session.send", send)]); await core.effectWorker.drain();
    expect((await core.controlService.getReceipt(principal, send.commandId)).delivery).toBe("dispatched");
    expect(f.manager.runtimeByAgentId.get(sessionId)?.sendCalls).toHaveLength(2);
    expect(await countInputs(f.manager.getAgent(sessionId)!.sessionFile, `input-${send.commandId}`)).toBe(1);
    const unsupported = { commandId: randomUUID(), sessionId, message: { text: "/compact", artifactIds: [] } };
    await expect(core.controlService.execute(principal, "session.send", unsupported)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(f.database.prepare("SELECT 1 FROM commands WHERE command_id=?").get(unsupported.commandId)).toBeUndefined();
    const mirror = createSwarmEventMirror({ swarmManager: f.manager, database: f.database, eventSink: core.eventSink, wireProjection: {
      unread: () => 0, project: async profile => ({ projectId: profile.profileId, title: profile.displayName, cwd: f.config.defaultCwd, repository: null, isGit: false, defaultBranch: null, updatedAt: profile.updatedAt, sortKey: profile.createdAt, archived: false }),
    } }); mirror.attach(); await mirror.reconcileBeforeReady(); cleanup.unshift(async () => mirror.dispose());
    const pending = f.manager.requestUserChoice(sessionId, [{ id: "q", question: "Continue?", options: [{ id: "a", label: "Yes" }] }]);
    const choice = f.manager.getPendingChoiceRequestsForSession(sessionId)[0]!;
    const choose = { commandId: randomUUID(), sessionId, choiceId: choice.choiceId, answers: [{ questionId: "q", selectedOptionIds: ["a"] }] };
    await core.controlService.execute(principal, "session.choose", choose); await core.effectWorker.drain();
    expect(await pending).toEqual(choose.answers); expect((await core.controlService.getReceipt(principal, choose.commandId)).state).toBe("succeeded");
    await core.controlService.execute(principal, "session.stop", { commandId: randomUUID(), sessionId }); await core.effectWorker.drain();
    expect(f.manager.isSessionShutdownSafe(sessionId)).toBe(true);
  });

  it("settles a stop whose runtime exits after the shutdown window and then runs the next send on a new runtime", async () => {
    const f = await fixture(true); const { core } = await makeCore(f);
    const principal = { deviceSessionId: "fixture-device", scopes: new Set(["session:operate", "session:read", "workspace:write"] as const) };
    f.database.prepare("INSERT INTO device_sessions (device_session_id,token_hash,proof_thumbprint,device_name,kind,scopes_json,created_at,last_seen_at,expires_at) VALUES ('fixture-device','fixture-token','fixture-proof','Fixture','cli','[]',0,0,?)").run(Date.now() + 86_400_000);
    const launch = { commandId: randomUUID(), projectId: "manager", title: "Slow stop", workspaceStrategy: { kind: "current_checkout" as const }, initialMessage: { text: "first turn", artifactIds: [] } };
    const sessionId = (await core.controlService.execute(principal, "session.launch", launch)).sessionId!; await core.reconcileOnBoot(); await core.effectWorker.drain();
    const held = f.manager.runtimeByAgentId.get(sessionId)!; expect(held.sendCalls).toHaveLength(1);
    // The real shutdown barrier owns this attempt; the runtime simply takes longer than its window to exit.
    let exit!: () => void; const exited = new Promise<void>(resolve => { exit = resolve; });
    const terminate = vi.spyOn(held, "terminate").mockImplementation(() => exited);
    const stop = { commandId: randomUUID(), sessionId };
    await core.controlService.execute(principal, "session.stop", stop); await core.effectWorker.drain();
    expect(loadState(f.database).threads[sessionId]).toMatchObject({ desired: "stopped", shutdown: "pending" });
    expect(await core.controlService.getReceipt(principal, stop.commandId)).toMatchObject({ state: "running", error: null });
    const send = { commandId: randomUUID(), sessionId, message: { text: "after the slow stop", artifactIds: [] } };
    await expect(core.controlService.execute(principal, "session.send", send)).rejects.toMatchObject({ code: "CONFLICT" });
    exit();
    await vi.waitFor(async () => { await core.effectWorker.drain(); expect((await core.controlService.getReceipt(principal, stop.commandId)).state).toBe("succeeded"); }, { timeout: 10_000, interval: 50 });
    expect(terminate).toHaveBeenCalledOnce(); expect(f.manager.isSessionShutdownSafe(sessionId)).toBe(true);
    expect(loadState(f.database).threads[sessionId]).toMatchObject({ desired: "stopped", shutdown: "clean" });
    await core.controlService.execute(principal, "session.send", send); await core.effectWorker.drain();
    expect(await core.controlService.getReceipt(principal, send.commandId)).toMatchObject({ state: "succeeded", delivery: "dispatched" });
    const replacement = f.manager.runtimeByAgentId.get(sessionId)!; expect(replacement).not.toBe(held);
    expect(replacement.sendCalls).toHaveLength(1); expect(held.sendCalls).toHaveLength(1);
    expect(await countInputs(f.manager.getAgent(sessionId)!.sessionFile, `input-${send.commandId}`)).toBe(1);
  }, 30_000);
  it("reopens the real DB/runtime after the canonical seam and never replays an ambiguous provider marker", async () => {
    const f = await fixture(); const core = f.core; const adapter = f.adapter;
    const principal = f.paired.principal;
    const send = { commandId: randomUUID(), sessionId: f.sessionId, message: { text: "restart seam input", artifactIds: [] } };
    await core.controlService.execute(principal, "session.send", send);
    const run = loadState(f.database).runs[`run-${send.commandId}`]; const attempt = loadState(f.database).attempts[run.activeAttemptId];
    f.database.prepare("UPDATE effects SET state='claimed',claimed_boot_id='dead-boot' WHERE kind='transcript.append' AND command_id=?").run(send.commandId);
    f.database.exec("CREATE TRIGGER fail_locator BEFORE INSERT ON mirror_sources WHEN NEW.source_key LIKE 'input:%' BEGIN SELECT RAISE(ABORT, 'synthetic crash after JSONL'); END");
    await expect(adapter.applyInput({ ...send, inputId: run.inputId, runId: run.runId, runGeneration: attempt.generation })).rejects.toThrow("synthetic crash");
    expect(await countInputs(f.manager.getAgent(f.sessionId)!.sessionFile, run.inputId)).toBe(1);
    f.database.exec("DROP TRIGGER fail_locator"); await f.environment.stop();
    const restarted = new TestSwarmManager(f.config);
    restarted.onCreateRuntime = ({ runtime }) => { const native = (runtime as unknown as { sessionManager: SessionManager }).sessionManager; native.appendMessage({ role: "assistant", content: [{ type: "text", text: "fixture ready" }] } as never); };
    const reopened = await createFixtureEnvironment(restarted); await reopened.core.effectWorker.drain();
    expect(await reopened.core.controlService.getReceipt(principal, send.commandId)).toMatchObject({ state: "succeeded", delivery: "dispatched" });
    expect(await countInputs(restarted.getAgent(f.sessionId)!.sessionFile, run.inputId)).toBe(1); expect(restarted.runtimeByAgentId.get(f.sessionId)?.sendCalls).toHaveLength(1);
    const ambiguous = { commandId: randomUUID(), sessionId: f.sessionId, message: { text: "marker ambiguity fixture", artifactIds: [] } };
    await reopened.core.controlService.execute(principal, "session.send", ambiguous);
    const next = loadState(reopened.environment.database); const nextRun = next.runs[`run-${ambiguous.commandId}`]; const nextAttempt = next.attempts[nextRun.activeAttemptId];
    const artifacts = createArtifactService({ database: reopened.environment.database, dataDir: f.config.paths.dataDir, swarmManager: restarted });
    const nextAdapter = createSwarmControlAdapter({ swarmManager: restarted, database: reopened.environment.database, eventSink: reopened.core.eventSink, controlService: reopened.core.controlService, workspaceService: { ensure: async () => ({ cwd: f.config.defaultCwd, branch: null }) }, artifactService: artifacts });
    const recorded = await nextAdapter.applyInput({ ...ambiguous, inputId: nextRun.inputId, runId: nextRun.runId, runGeneration: nextAttempt.generation });
    reopened.core.controlService.record({ type: "input.recorded", commandId: "ambiguous-recorded", now: Date.now(), threadId: f.sessionId, inputId: nextRun.inputId, entryId: recorded.entryId });
    reopened.core.controlService.record({ type: "attempt.dispatch", commandId: "ambiguous-dispatch", now: Date.now(), threadId: f.sessionId, attemptId: nextAttempt.attemptId, authorized: true });
    reopened.environment.database.prepare("UPDATE effects SET state='claimed',claimed_boot_id='dead-boot' WHERE kind='provider.start'").run();
    await reopened.environment.stop(); await restarted.disposeHistoryRecall();
    const finalManager = new TestSwarmManager(f.config); const final = await createFixtureEnvironment(finalManager); await final.core.effectWorker.drain();
    expect(await final.core.controlService.getReceipt(principal, ambiguous.commandId)).toMatchObject({ state: "interrupted", delivery: "unknown" });
    expect(loadState(final.environment.database).attempts[nextAttempt.attemptId].state).toBe("unknown");
    expect(finalManager.runtimeByAgentId.get(f.sessionId)?.sendCalls ?? []).toHaveLength(0);
    expect(await countInputs(finalManager.getAgent(f.sessionId)!.sessionFile, nextRun.inputId)).toBe(1);
    await finalManager.disposeHistoryRecall();
  });

});


it("the composed swarm port routes a typed worker stop to the owning manager lane", async () => {
  const f = await fixture(); const mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady();
  const { core } = await makeCore(f);
  try {
    const worker = await f.manager.spawnAgent(f.sessionId, { agentId: "controlled-worker" });
    const principal = { deviceSessionId: randomUUID(), scopes: new Set(["session:operate" as const]) };
    const commandId = randomUUID();
    await core.controlService.execute(principal, "session.stop", { commandId, sessionId: worker.agentId }); await core.effectWorker.drain();
    expect(await core.controlService.getReceipt(principal, commandId)).toMatchObject({ state: "succeeded", sessionId: worker.agentId });
    expect(loadState(f.database).threads[worker.agentId]).toMatchObject({ desired: "stopped", shutdown: "clean" });
    expect(loadState(f.database).threads[worker.agentId].activeRunId).toBeUndefined();
    const detail = createDetailStream({ database: f.database, getDescriptor: () => f.environment.descriptor(), subscribeCommitted: listener => core.eventSink.subscribe(listener), withReadBarrier: fn => core.eventSink.readBarrier(fn).value });
    await vi.waitFor(async () => {
      const visibleWorker = (await detail.workers(principal, { sessionId: f.sessionId })).workers.find(row => row.agentId === worker.agentId);
      expect({ facade: f.manager.getAgent(worker.agentId)?.status, detail: visibleWorker?.status }).toEqual({ facade: expect.stringMatching(/^(stopped|terminated)$/), detail: expect.stringMatching(/^(stopped|terminated)$/) });
    });
    expect(f.manager.isSessionShutdownSafe(worker.agentId)).toBe(true);
    expect(f.manager.runtimeByAgentId.get(worker.agentId)?.terminateCalls).toHaveLength(1);
    expect(f.database.prepare("SELECT desired_state FROM control_sessions WHERE session_id=?").get(f.sessionId)).toEqual({ desired_state: "running" });
    expect(f.manager.runtimeByAgentId.has(f.sessionId)).toBe(true);
  } finally { mirror.dispose(); await core.close(); }
});

it("native resume/fork/clear/delete and cancellation replay one persisted result", async () => {
  const f = await fixture(); const mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady();
  const { core } = await makeCore(f); await core.reconcileOnBoot(); core.effectWorker.start();
  const principal = { deviceSessionId: "cli", scopes: new Set(["session:operate", "session:read"] as const) };
  const lifecycle = createSessionLifecycleRpc({ swarmManager: f.manager, control: core.controlService });
  const call = async (method: Parameters<typeof lifecycle.execute>[1] | 'session.fork', input: object) => {
    const receipt = method==='session.fork'
      ? await core.controlService.execute(principal,method,input as Parameters<typeof core.controlService.execute<'session.fork'>>[2])
      : await lifecycle.execute(principal, method, input);
    for (let i = 0; i < 100; i++) {
      const current = await core.controlService.getReceipt(principal, receipt.commandId);
      if (!["accepted", "running"].includes(current.state)) return current;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Lifecycle receipt did not settle");
  };
  try {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const held = core.controlService.admitLifecycle(principal, { commandId: randomUUID(), command: "fork_session", sessionIds: [f.sessionId], intent: "inspect", request: {} }, async () => { await barrier; return {}; });
    await expect(call("session.resume", { sessionId: f.sessionId, commandId: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT", retryable: true });
    release(); await held;
    await core.controlService.execute(principal, "session.stop", { commandId: randomUUID(), sessionId: f.sessionId }); await core.effectWorker.drain();
    for (const method of ["session.resume", "session.fork", "session.clear", "session.delete"] as const) {
      const input = { sessionId: f.sessionId, commandId: randomUUID(), ...(method === "session.fork" ? { title: "CLI fork" } : {}) };
      if (method === "session.delete") {
        void f.manager.requestUserChoice(f.sessionId, [{ id: "q", question: "Pick", options: [{ id: "a", label: "A" }] }]).catch(() => {});
        const choice = f.manager.getPendingChoiceRequestsForSession(f.sessionId)[0]!;
        const cancel = { sessionId: f.sessionId, choiceId: choice.choiceId, commandId: randomUUID() };
        const cancelled = await call("session.choice.cancel", cancel); expect(cancelled.state).toBe("succeeded"); expect(await call("session.choice.cancel", cancel)).toEqual(cancelled);
      }
      const first = await call(method, input); expect(first, JSON.stringify(first)).toMatchObject({ state: "succeeded" });
      expect(await call(method, input)).toEqual(first);
    }
    expect(f.manager.listAgents().filter(agent => agent.sessionLabel === "CLI fork")).toHaveLength(1);
  } finally { mirror.dispose(); await core.close(); }
}, 15_000);

it.each(["project.archive", "project.delete"] as const)("V2 %s fences the profile's accepted session input", async type => {
  const f = await fixture(); const mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady();
  const { core } = await makeCore(f);
  const principal = { deviceSessionId: "profile-device", scopes: new Set(["session:operate", "workspace:write"] as const) };
  f.database.prepare("INSERT INTO device_sessions (device_session_id,token_hash,proof_thumbprint,device_name,kind,scopes_json,created_at,last_seen_at,expires_at) VALUES ('profile-device','fixture-token','fixture-proof','Fixture','cli','[]',0,0,?)").run(Date.now() + 86_400_000);
  const handler = new SessionFeaturePublisher({ swarmManager: f.manager });
  const access = { authorize: () => {} } as never; handler.setEnvironmentControl({ access, control: core.controlService });
  try {
    const send = await core.controlService.execute(principal, "session.send", { commandId: randomUUID(), sessionId: f.sessionId, message: { text: "must not dispatch after teardown", artifactIds: [] } });
    await core.controlService.execute(principal, type, { commandId: randomUUID(), projectId: "manager" });
    await core.effectWorker.drain();
    expect(await core.controlService.getReceipt(principal, send.commandId)).toMatchObject({ state: "interrupted", delivery: "none" });
  } finally { mirror.dispose(); await core.close(); }
});

it("restart recovery dismissal cannot alter the work graph across accepted input", async () => {
  const f = await fixture(); const mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady(); const { core } = await makeCore(f);
  const principal = { deviceSessionId: "dismiss-device", scopes: new Set(["session:operate"] as const) };
  f.database.prepare("INSERT INTO device_sessions (device_session_id,token_hash,proof_thumbprint,device_name,kind,scopes_json,created_at,last_seen_at,expires_at) VALUES ('dismiss-device','fixture-token','fixture-proof','Fixture','cli','[]',0,0,?)").run(Date.now() + 86_400_000);
  const snapshot = vi.spyOn(f.manager, "getRestartRecoverySnapshot").mockReturnValue({ recoveryId: "boot", bootId: "boot", createdAt: new Date().toISOString(), interruptedManagers: [f.sessionId], interruptedWorkers: [], undeliveredReports: [] });
  const handler = new SessionFeaturePublisher({ swarmManager: f.manager });
  const access = { authorize: () => {} } as never; handler.setEnvironmentControl({ access, control: core.controlService });
  try {
    await core.controlService.execute(principal, "session.send", { commandId: randomUUID(), sessionId: f.sessionId, message: { text: "accepted input", artifactIds: [] } });
    await expect(createDetailFeatureRpc({ swarmManager: f.manager, control: core.controlService }).execute(principal, "recovery.decide", { commandId: randomUUID(), recoveryId: "boot", action: "dismiss" })).rejects.toMatchObject({ code: "CONFLICT", retryable: true });
  } finally { snapshot.mockRestore(); mirror.dispose(); await core.close(); }
});

it("typed terminal catalog fans out to shared mounted scopes and stops after release", async () => {
  const f = await fixture();
  const mounted = ["manager", f.sessionId];
  const principal = { deviceSessionId: "catalog-device", scopes: new Set(["session:read"] as const) };
  const handler = new SessionFeaturePublisher({ swarmManager: f.manager,
    listTerminalsForSession: () => [],
 });
  handler.setEnvironmentControl({ access: { authorize: () => {} } as never, control: {} as never });
  const controllers = mounted.map(() => new AbortController());
  const streams = mounted.map((sessionId, i) => handler.detailFeatures(principal, { sessionId }, controllers[i]!.signal)[Symbol.asyncIterator]());
  try {
    for (const stream of streams) expect((await stream.next()).value).toMatchObject({ event: { type: "terminals.snapshot", scopeId: "manager" } });
    const terminal = { terminalId: "catalog-terminal", sessionAgentId: "manager", profileId: "manager", name: "Shell", shell: "/bin/sh", cwd: "/fixture", cols: 80, rows: 24,
      state: "running" as const, pid: null, exitCode: null, exitSignal: null, recoveredFromPersistence: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    handler.publish({ type: "terminal_created", sessionAgentId: "manager", terminal });
    for (const stream of streams) {
      let item;
      do { item = (await stream.next()).value; } while (item?.event.type !== "terminal.upsert");
      expect(item).toMatchObject({ event: { type: "terminal.upsert", scopeId: "manager", terminal } });
    }
    controllers[0]!.abort(); await streams[0]!.return?.();
    handler.publish({ type: "terminal_closed", sessionAgentId: "unmounted-profile", terminalId: terminal.terminalId, reason: "user_closed" });
    handler.publish({ type: "terminal_closed", sessionAgentId: "manager", terminalId: terminal.terminalId, reason: "user_closed" });
    expect((await streams[1]!.next()).value).toMatchObject({ event: { type: "terminal.closed", scopeId: "manager" } });
    expect(await streams[0]!.next()).toMatchObject({ done: true });
  } finally { for (const controller of controllers) controller.abort(); for (const stream of streams) await stream.return?.(); }
});

it("typed secure presentation sends worker metadata to its owning manager", async () => {
  const f = await fixture();
  const worker = await f.manager.spawnAgent("manager", { agentId: "secure-detail-worker" });
  const principal = { deviceSessionId: "secure-detail-device", scopes: new Set(["session:read"] as const) };
  const handler = new SessionFeaturePublisher({ swarmManager: f.manager,
    listTerminalsForSession: () => [],
 });
  handler.setEnvironmentControl({ access: { authorize: () => {} } as never, control: {} as never });
  const controllers = [new AbortController()];
  const deadline = setTimeout(() => { for (const controller of controllers) controller.abort(); }, 1000);
  const streams = ["manager"].map((sessionId, i) => handler.detailFeatures(principal, { sessionId }, controllers[i]!.signal)[Symbol.asyncIterator]());
  try {
    for (const stream of streams) await stream.next();
    const snapshot = await f.manager.getSecureSessionSnapshot(worker.agentId);
    handler.publishSecureSnapshot({ type: "secure_session_snapshot", ...snapshot, revision: 100, sessionAgentId: worker.agentId, principalKind: "worker", ownerManagerAgentId: "manager", workerAssignmentId: "assignment-test" });
    for (const stream of streams) {
      let item;
      do { item = (await stream.next()).value; if (!item) throw new Error("Missing typed secure fanout"); } while (item.event.type !== "secure.upsert" || item.event.snapshot.revision !== 100);
      expect(item.event.snapshot).toMatchObject({ sessionAgentId: worker.agentId, ownerManagerAgentId: "manager" });
    }
  } finally { clearTimeout(deadline); for (const controller of controllers) controller.abort(); for (const stream of streams) await stream.return?.(); }
});


describe("Phase 2 project/policy commands", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["settings.recommendedDefaults.apply", {}],
    ["workspace.directories.create", { parentPath: ".", name: "typed-dir" }],
    ["project.create", { title: "Typed project", cwd: ".", model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "high" } }],
    ["project.update", { projectId: "manager", patch: { title: "Renamed" } }],
    ["project.update", { projectId: "manager", patch: { cwd: "." } }],
    ["project.update", { projectId: "manager", patch: { modelDefault: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "high" } } }],
    ["project.update", { projectId: "manager", patch: { delegationDefaults: { managerPosture: "hands_on" } } }],
    ["project.update", { projectId: "manager", patch: { contextMode: "fresh" } }],
    ["project.archive", { projectId: "manager" }],
    ["project.restore", { projectId: "manager" }],
    ["project.delete", { projectId: "manager" }],
    ["project.reorder", { projectIds: ["manager"] }],
    ["session.configure", { sessionId: "manager", model: { mode: "inherit" } }],
    ["session.configure", { sessionId: "manager", model: { mode: "override", provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "high" } }],
    ["session.configure", { sessionId: "manager", delegation: { managerPosture: { mode: "override", value: "hands_on" } } }],
    ["session.configure", { sessionId: "manager", contextMode: "fresh" }],
  ];
  it.each(cases)("moves %s %j into receipt-backed control", async (method, fields) => {
    const f = await fixture(true); const { core } = await makeCore(f);
    cleanup.unshift(() => core.close());
    const mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady(); cleanup.unshift(async () => mirror.dispose());
    const principal = { deviceSessionId: "policy-device", scopes: new Set(["workspace:write", "session:operate", "settings:admin"] as const) };
    if (method === "settings.recommendedDefaults.apply") vi.spyOn(f.manager, "applyRecommendedManagerDefaults").mockResolvedValue({ profileIds: ["manager"], rosterId: "fixture", rosterRevision: 1 });
    const request = { commandId: randomUUID(), ...fields, ...(fields.cwd ? { cwd: f.config.defaultCwd } : {}), ...(fields.parentPath ? { parentPath: f.config.defaultCwd } : {}), ...(fields.patch && (fields.patch as { cwd?: string }).cwd ? { patch: { ...(fields.patch as object), cwd: f.config.defaultCwd } } : {}) };
    const receipt = await core.controlService.execute(principal, method as "session.stop", request as never);
    expect(receipt.state).toBe("succeeded");
    expect(receipt.method).toBe(method);
    expect(await core.controlService.execute(principal, method as "session.stop", request as never)).toEqual(receipt);
    expect(f.database.prepare("SELECT method FROM commands WHERE command_id=?").get(request.commandId)).toEqual({ method });
  });
});

it("preserves project onboarding under admission and never bootstraps a duplicate creation", async () => {
  const f = await fixture(true); const { core } = await makeCore(f);
  cleanup.unshift(() => core.close());
  const mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady(); cleanup.unshift(async () => mirror.dispose());
  const principal = { deviceSessionId: "policy-device", scopes: new Set(["workspace:write"] as const) };
  const input = { commandId: randomUUID(), title: "Onboarding", cwd: f.config.defaultCwd, model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "high" } };
  const original = f.manager.sendMessage.bind(f.manager);
  const send = vi.spyOn(f.manager, "sendMessage").mockImplementation(async (...args) => {
    if (args[4]?.internalDeliveryKind === "bootstrap") {
      expect(core.database.prepare("SELECT state FROM effects WHERE command_id=? AND session_id=?").get(input.commandId, "project:project-" + input.commandId)).toEqual({ state: "claimed" });
      expect((await core.controlService.getReceipt(principal, input.commandId)).state).toBe("running");
    }
    return original(...args);
  });
  const receipt = await core.controlService.execute(principal, "project.create", input);
  expect(receipt.state).toBe("succeeded");
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[4]).toMatchObject({ origin: "internal", internalDeliveryKind: "bootstrap" });
  await core.effectWorker.drain();
  expect(f.manager.runtimeByAgentId.get(receipt.result!.sessionId!)!.sendCalls).toHaveLength(1);
  expect(await core.controlService.execute(principal, "project.create", input)).toEqual(receipt);
  expect(send).toHaveBeenCalledTimes(1);
});

it("marks lost policy claims interrupted on restart and never repeats the callback", async () => {
  const f = await fixture(true); let { core } = await makeCore(f);
  const mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady();
  const principal = { deviceSessionId: "policy-device", scopes: new Set(["workspace:write"] as const) };
  const input = { commandId: randomUUID(), projectId: "manager", patch: { title: "Durable title" } };
  await core.controlService.execute(principal, "project.update", input);
  core.database.prepare("UPDATE effects SET state='claimed' WHERE command_id=?").run(input.commandId);
  core.database.prepare("UPDATE command_receipts SET state='running',receipt_json=json_set(receipt_json,'$.state','running') WHERE command_id=?").run(input.commandId);
  await core.close(); mirror.dispose(); ({ core } = await makeCore(f)); cleanup.unshift(() => core.close());
  const apply = vi.spyOn(f.manager, "renameProfile");
  expect((await core.controlService.getReceipt(principal, input.commandId)).state).toBe("interrupted");
  expect((await core.controlService.execute(principal, "project.update", input)).state).toBe("interrupted");
  expect(apply).not.toHaveBeenCalled();
});


it.each(["stopped", "error", "queued"] as const)("native worker.kill under %s manager preserves ownership, input and replay", async state => {
  const f = await fixture(); const mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady();
  const { core } = await makeCore(f);
  const principal = { deviceSessionId: "kill-device", scopes: new Set(["session:operate", "session:read"] as const) };
  f.database.prepare("INSERT INTO device_sessions (device_session_id,token_hash,proof_thumbprint,device_name,kind,scopes_json,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?, ?,0,0,?)").run(principal.deviceSessionId, "synthetic-kill-token", "synthetic-kill-proof", "Review kill", "cli", JSON.stringify([...principal.scopes]), Date.now()+86400000);
  const lifecycle = createSessionLifecycleRpc({ swarmManager: f.manager, control: core.controlService });
  try {
    const worker = await f.manager.spawnAgent(f.sessionId, { agentId: "review-worker" });
    const queuedId = randomUUID();
    if (state === "queued") await core.controlService.execute(principal, "session.send", { commandId: queuedId, sessionId: f.sessionId, message: { text: "keep this manager input", artifactIds: [] } });
    else if (state === "stopped") {
      await core.controlService.execute(principal, "session.stop", { commandId: randomUUID(), sessionId: f.sessionId });
      await core.effectWorker.drain();
      expect(f.manager.getAgent(f.sessionId)?.status).toBe("stopped");
    } else {
      f.manager.runtimeByAgentId.get(f.sessionId)!.busy = true;
      await core.controlService.execute(principal, "session.send", { commandId: randomUUID(), sessionId: f.sessionId, message: { text: "manager transport becomes unknown", artifactIds: [] } });
      await core.effectWorker.drain();
      const current = loadState(f.database); const run = current.runs[current.threads[f.sessionId].activeRunId!];
      core.controlService.record({ type: "attempt.unknown", commandId: randomUUID(), now: Date.now(), threadId: f.sessionId, attemptId: run.activeAttemptId });
      await core.effectWorker.drain();
      expect(loadState(f.database).runs[run.runId].state, JSON.stringify(loadState(f.database).threads[f.sessionId])).toBe("recovery");
      expect(f.manager.getAgent(f.sessionId)?.status).toBe("error");
    }
    const input = { commandId: randomUUID(), sessionId: f.sessionId, workerId: worker.agentId };
    await expect(lifecycle.execute(principal, "worker.kill", { ...input, commandId: randomUUID(), sessionId: "manager" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const receipt = await lifecycle.execute(principal, "worker.kill", input);
    expect(["accepted", "succeeded"]).toContain(receipt.state);
    if (state === "queued") expect(await core.controlService.getReceipt(principal, queuedId)).toMatchObject({ state: "accepted", delivery: "pending" });
    await core.effectWorker.drain();
    expect(await core.controlService.getReceipt(principal, input.commandId)).toMatchObject({ state: "succeeded", method: "worker.kill" });
    expect(loadState(f.database).threads[worker.agentId]).toMatchObject({ desired: "stopped", shutdown: "clean" });
    expect(loadState(f.database).threads[worker.agentId].activeRunId).toBeUndefined();
    const detail = createDetailStream({ database: f.database, getDescriptor: () => f.environment.descriptor(), subscribeCommitted: listener => core.eventSink.subscribe(listener), withReadBarrier: fn => core.eventSink.readBarrier(fn).value });
    await vi.waitFor(async () => {
      const visibleWorker = (await detail.workers(principal, { sessionId: f.sessionId })).workers.find(row => row.agentId === worker.agentId);
      expect({ facade: f.manager.getAgent(worker.agentId)?.status, detail: visibleWorker?.status }).toEqual({ facade: expect.stringMatching(/^(stopped|terminated)$/), detail: expect.stringMatching(/^(stopped|terminated)$/) });
    });
    expect(f.manager.isSessionShutdownSafe(worker.agentId)).toBe(true);
    expect(f.manager.runtimeByAgentId.get(worker.agentId)?.terminateCalls).toHaveLength(1);
    expect(f.database.prepare("SELECT desired_state FROM control_sessions WHERE session_id=?").get(f.sessionId)).toEqual({ desired_state: state === "stopped" ? "stopped" : "running" });
    const parentSummary = f.database.prepare("SELECT summary_json FROM control_sessions WHERE session_id=?").get(f.sessionId) as { summary_json: string };
    expect(JSON.parse(parentSummary.summary_json).status).toBe(state === "stopped" ? "stopped" : state === "error" ? "interrupted" : "idle");
    expect(f.manager.getAgent(f.sessionId)?.status).toBe(state === "error" ? "error" : state === "stopped" ? "stopped" : "idle");
    if (state === "queued") expect(await core.controlService.getReceipt(principal, queuedId)).toMatchObject({ state: "succeeded", delivery: "dispatched" });
    expect(await lifecycle.execute(principal, "worker.kill", input)).toMatchObject({ state: "succeeded" });
  } finally { mirror.dispose(); await core.close(); }
});

it.each(["running", "stopped", "error", "queued"] as const)("worker.delete under %s manager removes only its fenced worker and replays after persistence", async state => {
  const f = await fixture(); const mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady();
  const { core } = await makeCore(f); core.effectWorker.start();
  const principal = f.paired.principal;
  const lifecycle = createSessionLifecycleRpc({ swarmManager: f.manager, control: core.controlService });
  try {
    const worker = await f.manager.spawnAgent(f.sessionId, { agentId: "delete-worker" });
    const workerRuntime = f.manager.runtimeByAgentId.get(worker.agentId)!;
    workerRuntime.busy = true;
    await core.controlService.submitInput({ commandId: randomUUID(), threadId: worker.agentId, message: { text: "Work until deleted", artifactIds: [] } });
    await core.effectWorker.drain();
    expect(loadState(f.database).threads[worker.agentId].activeRunId).toBeDefined();
    const queuedId = randomUUID();
    if (state === "queued") await core.controlService.execute(principal, "session.send", { commandId: queuedId, sessionId: f.sessionId, message: { text: "Preserve the manager input", artifactIds: [] } });
    else if (state === "stopped") {
      await core.controlService.execute(principal, "session.stop", { commandId: randomUUID(), sessionId: f.sessionId });
      await core.effectWorker.drain();
    } else if (state === "error") {
      f.manager.runtimeByAgentId.get(f.sessionId)!.busy = true;
      await core.controlService.execute(principal, "session.send", { commandId: randomUUID(), sessionId: f.sessionId, message: { text: "Unknown manager transport", artifactIds: [] } });
      await core.effectWorker.drain();
      const current = loadState(f.database); const run = current.runs[current.threads[f.sessionId].activeRunId!];
      core.controlService.record({ type: "attempt.unknown", commandId: randomUUID(), now: Date.now(), threadId: f.sessionId, attemptId: run.activeAttemptId });
      await core.effectWorker.drain();
    }
    const input = { commandId: randomUUID(), sessionId: f.sessionId, workerId: worker.agentId };
    await expect(lifecycle.execute(principal, "worker.delete", { ...input, commandId: randomUUID(), sessionId: "manager" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const receipt = await lifecycle.execute(principal, "worker.delete", input);
    expect(receipt).toMatchObject({ state: "succeeded", method: "worker.delete" });
    expect(f.manager.getAgent(worker.agentId)).toBeUndefined();
    expect(workerRuntime.terminateCalls).toHaveLength(1);
    expect(loadState(f.database).threads[worker.agentId]).toMatchObject({ desired: "stopped", shutdown: "clean" });
    expect(f.database.prepare("SELECT deleted,descriptor_json FROM control_workers WHERE agent_id=?").get(worker.agentId)).toEqual({ deleted: 1, descriptor_json: null });
    const detail = createDetailStream({ database: f.database, getDescriptor: () => f.environment.descriptor(), subscribeCommitted: listener => core.eventSink.subscribe(listener), withReadBarrier: fn => core.eventSink.readBarrier(fn).value });
    expect((await detail.workers(principal, { sessionId: f.sessionId })).workers.some(row => row.agentId === worker.agentId)).toBe(false);
    await expect(detail.detail(principal, { sessionId: worker.agentId }, new AbortController().signal).next()).rejects.toMatchObject({ code: "NOT_FOUND" });
    const persisted = await createControlDescriptorPersistence({ database: f.database, eventSink: core.eventSink, dataDir: f.config.paths.dataDir, storeFilePath: f.config.paths.agentsStoreFile }).load();
    expect(persisted.agents.some(agent => agent.agentId === worker.agentId)).toBe(false);
    expect(f.database.prepare("SELECT desired_state FROM control_sessions WHERE session_id=?").get(f.sessionId)).toEqual({ desired_state: state === "stopped" ? "stopped" : "running" });
    if (state === "queued") expect(await core.controlService.getReceipt(principal, queuedId)).toMatchObject({ state: "succeeded", delivery: "dispatched" });
    expect(await lifecycle.execute(principal, "worker.delete", input)).toEqual(receipt);
  } finally { mirror.dispose(); await core.close(); }
}, 15_000);

it.each([false, true])("durable send provenance derives CLI integration (%s), ignores client source and survives replay", async cli => {
  const f = await fixture(); const mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady();
  const { core } = await makeCore(f);
  const principal = { deviceSessionId: "source-device", scopes: new Set(["session:operate"] as const), ...(cli ? { integration: "cli" as const } : {}) };
  f.database.prepare("INSERT INTO device_sessions (device_session_id,token_hash,proof_thumbprint,device_name,kind,scopes_json,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?, ?,0,0,?)").run(principal.deviceSessionId, "synthetic-source-token", "synthetic-source-proof", "Review source", cli ? "cli" : "browser", JSON.stringify([...principal.scopes]), Date.now()+86400000);
  const input = { commandId: randomUUID(), sessionId: f.sessionId, message: { text: "provenance acceptance", artifactIds: [] }, ...(!cli ? { source: { channel: "cli" as const, messageId: randomUUID() } } : {}) };
  try {
    await core.controlService.execute(principal, "session.send", input); await core.effectWorker.drain();
    const file = f.manager.getAgent(f.sessionId)!.sessionFile;
    const messages = (await readFile(file, "utf8")).split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const message = messages.find(row => row.data?.id === "input-" + input.commandId)?.data;
    expect(message).toBeTruthy();
    expect(message.sourceContext?.channel).toBe(cli ? "cli" : "web");
    expect(await core.controlService.execute(principal, "session.send", input)).toMatchObject({ state: "succeeded" });
    expect(await countInputs(file, "input-" + input.commandId)).toBe(1);
  } finally { mirror.dispose(); await core.close(); }
});

// Recovery must drain only the failed provider. Stopping its manager's whole
// session would cancel healthy workers and manufacture a manual Stop notice.
it("releases a manager binding without stopping its healthy worker", async () => {
  const f = await fixture();
  const worker = await f.manager.spawnAgent(f.sessionId, { agentId: "healthy-worker" });
  await f.core.effectWorker.drain();
  const child = f.manager.runtimeByAgentId.get(worker.agentId)!;
  const parent = f.manager.runtimeByAgentId.get(f.sessionId)!;
  const terminate = parent.terminate.bind(parent);
  parent.terminate = async options => {
    await f.manager.handleRuntimeStatus(f.runtimeTokens.get(f.sessionId)!, f.sessionId, "terminated", 0);
    await terminate(options);
  };
  const before = (await f.manager.getConversationHistory(f.sessionId)).length;
  expect(await f.adapter.stopSession({ commandId: randomUUID(), sessionId: f.sessionId })).toEqual({ stopped: true });
  expect(parent.terminateCalls).toHaveLength(1);
  expect(child.terminateCalls).toHaveLength(0);
  expect(f.manager.runtimeByAgentId.has(worker.agentId)).toBe(true);
  expect(await f.manager.getConversationHistory(f.sessionId)).toHaveLength(before);
  // Native termination releases a binding; the core still owns the session's
  // running lifecycle and permits the next input to acquire its replacement.
  const commandId = randomUUID();
  await expect(f.core.controlService.execute(f.paired.principal, "session.send", { commandId, sessionId: f.sessionId, message: { text: "Recover the released binding", artifactIds: [] } })).resolves.toMatchObject({ commandId });
  await f.core.effectWorker.drain();
  await vi.waitFor(async () => {
    await f.core.effectWorker.drain();
    const receipt = await f.core.controlService.getReceipt(f.paired.principal, commandId);
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ state: "succeeded" });
  });
  expect(child.terminateCalls).toHaveLength(0);
});

it("completes Stop all after native termination callbacks release the session's bindings", async () => {
  const f = await fixture();
  f.manager.runtimeByAgentId.get(f.sessionId)!.busy = true;
  await f.core.controlService.execute(f.paired.principal, "session.send", { commandId: randomUUID(), sessionId: f.sessionId, message: { text: "Hold this turn", artifactIds: [] } });
  await f.core.effectWorker.drain();
  const worker = await f.manager.spawnAgent(f.sessionId, { agentId: "stop-all-worker" });
  await f.core.effectWorker.drain();
  for (const agentId of [f.sessionId, worker.agentId]) {
    const runtime = f.manager.runtimeByAgentId.get(agentId)!;
    const terminate = runtime.terminate.bind(runtime);
    runtime.terminate = async options => {
      await f.manager.handleRuntimeStatus(f.runtimeTokens.get(agentId)!, agentId, "terminated", 0);
      await terminate(options);
    };
  }
  const lifecycle = createSessionLifecycleRpc({ control: f.core.controlService, swarmManager: f.manager });
  const receipt = await lifecycle.execute(f.paired.principal, "session.stopAll", { commandId: randomUUID(), sessionId: f.sessionId });
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ state: "succeeded" });
  expect(f.manager.isSessionShutdownSafe(f.sessionId)).toBe(true);
});
