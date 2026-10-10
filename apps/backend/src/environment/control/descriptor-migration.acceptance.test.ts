import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempConfig } from "../../test-support/index.js";
import { loadConfiguredSqliteDatabaseConstructor } from "../../sqlite-database-loader.js";
import { getEnvironmentDbPath, getProjectAgentPromptPath } from "../../swarm/storage/data-paths.js";
import type { AgentDescriptor, AgentsStoreFile } from "../../swarm/types.js";
import { AgentDescriptorStore } from "../../swarm/agents/agent-descriptor-store.js";
import { createControlDescriptorPersistence } from "./descriptor-persistence.js";
import { createEventSink } from "./event-sink.js";
import { migrateControlDatabase } from "./migrations.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const config = await makeTempConfig({ omitSharedAuthFile: true, omitSharedSecretsFile: true });
  cleanup.push(() => rm(config.paths.dataDir, { recursive: true, force: true }));
  const descriptor: AgentDescriptor = { agentId: "manager", managerId: "manager", profileId: "project", displayName: "Manager", role: "manager", status: "stopped", createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z", cwd: config.defaultCwd, model: config.defaultModel, sessionFile: join(config.paths.dataDir, "canonical.jsonl"), projectAgent: { handle: "fixture", whenToUse: "fixture", systemPrompt: "deprecated inline content" } };
  const store: AgentsStoreFile = { agents: [descriptor, { ...descriptor, agentId: "worker", role: "worker", workerParentContext: { schemaVersion: 1, assignmentId: "assignment", managerId: "manager", assignedAt: descriptor.createdAt, outputTarget: { kind: "internal_only", reason: "fixture" } } }], profiles: [{ profileId: "project", displayName: "Project", defaultSessionAgentId: "manager", defaultModel: config.defaultModel, createdAt: descriptor.createdAt, updatedAt: descriptor.updatedAt, archivedAt: descriptor.createdAt }] };
  const original = JSON.stringify(store);
  await writeFile(config.paths.agentsStoreFile, original);
  const resource = join(config.paths.dataDir, "user-authored.md"); await writeFile(resource, "  user prose\n");
  const open = async () => {
    const Constructor = await loadConfiguredSqliteDatabaseConstructor();
    await mkdir(dirname(getEnvironmentDbPath(config.paths.dataDir)), { recursive: true });
    const database = new Constructor(getEnvironmentDbPath(config.paths.dataDir));
    migrateControlDatabase(database, { environmentId: randomUUID(), streamEpoch: randomUUID() });
    const eventSink = createEventSink(database, Date.now, randomUUID);
    const persistence = createControlDescriptorPersistence({ database, eventSink, dataDir: config.paths.dataDir, storeFilePath: config.paths.agentsStoreFile });
    return { database, persistence, close: () => { eventSink.close(); database.close(); } };
  };
  return { config, original, store, resource, open };
}
describe("descriptor authority migration", () => {
  it("backs up, imports once, writes/reads/restarts, and retains source/user files and tombstones", async () => {
    const f = await fixture(); let owner = await f.open();
    const imported = await owner.persistence.load();
    expect(imported.agents).toHaveLength(2); expect(imported.profiles?.[0]?.archivedAt).toBeDefined();
    expect(imported.agents[0]?.projectAgent).not.toHaveProperty("systemPrompt");
    expect(await readFile(getProjectAgentPromptPath(f.config.paths.dataDir, "project", "fixture"), "utf8")).toBe("deprecated inline content");
    expect(await readFile(`${f.config.paths.agentsStoreFile}.v2-before-policy-adoption`, "utf8")).toBe(f.original);
    imported.agents[0]!.displayName = "Changed"; await owner.persistence.save(imported);
    const counts = owner.database.prepare("SELECT (SELECT COUNT(*) FROM control_sessions) sessions,(SELECT COUNT(*) FROM control_workers WHERE descriptor_json IS NOT NULL) workers,(SELECT COUNT(*) FROM control_projects) projects").get();
    expect(counts).toEqual({ sessions: 1, workers: 1, projects: 1 }); owner.close();
    owner = await f.open(); expect((await owner.persistence.load()).agents.find(a => a.agentId === "manager")?.displayName).toBe("Changed");
    await owner.persistence.save({ agents: [], profiles: [] }); owner.close();
    owner = await f.open(); expect(await owner.persistence.load()).toEqual({ agents: [], profiles: [] }); owner.close();
    expect(await readFile(f.config.paths.agentsStoreFile, "utf8")).toBe(f.original);
    expect(await readFile(f.resource, "utf8")).toBe("  user prose\n");
  });
  it("gates invalid partial import before runtime can read and retains exact source backup", async () => {
    const f = await fixture(); const raw = JSON.stringify({ agents: [...f.store.agents, { agentId: "invalid" }], profiles: f.store.profiles });
    await writeFile(f.config.paths.agentsStoreFile, raw); const owner = await f.open();
    await expect(owner.persistence.load()).rejects.toThrow();
    expect(owner.database.prepare("SELECT descriptors_imported FROM environment_meta").get()).toEqual({ descriptors_imported: 0 });
    expect(owner.database.prepare("SELECT COUNT(*) count FROM control_sessions").get()).toEqual({ count: 0 });
    expect(await readFile(f.config.paths.agentsStoreFile, "utf8")).toBe(raw);
    expect(await readFile(`${f.config.paths.agentsStoreFile}.v2-before-policy-adoption`, "utf8")).toBe(raw); owner.close();
  });
  it("keeps already-V2 descriptors authoritative and strips deprecated inline content on adoption", async () => {
    const f = await fixture(); const owner = await f.open(); await owner.persistence.load();
    const descriptor = { ...f.store.agents[0]!, displayName: "V2", projectAgent: { handle: "fixture", whenToUse: "fixture", systemPrompt: "old V2 inline" } };
    owner.database.prepare("UPDATE control_sessions SET descriptor_json=? WHERE session_id='manager'").run(JSON.stringify(descriptor)); owner.database.prepare("UPDATE environment_meta SET descriptor_version=1").run(); owner.close();
    const restarted = await f.open(); const loaded = await restarted.persistence.load();
    expect(loaded.agents.find(a => a.agentId === "manager")?.displayName).toBe("V2");
    expect(loaded.agents.find(a => a.agentId === "manager")?.projectAgent).not.toHaveProperty("systemPrompt"); restarted.close();
  });
  it("the standalone store has no agents.json save fallback", async () => {
    const f = await fixture(); const owner = new AgentDescriptorStore({ dataDir: f.config.paths.dataDir, storeFilePath: f.config.paths.agentsStoreFile });
    await owner.load(); await owner.transaction(store => store.patchDescriptor("manager", { displayName: "Saved through DB" }));
    expect(await readFile(f.config.paths.agentsStoreFile, "utf8")).toBe(f.original);
    const restarted = new AgentDescriptorStore({ dataDir: f.config.paths.dataDir, storeFilePath: f.config.paths.agentsStoreFile });
    expect((await restarted.load()).agents.find(a => a.agentId === "manager")?.displayName).toBe("Saved through DB");
  });
});
