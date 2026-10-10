import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { CliWsHandler } from "../../ws/cli-ws-handler.js";
import { WsHandler } from "../../ws/ws-handler.js";
import { createDetailFeatureRpc } from "../../ws/rpc/detail-feature-rpc.js";
import { randomUUID } from "node:crypto";
import { getSessionDir } from "../../swarm/storage/data-paths.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempConfig, TestSwarmManager, bootWithDefaultManager } from "../../test-support/index.js";
import { loadConfiguredSqliteDatabaseConstructor } from "../../sqlite-database-loader.js";
import { migrateControlDatabase } from "./migrations.js";
import { createEventSink } from "./event-sink.js";
import { createSwarmEventMirror } from "./swarm-event-mirror.js";
import { createProjectPolicy } from "./project-policy.js";
import { createControlCore } from "./database.js";
import { createWorkspaceService } from "./workspace-service.js";
import { createArtifactService } from "./artifact-service.js";
import { createSwarmControlAdapter, createControlledInputRoutePreflight } from "./swarm-control-adapter.js";
import type { SwarmControlPort } from "./control-types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(auth = false) {
  const config = await makeTempConfig({ prefix: "v2-swarm-", omitSharedAuthFile: !auth, ...(auth ? { sharedAuthContent: { "openai-codex": { type: "api_key", key: "forge-fixture-inert-not-a-provider-key" } } } : {}), omitSharedSecretsFile: true });
  const manager = new TestSwarmManager(config); await bootWithDefaultManager(manager, config);
  const Database = await loadConfiguredSqliteDatabaseConstructor(); const database = new Database(`${config.paths.dataDir}/control.sqlite`);
  migrateControlDatabase(database, { environmentId: randomUUID(), streamEpoch: randomUUID() });
  const eventSink = createEventSink(database, Date.now, randomUUID);
  const artifactService = { attachmentsForInput: async () => [] };
  const adapter = createSwarmControlAdapter({ swarmManager: manager, database, eventSink, workspaceService: { ensure: async () => ({ cwd: config.defaultCwd, branch: null }) }, artifactService });
  const commandId = randomUUID(); const sessionId = `v2-${commandId}`;
  await adapter.ensureSession({ commandId, sessionId, projectId: "manager", title: "Controlled", cwd: config.defaultCwd });
  cleanup.push(async () => { for (const agent of manager.listAgents().filter(agent => agent.role === "manager")) await manager.stopSession(agent.agentId); await manager.disposeHistoryRecall(); eventSink.close(); if (database.open) database.close(); await rm(config.paths.dataDir, { recursive: true, force: true }); });
  const inputId = `input-${randomUUID()}`;
  const input: Parameters<SwarmControlPort["applyInput"]>[0] = {
    commandId: randomUUID(), inputId, sessionId, runGeneration: 1, message: { text: "durable fixture input", artifactIds: [] },
    onCanonicalAppend: vi.fn(async () => {}), beforeDispatch: vi.fn(async () => "dispatch" as const), onDispatchAccepted: vi.fn(async () => {}),
  };
  return { config, manager, database, eventSink, adapter, input, sessionId, commandId };
}
function makeMirror(f: Awaited<ReturnType<typeof fixture>>, unread: () => number = () => 0) {
  return createSwarmEventMirror({ swarmManager: f.manager, database: f.database, eventSink: f.eventSink, wireProjection: {
    unread,
    project: async profile => ({ projectId: profile.profileId, title: profile.displayName, cwd: f.config.defaultCwd, repository: null, isGit: false, defaultBranch: null, updatedAt: profile.updatedAt, sortKey: profile.createdAt, archived: false }),
  } });
}
async function makeCore(f: Awaited<ReturnType<typeof fixture>>, manager = f.manager, database = f.database) {
  const workspace = createWorkspaceService({ database, dataDir: f.config.paths.dataDir, swarmManager: manager });
  const artifacts = createArtifactService({ database, dataDir: f.config.paths.dataDir, swarmManager: manager });
  const core = await createControlCore({ database, clock: Date.now, random: randomUUID,
    swarm: { resolveSession: id => adapter.resolveSession!(id), ensureSession: input => adapter.ensureSession(input), applyInput: input => adapter.applyInput(input), applyChoice: input => adapter.applyChoice(input), stopSession: input => adapter.stopSession(input) },
    policy: createProjectPolicy(manager), workspace, artifacts, isDeviceRevoked: () => false, inputRoute: createControlledInputRoutePreflight({ swarmManager: manager }) });
  const adapter = createSwarmControlAdapter({ swarmManager: manager, database, eventSink: core.eventSink, workspaceService: workspace, artifactService: artifacts });
  return { core, adapter, artifacts };
}
async function countInputs(file: string, inputId: string) {
  return (await readFile(file, "utf8")).split("\n").filter(line => { try { return JSON.parse(line).data?.id === inputId; } catch { return false; } }).length;
}
describe("controlled swarm canonical/provider boundaries", () => {
  it("publishes boot recovery for cached shell clients resuming the existing epoch", async () => {
    const f = await fixture(); const mirror = makeMirror(f);
    const snapshot = { bootId: "boot", createdAt: new Date().toISOString(), interruptedManagers: [f.sessionId], interruptedWorkers: [], undeliveredReports: [] };
    vi.spyOn(f.manager, "getRestartRecoverySnapshot").mockReturnValue(snapshot);
    const cursor = f.eventSink.highWater; mirror.attach(); await mirror.reconcileBeforeReady();
    const updates = f.database.prepare("SELECT payload_json FROM events WHERE event_type='recovery.upsert' AND sequence>?").all(cursor) as { payload_json: string }[];
    expect(updates.map(row => JSON.parse(row.payload_json).recovery)).toEqual([{ ...snapshot, recoveryId: "boot" }]); mirror.dispose();
  });
  it("publishes one decided recovery update even if the facade also emits and its read projection is stale", async () => {
    const f = await fixture(); const mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady();
    const cursor = f.eventSink.highWater;
    const snapshot = { bootId: "boot", createdAt: new Date().toISOString(), interruptedManagers: [f.sessionId], interruptedWorkers: [], undeliveredReports: [] };
    vi.spyOn(f.manager, "getRestartRecoverySnapshot").mockReturnValue(snapshot);
    const decided = { ...snapshot, dismissedAt: snapshot.createdAt };
    vi.spyOn(f.manager, "dismissRestartRecovery").mockImplementation(async () => { f.manager.emit("restart_recovery_snapshot", { type: "restart_recovery_snapshot", snapshot: decided }); return decided; });
    const { core } = await makeCore(f);
    const principal = { deviceSessionId: "fixture-device", scopes: new Set(["session:operate"] as const) };
    f.database.prepare("INSERT INTO device_sessions (device_session_id,token_hash,proof_thumbprint,device_name,kind,scopes_json,created_at,last_seen_at,expires_at) VALUES ('fixture-device','fixture-token','fixture-proof','Fixture','cli','[]',0,0,?)").run(Date.now() + 86_400_000);
    const rpc = createDetailFeatureRpc({ swarmManager: f.manager, control: core.controlService });
    const input = { commandId: randomUUID(), recoveryId: "boot", action: "dismiss" };
    await rpc.execute(principal, "recovery.decide", input); await rpc.execute(principal, "recovery.decide", input);
    await rpc.execute(principal, "recovery.decide", { ...input, commandId: randomUUID() });
    const updates = f.database.prepare("SELECT payload_json FROM events WHERE event_type='recovery.upsert' AND sequence>?").all(cursor) as { payload_json: string }[];
    expect(updates.map(row => JSON.parse(row.payload_json).recovery)).toEqual([{ ...decided, recoveryId: "boot" }]);
    mirror.dispose(); core.eventSink.close();
  });
  it("materializes one reserved ID and one input for concurrent same-command retries", async () => {
    const f = await fixture();
    await Promise.all([f.adapter.ensureSession({ commandId: f.commandId, sessionId: f.sessionId, projectId: "manager", title: "Controlled", cwd: f.config.defaultCwd }), f.adapter.ensureSession({ commandId: f.commandId, sessionId: f.sessionId, projectId: "manager", title: "Controlled", cwd: f.config.defaultCwd })]);
    let dispatched = false;
    f.input.beforeDispatch = vi.fn(async () => { if (dispatched) return "do-not-dispatch"; dispatched = true; return "dispatch"; });
    await Promise.all([f.adapter.applyInput(f.input), f.adapter.applyInput(f.input)]);
    expect(await countInputs(f.manager.getAgent(f.sessionId)!.sessionFile, f.input.inputId)).toBe(1);
    expect(f.manager.runtimeByAgentId.get(f.sessionId)?.sendCalls).toHaveLength(1);
    expect(f.input.onDispatchAccepted).toHaveBeenCalledTimes(1);
  });
  it("reconciles JSONL after append/DB crash without a second append", async () => {
    const f = await fixture(); f.input.onCanonicalAppend = vi.fn(async () => { throw new Error("kill after canonical append"); });
    await expect(f.adapter.applyInput(f.input)).rejects.toThrow("kill after canonical append");
    expect(f.manager.runtimeByAgentId.get(f.sessionId)?.sendCalls).toHaveLength(0);
    f.input.onCanonicalAppend = vi.fn(async () => {});
    const restartedAdapter = createSwarmControlAdapter({ swarmManager: f.manager, database: f.database, eventSink: f.eventSink, workspaceService: { ensure: async () => ({ cwd: f.config.defaultCwd, branch: null }) }, artifactService: { attachmentsForInput: async () => [] } });
    await restartedAdapter.applyInput(f.input);
    expect(await countInputs(f.manager.getAgent(f.sessionId)!.sessionFile, f.input.inputId)).toBe(1);
  });
  it("fails closed on writer failure and never dispatches across an unknown marker", async () => {
    const f = await fixture(); const runtime = f.manager.runtimeByAgentId.get(f.sessionId)!;
    const original = runtime.appendCustomEntry.bind(runtime); runtime.appendCustomEntry = () => { throw new Error("disk failed"); };
    await expect(f.adapter.applyInput(f.input)).rejects.toThrow("disk failed");
    expect(f.input.beforeDispatch).not.toHaveBeenCalled(); expect(f.input.onCanonicalAppend).not.toHaveBeenCalled();
    runtime.appendCustomEntry = original; f.input.beforeDispatch = vi.fn(async () => "do-not-dispatch");
    expect(await f.adapter.applyInput(f.input)).toEqual({ delivery: "unknown" }); expect(runtime.sendCalls).toHaveLength(0);
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
    const stop = vi.spyOn(f.manager, "stopSession").mockRejectedValue(new Error("Runtime shutdown is still pending"));
    await expect(f.adapter.stopSession({ commandId: randomUUID(), sessionId: descriptor.agentId })).rejects.toThrow("still pending"); stop.mockRestore();
    for (const agent of f.manager.listAgents().filter(agent => agent.role === "manager")) await f.manager.stopSession(agent.agentId); const restarted = new TestSwarmManager(f.config); await bootWithDefaultManager(restarted, f.config);
    const resumed = createSwarmControlAdapter({ swarmManager: restarted, database: f.database, eventSink: f.eventSink, workspaceService: { ensure: async () => ({ cwd: f.config.defaultCwd, branch: null }) }, artifactService: { attachmentsForInput: async () => [] } });
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
    const f = await fixture(); const mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady();
    const pending = f.manager.requestUserChoice(f.sessionId, [{ id: "q", question: "Decision?", options: [{ id: "a", label: "A" }] }]); void pending.catch(() => {});
    const choice = f.manager.getPendingChoiceRequestsForSession(f.sessionId)[0]!;
    expect(f.database.prepare("SELECT state FROM control_choices WHERE choice_id=?").get(choice.choiceId)).toEqual({ state: "pending" });
    mirror.dispose(); f.manager.cancelChoiceRequest(choice.choiceId, "cancelled");
    const restarted = makeMirror(f); restarted.attach(); await restarted.reconcileBeforeReady();
    expect(f.database.prepare("SELECT state FROM control_choices WHERE choice_id=?").get(choice.choiceId)).toEqual({ state: "interrupted" }); restarted.dispose();
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

  it("reopens the real DB/runtime after the canonical seam and never replays an ambiguous provider marker", async () => {
    const f = await fixture(); let { core, adapter } = await makeCore(f);
    f.database.prepare("INSERT INTO device_sessions (device_session_id,token_hash,proof_thumbprint,device_name,kind,scopes_json,created_at,last_seen_at,expires_at) VALUES ('device','fixture-token','fixture-proof','Fixture','cli','[]',0,0,?)").run(Date.now() + 86_400_000);
    const principal = { deviceSessionId: "device", scopes: new Set(["session:operate", "session:read"] as const) };
    const launch = { commandId: randomUUID(), projectId: "manager", title: "Restart fixture", workspaceStrategy: { kind: "current_checkout" as const } };
    const accepted = await core.controlService.execute(principal, "session.launch", launch); await core.reconcileOnBoot(); await core.effectWorker.drain(); const sessionId = accepted.sessionId!;
    const send = { commandId: randomUUID(), sessionId, message: { text: "restart seam input", artifactIds: [] } };
    await core.controlService.execute(principal, "session.send", send);
    f.database.prepare("UPDATE effects SET state='claimed',claimed_boot_id='dead-boot' WHERE command_id=?").run(send.commandId);
    await expect(adapter.applyInput({ ...send, inputId: `input-${send.commandId}`, runGeneration: 0, beforeDispatch: async () => "dispatch", onCanonicalAppend: async () => { throw new Error("synthetic crash after JSONL"); }, onDispatchAccepted: async () => {} })).rejects.toThrow("synthetic crash");
    await core.close(); for (const agent of f.manager.listAgents().filter(agent => agent.role === "manager")) await f.manager.stopSession(agent.agentId); f.database.close();
    const Database = await loadConfiguredSqliteDatabaseConstructor(); const reopened = new Database(`${f.config.paths.dataDir}/control.sqlite`);
    const restarted = new TestSwarmManager(f.config); await bootWithDefaultManager(restarted, f.config);
    ({ core, adapter } = await makeCore(f, restarted, reopened));
    cleanup.unshift(async () => { await core.close(); for (const agent of restarted.listAgents().filter(agent => agent.role === "manager")) await restarted.stopSession(agent.agentId); await restarted.disposeHistoryRecall(); reopened.close(); });
    await core.reconcileOnBoot(); await core.effectWorker.drain();
    expect((await core.controlService.getReceipt(principal, send.commandId)).delivery).toBe("dispatched");
    expect(await countInputs(restarted.getAgent(sessionId)!.sessionFile, `input-${send.commandId}`)).toBe(1); expect(restarted.runtimeByAgentId.get(sessionId)?.sendCalls).toHaveLength(1);
    const ambiguous = { commandId: randomUUID(), sessionId, message: { text: "marker ambiguity fixture", artifactIds: [] } };
    await core.controlService.execute(principal, "session.send", ambiguous);
    reopened.prepare("UPDATE effects SET state='claimed',claimed_boot_id='dead-boot' WHERE command_id=?").run(ambiguous.commandId);
    reopened.prepare("UPDATE control_inputs SET delivery_state='dispatching' WHERE command_id=?").run(ambiguous.commandId);
    await core.close(); ({ core, adapter } = await makeCore(f, restarted, reopened)); await core.reconcileOnBoot(); await core.effectWorker.drain();
    expect(await core.controlService.getReceipt(principal, ambiguous.commandId)).toMatchObject({ state: "interrupted", delivery: "unknown" });
    expect(restarted.runtimeByAgentId.get(sessionId)?.sendCalls).toHaveLength(1);
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
    expect(f.manager.getAgent(worker.agentId)?.status).toBe("terminated");
    expect(f.database.prepare("SELECT desired_state FROM control_sessions WHERE session_id=?").get(f.sessionId)).toEqual({ desired_state: "running" });
    expect(f.manager.runtimeByAgentId.has(f.sessionId)).toBe(true);
  } finally { mirror.dispose(); await core.close(); }
});

it("real CLI socket resume/fork/clear/delete and cancellation replay one persisted result", async () => {
  const f = await fixture(); const mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady();
  const { core } = await makeCore(f); await core.reconcileOnBoot(); core.effectWorker.start();
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const handler = new CliWsHandler(f.manager);
  handler.setEnvironmentControl({ control: core.controlService, principalForSocket: () => ({ deviceSessionId: "cli", scopes: new Set(["session:operate", "session:read"]) }) });
  handler.attach(server); await once(server, "listening");
  const call = async (command: object) => {
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`);
    await once(socket, "open");
    const response = once(socket, "message"); socket.send(JSON.stringify(command));
    try { return JSON.parse((await response)[0].toString()); } finally { socket.terminate(); }
  };
  try {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const held = core.controlService.admitLifecycle({ deviceSessionId: "cli", scopes: new Set(["session:operate"]) }, {
      commandId: randomUUID(), command: "fork_session", sessionIds: [f.sessionId], intent: "inspect", request: {},
    }, async () => { await barrier; return {}; });
    const blocked = await call({ type: "resume_session", agentId: f.sessionId, requestId: "cli-blocked-resume" });
    release(); await held;
    expect(blocked).toMatchObject({ type: "cli_request_error", code: "CONFLICT", status: 409, retryable: true });
    await call({ type: "stop_session", agentId: f.sessionId, requestId: "cli-stop" });
    for (const type of ["resume_session", "fork_session", "clear_session", "delete_session"] as const) {
      const command = { type, ...(type === "fork_session" ? { sourceAgentId: f.sessionId, label: "CLI fork" } : { agentId: f.sessionId }), requestId: `cli-${type}` };
      if (type === "delete_session") {
        const choicePromise = f.manager.requestUserChoice(f.sessionId, [{ id: "q", question: "Pick", options: [{ id: "a", label: "A" }] }]); void choicePromise.catch(() => {});
        const choice = f.manager.getPendingChoiceRequestsForSession(f.sessionId)[0]!;
        const cancel = { type: "cli_choice_cancel", choiceId: choice.choiceId, requestId: "cli-cancel" };
        const cancelled = await call(cancel); expect(cancelled.type).toBe("cli_request_success"); expect(await call(cancel)).toEqual(cancelled);
      }
      const first = await call(command); expect(first, JSON.stringify(first)).toMatchObject({ type: "cli_request_success" });
      expect(await call(command)).toEqual(first);
    }
    expect(f.manager.listAgents().filter(agent => agent.sessionLabel === "CLI fork")).toHaveLength(1);
  } finally {
    handler.reset(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve())); mirror.dispose(); await core.close();
  }
}, 30_000);

it.each(["project.archive", "project.delete"] as const)("V2 %s fences the profile's accepted session input", async type => {
  const f = await fixture(); const mirror = makeMirror(f); mirror.attach(); await mirror.reconcileBeforeReady();
  const { core } = await makeCore(f);
  const principal = { deviceSessionId: "profile-device", scopes: new Set(["session:operate", "workspace:write"] as const) };
  f.database.prepare("INSERT INTO device_sessions (device_session_id,token_hash,proof_thumbprint,device_name,kind,scopes_json,created_at,last_seen_at,expires_at) VALUES ('profile-device','fixture-token','fixture-proof','Fixture','cli','[]',0,0,?)").run(Date.now() + 86_400_000);
  const handler = new WsHandler({ swarmManager: f.manager, mobilePushService: {} as never, allowNonManagerSubscriptions: true,
    perf: { recordDuration: () => {}, increment: () => {}, readSummary: () => ({ histograms: {}, counters: {} }), readRecentSlowEvents: () => [] } });
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
  const snapshot = vi.spyOn(f.manager, "getRestartRecoverySnapshot").mockReturnValue({ bootId: "boot", createdAt: new Date().toISOString(), interruptedManagers: [f.sessionId], interruptedWorkers: [], undeliveredReports: [] });
  const handler = new WsHandler({ swarmManager: f.manager, mobilePushService: {} as never, allowNonManagerSubscriptions: true,
    perf: { recordDuration: () => {}, increment: () => {}, readSummary: () => ({ histograms: {}, counters: {} }), readRecentSlowEvents: () => [] } });
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
  const handler = new WsHandler({ swarmManager: f.manager, mobilePushService: {} as never, allowNonManagerSubscriptions: true,
    listTerminalsForSession: () => [],
    perf: { recordDuration: () => {}, increment: () => {}, readSummary: () => ({ histograms: {}, counters: {} }), readRecentSlowEvents: () => [] } });
  handler.setEnvironmentControl({ access: { authorize: () => {} } as never, control: {} as never });
  const controllers = mounted.map(() => new AbortController());
  const streams = mounted.map((sessionId, i) => handler.detailFeatures(principal, { sessionId }, controllers[i]!.signal)[Symbol.asyncIterator]());
  try {
    for (const stream of streams) expect((await stream.next()).value).toMatchObject({ event: { type: "terminals.snapshot", scopeId: "manager" } });
    const terminal = { terminalId: "catalog-terminal", sessionAgentId: "manager", profileId: "manager", name: "Shell", shell: "/bin/sh", cwd: "/fixture", cols: 80, rows: 24,
      state: "running" as const, pid: null, exitCode: null, exitSignal: null, recoveredFromPersistence: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    handler.broadcastToSubscribed({ type: "terminal_created", sessionAgentId: "manager", terminal });
    for (const stream of streams) {
      let item;
      do { item = (await stream.next()).value; } while (item?.event.type !== "terminal.upsert");
      expect(item).toMatchObject({ event: { type: "terminal.upsert", scopeId: "manager", terminal } });
    }
    controllers[0]!.abort(); await streams[0]!.return?.();
    handler.broadcastToSubscribed({ type: "terminal_closed", sessionAgentId: "unmounted-profile", terminalId: terminal.terminalId, reason: "user_closed" });
    handler.broadcastToSubscribed({ type: "terminal_closed", sessionAgentId: "manager", terminalId: terminal.terminalId, reason: "user_closed" });
    expect((await streams[1]!.next()).value).toMatchObject({ event: { type: "terminal.closed", scopeId: "manager" } });
    expect(await streams[0]!.next()).toMatchObject({ done: true });
  } finally { for (const controller of controllers) controller.abort(); for (const stream of streams) await stream.return?.(); }
});

it("typed secure presentation sends worker metadata to its owning manager", async () => {
  const f = await fixture();
  const worker = await f.manager.spawnAgent("manager", { agentId: "secure-detail-worker" });
  const principal = { deviceSessionId: "secure-detail-device", scopes: new Set(["session:read"] as const) };
  const handler = new WsHandler({ swarmManager: f.manager, mobilePushService: {} as never, allowNonManagerSubscriptions: true,
    listTerminalsForSession: () => [],
    perf: { recordDuration: () => {}, increment: () => {}, readSummary: () => ({ histograms: {}, counters: {} }), readRecentSlowEvents: () => [] } });
  handler.setEnvironmentControl({ access: { authorize: () => {} } as never, control: {} as never });
  const controllers = [new AbortController()];
  const deadline = setTimeout(() => { for (const controller of controllers) controller.abort(); }, 1000);
  const streams = ["manager"].map((sessionId, i) => handler.detailFeatures(principal, { sessionId }, controllers[i]!.signal)[Symbol.asyncIterator]());
  try {
    for (const stream of streams) await stream.next();
    const snapshot = await f.manager.getSecureSessionSnapshot(worker.agentId);
    handler.broadcastSecureSessionSnapshot({ type: "secure_session_snapshot", ...snapshot, revision: 100, sessionAgentId: worker.agentId, principalKind: "worker", ownerManagerAgentId: "manager", workerAssignmentId: "assignment-test" });
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
