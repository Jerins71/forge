import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempConfig } from "../../test-support/index.js";
import { loadConfiguredSqliteDatabaseConstructor } from "../../sqlite-database-loader.js";
import { getEnvironmentDbPath } from "../../swarm/storage/data-paths.js";
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
describe("fresh descriptor authority", () => {
  it("starts empty, writes/reads/restarts and preserves source and user files", async () => {
    const f=await fixture(); let owner=await f.open();
    expect(await owner.persistence.load()).toEqual({agents:[],profiles:[]});
    await owner.persistence.save(f.store);
    const saved=await owner.persistence.load();
    expect(saved.agents).toHaveLength(2);
    expect(saved.agents[0]?.projectAgent).not.toHaveProperty("systemPrompt");
    saved.agents[0]!.displayName="Changed";
    await owner.persistence.save(saved); owner.close();
    owner=await f.open(); expect((await owner.persistence.load()).agents.find(a=>a.agentId === "manager")?.displayName).toBe("Changed");
    await owner.persistence.save({agents:[],profiles:[]}); owner.close();
    owner=await f.open(); expect(await owner.persistence.load()).toEqual({agents:[],profiles:[]}); owner.close();
    expect(await readFile(f.config.paths.agentsStoreFile,"utf8")).toBe(f.original);
    expect(await readFile(f.resource,"utf8")).toBe("  user prose\n");
  });
  it("ignores even invalid legacy input and never changes or backs it up", async () => {
    const f=await fixture(); const raw="invalid legacy JSON preserved verbatim";
    await writeFile(f.config.paths.agentsStoreFile,raw);
    const owner=await f.open(); expect(await owner.persistence.load()).toEqual({agents:[],profiles:[]}); owner.close();
    expect(await readFile(f.config.paths.agentsStoreFile,"utf8")).toBe(raw);
    await expect(readFile(`${f.config.paths.agentsStoreFile}.v2-before-policy-adoption`)).rejects.toMatchObject({code:"ENOENT"});
  });
  it("the standalone store persists through DB without an agents.json fallback", async () => {
    const f=await fixture(); const seed=await f.open(); await seed.persistence.save(f.store); seed.close();
    const owner=new AgentDescriptorStore({dataDir:f.config.paths.dataDir,storeFilePath:f.config.paths.agentsStoreFile});
    await owner.load(); await owner.transaction(store=>store.patchDescriptor("manager",{displayName:"Saved through DB"}));
    const restarted=new AgentDescriptorStore({dataDir:f.config.paths.dataDir,storeFilePath:f.config.paths.agentsStoreFile});
    expect((await restarted.load()).agents.find(a=>a.agentId === "manager")?.displayName).toBe("Saved through DB");
    expect(await readFile(f.config.paths.agentsStoreFile,"utf8")).toBe(f.original);
  });
});
