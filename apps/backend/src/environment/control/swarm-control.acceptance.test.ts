import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempConfig, TestSwarmManager, bootWithDefaultManager } from "../../test-support/index.js";
import { loadConfiguredSqliteDatabaseConstructor } from "../../sqlite-database-loader.js";
import { migrateControlDatabase } from "./migrations.js";
import { createEventSink } from "./event-sink.js";
import { createSwarmEventMirror } from "./swarm-event-mirror.js";
import { createSwarmControlAdapter } from "./swarm-control-adapter.js";
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
  cleanup.push(async () => { for (const agent of manager.listAgents().filter(agent => agent.role === "manager")) await manager.stopSession(agent.agentId); await manager.disposeHistoryRecall(); eventSink.close(); database.close(); await rm(config.paths.dataDir, { recursive: true, force: true }); });
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

});
