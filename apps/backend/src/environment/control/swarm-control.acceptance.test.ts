import { randomUUID } from "node:crypto";
import { getSessionDir } from "../../swarm/storage/data-paths.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempConfig, TestSwarmManager, bootWithDefaultManager } from "../../test-support/index.js";
import { loadConfiguredSqliteDatabaseConstructor } from "../../sqlite-database-loader.js";
import { migrateControlDatabase } from "./migrations.js";
import { createEventSink } from "./event-sink.js";
import { createSwarmEventMirror } from "./swarm-event-mirror.js";
import { createControlCore } from "./database.js";
import { createWorkspaceService } from "./workspace-service.js";
import { createArtifactService } from "./artifact-service.js";
import { createSwarmControlAdapter, createControlledInputRoutePreflight } from "./swarm-control-adapter.js";
import type { SwarmControlPort } from "./control-types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const config = await makeTempConfig({ prefix: "v2-swarm-", omitSharedAuthFile: true, omitSharedSecretsFile: true });
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
    swarm: { ensureSession: input => adapter.ensureSession(input), applyInput: input => adapter.applyInput(input), applyChoice: input => adapter.applyChoice(input), stopSession: input => adapter.stopSession(input) },
    workspace, artifacts, isDeviceRevoked: () => false, inputRoute: createControlledInputRoutePreflight({ swarmManager: manager }) });
  const adapter = createSwarmControlAdapter({ swarmManager: manager, database, eventSink: core.eventSink, workspaceService: workspace, artifactService: artifacts });
  return { core, adapter, artifacts };
}
async function countInputs(file: string, inputId: string) {
  return (await readFile(file, "utf8")).split("\n").filter(line => { try { return JSON.parse(line).data?.id === inputId; } catch { return false; } }).length;
}
describe("controlled swarm canonical/provider boundaries", () => {
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
    const f = await fixture(); const { core } = await makeCore(f);
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
