import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { makeTempConfig } from "../test-support/index.js";
import { loadConfiguredSqliteDatabaseConstructor } from "../sqlite-database-loader.js";
import { getEnvironmentDbPath, getProjectAgentConfigPath, getProjectAgentPromptPath, getSessionFilePath, getWorkerSessionFilePath } from "../swarm/storage/data-paths.js";
import { AgentDescriptorStore } from "../swarm/agents/agent-descriptor-store.js";
import { FORGE_V1_LEGACY_MARKER, importForgeV1 } from "./import-v1.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

const V1_ROOT = "/Users/someone/.forge";
const T0 = "2026-01-01T00:00:00.000Z";
const codex = { provider: "codex-native", modelId: "gpt-5.5", thinkingLevel: "high" };
function v1Session(profileId: string, agentId: string, extra: Record<string, unknown> = {}) {
  return { agentId, managerId: agentId, profileId, displayName: agentId, role: "manager", status: "idle", createdAt: T0, updatedAt: T0, cwd: `/work/${profileId}`, model: codex,
    sessionFile: `${V1_ROOT}/profiles/${profileId}/sessions/${agentId}/session.jsonl`, ...extra };
}
function v1Worker(profileId: string, managerId: string, agentId: string, extra: Record<string, unknown> = {}) {
  return { ...v1Session(profileId, agentId), managerId, role: "worker", status: "terminated", sessionFile: `${V1_ROOT}/profiles/${profileId}/sessions/${managerId}/workers/${agentId}.jsonl`, ...extra };
}
const legacyFields = { managerPosture: "delegation_first", managerPostureOrigin: "profile_default", delegationRosterId: "balanced", delegationRosterOrigin: "global_default" };

async function v1DataDir() {
  const config = await makeTempConfig({ omitSharedAuthFile: true, omitSharedSecretsFile: true });
  cleanup.push(() => rm(config.paths.dataDir, { recursive: true, force: true }));
  const store = {
    profiles: [
      { profileId: "alpha", displayName: "Alpha", defaultSessionAgentId: "alpha", defaultModel: codex, createdAt: T0, updatedAt: T0, sortOrder: 1, defaultDelegationRosterId: "balanced", defaultManagerPosture: "delegation_first", defaultContextMode: "fresh" },
      { profileId: "beta", displayName: "Beta", defaultSessionAgentId: "beta", defaultModel: codex, createdAt: T0, updatedAt: T0, sortOrder: 0, archivedAt: T0 },
      { profileId: "cortex", displayName: "Cortex", defaultSessionAgentId: "cortex", defaultModel: codex, createdAt: T0, updatedAt: T0, profileType: "system" },
    ],
    agents: [
      v1Session("alpha", "alpha", { ...legacyFields, sessionLabel: "Main work", projectAgent: { handle: "lead", whenToUse: "lead", systemPrompt: "stale inline copy" } }),
      v1Session("alpha", "alpha--old", { archivedAt: T0 }),
      v1Session("alpha", "alpha--sdk", { model: { provider: "claude-sdk", modelId: "claude-3-opus", thinkingLevel: "high" } }),
      v1Worker("alpha", "alpha", "alpha-builder", { specialistTier: "deep", specialistLens: "planner", delegationRouteId: "builder" }),
      v1Worker("alpha", "deleted-session", "orphan"),
      v1Session("beta", "beta", { projectAgent: { handle: "helper", whenToUse: "help", systemPrompt: "Inline prose only Forge 1 kept" } }),
      v1Session("cortex", "cortex", { cwd: V1_ROOT }),
      v1Session("cortex", "cortex--review", { sessionPurpose: "cortex_review" }),
      v1Worker("cortex", "cortex--review", "cortex-reviewer"),
    ],
  };
  const original = JSON.stringify(store);
  await mkdir(dirname(config.paths.agentsStoreFile), { recursive: true });
  await writeFile(config.paths.agentsStoreFile, original);
  const transcript = getSessionFilePath(config.paths.dataDir, "alpha", "alpha");
  await mkdir(dirname(transcript), { recursive: true });
  await writeFile(transcript, `${JSON.stringify({ type: "session", id: "alpha" })}\n`);
  const authored = getProjectAgentConfigPath(config.paths.dataDir, "alpha", "lead");
  await mkdir(dirname(authored), { recursive: true });
  await writeFile(authored, "authored config\n");
  return { config, original, transcript };
}

it("imports Forge 1 projects, sessions and workers once, archiving what V2 cannot continue, and leaves the source untouched", async () => {
  const { config, original, transcript } = await v1DataDir();
  const dataDir = config.paths.dataDir;
  const summary = await importForgeV1({ dataDir, storeFilePath: config.paths.agentsStoreFile, warn: () => {} });
  expect(summary).toEqual({ projects: 3, sessions: 6, workers: 2, legacySessions: 3, archivedSessions: 4, skippedRecords: 1 });

  // Restart: the ordinary V2 descriptor store reads the import from the control DB.
  const { agents, profiles = [] } = await new AgentDescriptorStore({ dataDir, storeFilePath: config.paths.agentsStoreFile }).load();
  const profile = (id: string) => profiles.find(p => p.profileId === id)!;
  const agent = (id: string) => agents.find(a => a.agentId === id)!;
  expect(profile("alpha")).toMatchObject({ displayName: "Alpha", sortOrder: 1, defaultModel: codex, defaultContextMode: "fresh" });
  expect(profile("beta").archivedAt).toBe(T0);
  expect(profile("cortex")).toMatchObject({ displayName: `Cortex${FORGE_V1_LEGACY_MARKER}`, archivedAt: T0 });
  for (const record of [...agents, ...profiles]) expect(Object.keys(record).filter(key => /Posture|elegation|specialistTier|specialistLens|profileType/.test(key))).toEqual([]);

  expect(agent("alpha")).toMatchObject({ sessionLabel: "Main work", sessionFile: transcript, cwd: "/work/alpha" });
  expect(agent("alpha").archivedAt).toBeUndefined();
  expect(agent("alpha-builder")).toMatchObject({ role: "worker", managerId: "alpha", sessionFile: getWorkerSessionFilePath(dataDir, "alpha", "alpha", "alpha-builder") });
  expect(agent("alpha--old")).toMatchObject({ archivedAt: T0, displayName: "alpha--old" });
  expect(agent("alpha--old").sessionLabel).toBeUndefined();
  for (const id of ["alpha--sdk", "cortex", "cortex--review"]) expect(agent(id)).toMatchObject({ sessionLabel: `${id}${FORGE_V1_LEGACY_MARKER}`, archivedAt: T0 });
  expect(agent("cortex").cwd).toBe(dataDir);
  expect(agent("cortex--review")).not.toHaveProperty("sessionPurpose");
  expect(agents.some(a => a.agentId === "orphan")).toBe(false);

  // What the sidebar reads: every project, including the former system profile, is an ordinary project row.
  const Database = await loadConfiguredSqliteDatabaseConstructor();
  const database = new Database(getEnvironmentDbPath(dataDir), { readonly: true });
  try {
    const projects = (database.prepare("SELECT summary_json FROM control_projects WHERE deleted=0 AND COALESCE(json_extract(profile_json,'$.profileType'),'user')!='system'").all() as { summary_json: string }[]).map(row => JSON.parse(row.summary_json));
    expect(projects.map(p => [p.projectId, p.title, p.sortKey, p.archived]).sort()).toEqual([
      ["alpha", "Alpha", "1", false], ["beta", "Beta", "0", true], ["cortex", `Cortex${FORGE_V1_LEGACY_MARKER}`, T0, true]]);
    const sessions = (database.prepare("SELECT summary_json FROM control_sessions WHERE deleted=0").all() as { summary_json: string }[]).map(row => JSON.parse(row.summary_json));
    expect(sessions).toHaveLength(6);
    expect(sessions.find(s => s.sessionId === "alpha--sdk")).toMatchObject({ archived: true, title: `alpha--sdk${FORGE_V1_LEGACY_MARKER}` });
  } finally { database.close(); }

  // Inline Project Agent prose moves to files only where no definition exists; V2 keeps prompts in files.
  expect(await readFile(getProjectAgentPromptPath(dataDir, "beta", "helper"), "utf8")).toBe("Inline prose only Forge 1 kept");
  expect(await readFile(getProjectAgentConfigPath(dataDir, "alpha", "lead"), "utf8")).toBe("authored config\n");
  await expect(readFile(getProjectAgentPromptPath(dataDir, "alpha", "lead"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(agent("beta").projectAgent).not.toHaveProperty("systemPrompt");

  expect(await readFile(config.paths.agentsStoreFile, "utf8")).toBe(original);
  expect(await readFile(transcript, "utf8")).toBe(`${JSON.stringify({ type: "session", id: "alpha" })}\n`);
  await expect(importForgeV1({ dataDir, storeFilePath: config.paths.agentsStoreFile })).rejects.toThrow(/only runs once/);
});

it("explains a data directory without Forge 1 data", async () => {
  const config = await makeTempConfig({ omitSharedAuthFile: true, omitSharedSecretsFile: true });
  cleanup.push(() => rm(config.paths.dataDir, { recursive: true, force: true }));
  await rm(config.paths.agentsStoreFile, { force: true });
  await expect(importForgeV1({ dataDir: config.paths.dataDir, storeFilePath: config.paths.agentsStoreFile })).rejects.toThrow(/No Forge 1 data/);
  await expect(readFile(join(config.paths.dataDir, "runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
});
