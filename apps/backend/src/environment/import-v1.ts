import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { acquireRuntimeLock } from "../runtime-lock.js";
import { decodeAgentsStoreFile, type DecodeStoreResult } from "../swarm/agents/descriptor-store/descriptor-codec.js";
import { assertSwarmModelIdNotRetired, normalizePersistedSwarmModelDescriptor } from "../swarm/catalog/model-presets.js";
import { modelCatalogService } from "../swarm/catalog/model-catalog-service.js";
import { getProjectAgentConfigPath, getProjectAgentPromptPath } from "../swarm/storage/data-paths.js";
import type { AgentDescriptor, AgentsStoreFile } from "../swarm/types.js";
import { createStandaloneDescriptorPersistence } from "./control/descriptor-persistence.js";

/** Marks sessions and projects that came over from Forge 1 but cannot be continued here. */
export const FORGE_V1_LEGACY_MARKER = " · Forge 1 (read-only)";

export interface ForgeV1ImportSummary {
  projects: number;
  sessions: number;
  workers: number;
  /** Archived because they cannot be continued: a removed feature or an unavailable model. */
  legacySessions: number;
  archivedSessions: number;
  skippedRecords: number;
}

/**
 * One-time import of a Forge 1 `swarm/agents.json` from the same (stopped) data directory into
 * the V2 descriptor tables. Runs under the runtime lock and refuses a directory that already has
 * V2 projects or sessions. The source file and transcripts are only read.
 */
export async function importForgeV1(options: { dataDir: string; storeFilePath: string; warn?: (message: string) => void }): Promise<ForgeV1ImportSummary> {
  const lock = acquireRuntimeLock(options.dataDir);
  try {
    let raw: string;
    try { raw = await readFile(options.storeFilePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`No Forge 1 data to import: ${options.storeFilePath} does not exist`);
      throw error;
    }
    const persistence = createStandaloneDescriptorPersistence(options);
    const existing = await persistence.load();
    if (existing.agents.length > 0 || (existing.profiles ?? []).length > 0)
      throw new Error("This data directory already has Forge 2 projects; the Forge 1 import only runs once, into a directory with none.");
    const decoded = decodeAgentsStoreFile(raw, { dataDir: options.dataDir, storeFilePath: options.storeFilePath, warn: options.warn });
    const { store, summary } = prepareForgeV1Import(decoded, options.dataDir);
    // V2 stores a Project Agent's prompt only in its files; very old Forge 1 data kept it inline.
    await preserveInlinePrompts(options.dataDir, store.agents);
    await persistence.save(store);
    return summary;
  } finally {
    lock.release();
  }
}

/** Pure: rebases paths onto the new data directory and archives what V2 cannot continue. */
export function prepareForgeV1Import(decoded: DecodeStoreResult, dataDir: string): { store: AgentsStoreFile; summary: ForgeV1ImportSummary } {
  const profiles = (decoded.store.profiles ?? []).map(profile => decoded.retired.profileIds.has(profile.profileId)
    ? { ...profile, displayName: withLegacyMarker(profile.displayName || profile.profileId), archivedAt: profile.archivedAt ?? profile.updatedAt }
    : profile);
  const managers = new Set<string>();
  let legacySessions = 0;
  const agents: AgentDescriptor[] = [];
  for (const descriptor of decoded.store.agents) {
    let next = rebasePaths(descriptor, dataDir);
    if (next.role === "manager") {
      managers.add(next.agentId);
      if (decoded.retired.agentIds.has(next.agentId) || !isContinuableModel(next)) {
        legacySessions += 1;
        next = { ...next, sessionLabel: withLegacyMarker(next.sessionLabel ?? next.displayName), archivedAt: next.archivedAt ?? next.updatedAt };
      }
    }
    agents.push(next);
  }
  // A worker without its manager has no session to be listed under.
  const imported = agents.filter(agent => agent.role === "manager" || managers.has(agent.managerId));
  const sessions = imported.filter(agent => agent.role === "manager");
  return {
    store: { agents: imported, profiles },
    summary: {
      projects: profiles.length,
      sessions: sessions.length,
      workers: imported.length - sessions.length,
      legacySessions,
      archivedSessions: sessions.filter(session => session.archivedAt).length,
      skippedRecords: decoded.skippedDescriptorCount + agents.length - imported.length,
    },
  };
}

/** Forge 1 wrote absolute paths under its own data directory, `<root>/profiles/<profileId>/…`. */
function rebasePaths(descriptor: AgentDescriptor, dataDir: string): AgentDescriptor {
  const marker = `${sep}profiles${sep}${descriptor.profileId ?? descriptor.managerId}${sep}`;
  const index = descriptor.sessionFile.indexOf(marker);
  if (index < 0) return descriptor;
  const sourceRoot = descriptor.sessionFile.slice(0, index);
  const rebase = (path: string) => path === sourceRoot || path.startsWith(sourceRoot + sep) ? join(dataDir, path.slice(sourceRoot.length)) : path;
  return { ...descriptor, sessionFile: rebase(descriptor.sessionFile), cwd: rebase(descriptor.cwd) };
}

/** Carries inline prose to files with exclusive creation. An existing definition always wins. */
async function preserveInlinePrompts(dataDir: string, descriptors: AgentDescriptor[]): Promise<void> {
  for (const descriptor of descriptors) {
    const agent = descriptor.projectAgent;
    if (descriptor.role !== "manager" || !agent || agent.systemPrompt === undefined || agent.source?.type === "repo") continue;
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const prompt = getProjectAgentPromptPath(dataDir, profileId, agent.handle);
    const config = getProjectAgentConfigPath(dataDir, profileId, agent.handle);
    try { await readFile(config); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(dirname(prompt), { recursive: true });
    await writeExclusive(prompt, agent.systemPrompt);
    await writeExclusive(config, JSON.stringify({ version: 1, agentId: descriptor.agentId, handle: agent.handle, whenToUse: agent.whenToUse, capabilities: agent.capabilities, creatorSessionId: agent.creatorSessionId, promotedAt: descriptor.createdAt, updatedAt: descriptor.updatedAt }) + "\n");
  }
}

async function writeExclusive(path: string, content: string): Promise<void> {
  try { await writeFile(path, content, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

function isContinuableModel(descriptor: AgentDescriptor): boolean {
  const model = normalizePersistedSwarmModelDescriptor(descriptor.model) ?? descriptor.model;
  if (!modelCatalogService.getProvider(model.provider.trim().toLowerCase())) return false;
  try { assertSwarmModelIdNotRetired(model.provider, model.modelId, "model"); return true; }
  catch { return false; }
}

function withLegacyMarker(title: string): string {
  return title.endsWith(FORGE_V1_LEGACY_MARKER) ? title : `${title.slice(0, 256 - FORGE_V1_LEGACY_MARKER.length)}${FORGE_V1_LEGACY_MARKER}`;
}
