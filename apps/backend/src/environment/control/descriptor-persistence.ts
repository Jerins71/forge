import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Database } from "better-sqlite3";
import type { AgentDescriptorPersistence } from "../../swarm/agents/agent-descriptor-store.js";
import { decodeAgentsStoreFile } from "../../swarm/agents/descriptor-store/descriptor-codec.js";
import type { AgentsStoreFile, AgentDescriptor, ManagerProfile } from "../../swarm/types.js";
import type { ProjectSummary, SessionSummary } from "@forge/protocol/environment-v2";
import { createEventSink, type EventSink } from "./event-sink.js";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { getProjectAgentConfigPath, getProjectAgentPromptPath } from "../../swarm/storage/data-paths.js";
import { withEnvironmentDatabase } from "./database.js";
import { prepareRecoveryImport } from "../../swarm/recovery-state.js";
import { cloneDescriptorForPersistence } from "../../swarm/agents/descriptor-store/descriptor-clone.js";

/** The existing descriptor port now stores backend metadata on control rows. JSONL/resources remain files. */
export function createControlDescriptorPersistence(options: { database: Database; eventSink: EventSink; dataDir: string; storeFilePath: string }): AgentDescriptorPersistence {
  const { database, eventSink } = options;
  const imported = () => (database.prepare("SELECT descriptors_imported FROM environment_meta WHERE singleton=1").get() as { descriptors_imported: number }).descriptors_imported !== 0;
  const persist = (store: AgentsStoreFile, before?: () => void) => eventSink.transaction(tx => {
    before?.();
    store = { ...store, agents: store.agents.map(withoutInlinePrompt) };
    const profiles = new Set((store.profiles ?? []).map(p => p.profileId));
    const agents = new Set(store.agents.map(a => a.agentId));
    for (const row of database.prepare("SELECT project_id FROM control_projects WHERE profile_json IS NOT NULL AND deleted=0").all() as { project_id: string }[]) if (!profiles.has(row.project_id)) eventSink.append(tx, { topic: "shell", sessionId: null, event: { type: "project.remove", projectId: row.project_id } });
    for (const row of database.prepare("SELECT session_id FROM control_sessions WHERE descriptor_json IS NOT NULL AND deleted=0").all() as { session_id: string }[]) if (!agents.has(row.session_id)) {
      eventSink.append(tx, { topic: "shell", sessionId: row.session_id, event: { type: "session.remove", sessionId: row.session_id } });
      database.prepare("UPDATE control_sessions SET deleted=1 WHERE session_id=?").run(row.session_id);
    }
    for (const profile of store.profiles ?? []) {
      const descriptor = store.agents.find(a => a.agentId === profile.defaultSessionAgentId);
      const prior = database.prepare("SELECT summary_json FROM control_projects WHERE project_id=?").get(profile.profileId) as { summary_json: string } | undefined;
      const summary: ProjectSummary = { ...(prior ? JSON.parse(prior.summary_json) : { repository: null, isGit: false, defaultBranch: null }), projectId: profile.profileId, title: profile.displayName, cwd: descriptor?.cwd ?? options.dataDir, updatedAt: profile.updatedAt, sortKey: String(profile.sortOrder ?? profile.createdAt), archived: Boolean(profile.archivedAt), defaultModel: profile.defaultModel, defaultSessionId: profile.defaultSessionAgentId, delegationDefaults: { ...(profile.defaultManagerPosture ? { managerPosture: profile.defaultManagerPosture } : {}), ...(profile.defaultDelegationRosterId ? { rosterId: profile.defaultDelegationRosterId } : {}) }, contextMode: profile.defaultContextMode ?? "summary" };
      if (profile.profileType === "system") database.prepare("INSERT INTO control_projects (project_id,summary_json,updated_sequence) VALUES (?,?,0) ON CONFLICT(project_id) DO UPDATE SET summary_json=excluded.summary_json").run(profile.profileId, JSON.stringify(summary));
      else if (JSON.stringify(summary) !== prior?.summary_json) eventSink.append(tx, { topic: "shell", sessionId: null, event: { type: "project.upsert", project: summary } });
      database.prepare("UPDATE control_projects SET profile_json=?,deleted=0 WHERE project_id=?").run(JSON.stringify(profile), profile.profileId);
    }
    for (const descriptor of store.agents) {
      if (descriptor.role === "worker") {
        database.prepare("INSERT INTO control_workers (session_id,agent_id,worker_json,updated_sequence,descriptor_json,descriptor_version,deleted) VALUES (?,?,?,0,?,2,0) ON CONFLICT(session_id,agent_id) DO UPDATE SET descriptor_json=excluded.descriptor_json,descriptor_version=2,deleted=0")
          .run(descriptor.managerId, descriptor.agentId, JSON.stringify({ agentId: descriptor.agentId, title: descriptor.displayName, status: descriptor.status }), JSON.stringify(descriptor));
        continue;
      }
      const row = database.prepare("SELECT summary_json,desired_state FROM control_sessions WHERE session_id=?").get(descriptor.agentId) as { summary_json: string; desired_state: string } | undefined;
      const prior: SessionSummary | undefined = row && JSON.parse(row.summary_json);
      const profile = (store.profiles ?? []).find(p => p.profileId === descriptor.profileId);
      const summary: SessionSummary = { ...(prior ?? { attention: "none", unread: 0, workerCount: 0 }), sessionId: descriptor.agentId, projectId: descriptor.profileId ?? descriptor.agentId, title: descriptor.sessionLabel ?? descriptor.displayName, status: row?.desired_state === "stopped" ? prior!.status : descriptor.status === "streaming" ? "running" : descriptor.status === "terminated" ? "stopped" : descriptor.status, updatedAt: descriptor.updatedAt, sortKey: descriptor.updatedAt, archived: Boolean(descriptor.archivedAt), workspace: { ...(prior?.workspace ?? { kind: "current_checkout", branch: null }), cwd: descriptor.cwd }, model: { ...descriptor.model, origin: descriptor.modelOrigin === "session_override" ? "session_override" : "profile_default" }, ...(descriptor.managerPosture ? { delegation: { managerPosture: descriptor.managerPosture, managerPostureOrigin: descriptor.managerPostureOrigin ?? "product_default", rosterId: descriptor.delegationRosterId, rosterOrigin: descriptor.delegationRosterOrigin } } : {}), contextMode: { effective: descriptor.contextModeOverride ?? profile?.defaultContextMode ?? "summary", ...(descriptor.contextModeOverride ? { override: descriptor.contextModeOverride } : {}) } };
      if (profile?.profileType === "system") database.prepare("INSERT INTO control_sessions (session_id,project_id,desired_state,summary_json,updated_sequence) VALUES (?,?,'running',?,0) ON CONFLICT(session_id) DO UPDATE SET summary_json=excluded.summary_json").run(descriptor.agentId, descriptor.profileId, JSON.stringify(summary));
      else if (JSON.stringify(summary) !== row?.summary_json) eventSink.append(tx, { topic: "shell", sessionId: descriptor.agentId, event: { type: "session.upsert", session: summary } });
      database.prepare("UPDATE control_sessions SET descriptor_json=?,deleted=0 WHERE session_id=?").run(JSON.stringify(descriptor), descriptor.agentId);
      database.prepare("UPDATE control_sessions SET descriptor_version=2 WHERE session_id=?").run(descriptor.agentId);
    }
    for (const row of database.prepare("SELECT session_id,agent_id FROM control_workers WHERE descriptor_json IS NOT NULL").all() as { session_id: string; agent_id: string }[]) if (!agents.has(row.agent_id)) database.prepare("UPDATE control_workers SET deleted=1,descriptor_json=NULL WHERE session_id=? AND agent_id=?").run(row.session_id, row.agent_id);
    database.prepare("UPDATE environment_meta SET descriptors_imported=1 WHERE singleton=1").run();
  });
  let adoption: Promise<void> | undefined;
  const adopt = () => adoption ??= (async () => {
    if (!imported()) {
      let source: Buffer | undefined;
      try { source = await readFile(options.storeFilePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      let store: AgentsStoreFile = { agents: [], profiles: [] };
      const raw = source?.toString("utf8");
      if (source !== undefined) {
        const backup = `${options.storeFilePath}.v2-before-policy-adoption`;
        try { await writeFile(backup, source, { flag: "wx", mode: 0o600 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!(await readFile(backup)).equals(source)) throw new Error("Descriptor source differs from its preserved backup; import is gated");
        }
        const parsed: unknown = JSON.parse(raw!);
        if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as AgentsStoreFile).agents)) throw new Error("Invalid descriptor source; import is gated");
        const decoded = decodeAgentsStoreFile(raw!, { ...options, warn: () => {} });
        if (decoded.skippedDescriptorCount) throw new Error("Invalid descriptors; partial import is gated");
        store = decoded.store;
        const ids = store.agents.map(a => a.agentId);
        const profiles = (store.profiles ?? []).map(p => p.profileId);
        if (new Set(ids).size !== ids.length || new Set(profiles).size !== profiles.length || profiles.some(id => typeof id !== "string" || !id)) throw new Error("Invalid or duplicate descriptor identities; import is gated");
      }
      // The complete snapshot commits atomically with the import marker.
      await preserveInlinePrompts(options.dataDir, store.agents);
      const imports = await Promise.all(store.agents.filter(a => a.role === "manager").map(a => prepareRecoveryImport(database, { dataDir: options.dataDir, profileId: a.profileId ?? a.agentId, sessionAgentId: a.agentId })));
      if (source && !(await readFile(options.storeFilePath)).equals(source)) throw new Error("Descriptor source changed during import; runtime is gated");
      persist(store, () => { for (const applyImport of imports) applyImport(); });
    }
    if ((database.prepare("SELECT descriptor_version FROM environment_meta WHERE singleton=1").get() as { descriptor_version: number }).descriptor_version < 2) {
      const legacy = (database.prepare("SELECT descriptor_json FROM control_sessions WHERE descriptor_json IS NOT NULL UNION ALL SELECT descriptor_json FROM control_workers WHERE descriptor_json IS NOT NULL").all() as { descriptor_json: string }[]).map(row => JSON.parse(row.descriptor_json) as AgentDescriptor);
      await preserveInlinePrompts(options.dataDir, legacy);
      eventSink.transaction(() => {
        for (const table of ["control_sessions", "control_workers"]) {
          database.prepare(`UPDATE ${table} SET descriptor_json=json_remove(descriptor_json, '$.projectAgent.systemPrompt'),descriptor_version=2 WHERE descriptor_json IS NOT NULL`).run();
        }
        database.prepare("UPDATE environment_meta SET descriptor_version=2 WHERE singleton=1").run();
      });
    }
  })();
  return {
    async load() {
      await adopt();
      const profiles = (database.prepare("SELECT profile_json FROM control_projects WHERE deleted=0 AND profile_json IS NOT NULL").all() as { profile_json: string }[]).map(row => JSON.parse(row.profile_json) as ManagerProfile);
      const agents = [...(database.prepare("SELECT descriptor_json FROM control_sessions WHERE deleted=0 AND descriptor_json IS NOT NULL").all() as { descriptor_json: string }[]), ...(database.prepare("SELECT descriptor_json FROM control_workers WHERE descriptor_json IS NOT NULL").all() as { descriptor_json: string }[])].map(row => JSON.parse(row.descriptor_json) as AgentDescriptor);
      return { agents, profiles };
    },
    async save(store) { await adopt(); persist(store); },
  };
}

function withoutInlinePrompt(descriptor: AgentDescriptor): AgentDescriptor {
  const copy = cloneDescriptorForPersistence(descriptor);
  if (copy.projectAgent) delete copy.projectAgent.systemPrompt;
  return copy;
}

export function createStandaloneDescriptorPersistence(options: { dataDir: string; storeFilePath: string }): AgentDescriptorPersistence {
  const run = <T>(operation: (persistence: AgentDescriptorPersistence) => Promise<T>) => withEnvironmentDatabase(options.dataDir, async database => {
    const sink = createEventSink(database, Date.now, randomUUID);
    try { return await operation(createControlDescriptorPersistence({ ...options, database, eventSink: sink })); }
    finally { sink.close(); }
  });
  return { load: () => run(owner => owner.load()), save: store => run(owner => owner.save(store)) };
}

/** Legacy inline prose is carried to files using exclusive creation. Existing authored bytes always win. */
async function preserveInlinePrompts(dataDir: string, descriptors: AgentDescriptor[]): Promise<void> {
  for (const descriptor of descriptors) {
    const agent = descriptor.projectAgent;
    if (descriptor.role !== "manager" || !agent || agent.systemPrompt === undefined || agent.source?.type === "repo") continue;
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const prompt = getProjectAgentPromptPath(dataDir, profileId, agent.handle);
    const config = getProjectAgentConfigPath(dataDir, profileId, agent.handle);
    await mkdir(dirname(prompt), { recursive: true });
    // If a definition already exists, its prompt (including intentional absence) is authoritative.
    try { await readFile(config); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await writeFile(prompt, agent.systemPrompt, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    try { await writeFile(config, JSON.stringify({ version: 1, agentId: descriptor.agentId, handle: agent.handle, whenToUse: agent.whenToUse, capabilities: agent.capabilities, creatorSessionId: agent.creatorSessionId, promotedAt: descriptor.createdAt, updatedAt: descriptor.updatedAt }) + "\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}
