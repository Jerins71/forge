import { copyFile, readFile } from "node:fs/promises";
import type { Database } from "better-sqlite3";
import type { AgentDescriptorPersistence } from "../../swarm/agents/agent-descriptor-store.js";
import { decodeAgentsStoreFile } from "../../swarm/agents/descriptor-store/descriptor-codec.js";
import type { AgentsStoreFile, AgentDescriptor, ManagerProfile } from "../../swarm/types.js";
import type { ProjectSummary, SessionSummary } from "@forge/protocol/environment-v2";
import type { EventSink } from "./event-sink.js";

/** The existing descriptor port now stores backend metadata on control rows. JSONL/resources remain files. */
export function createControlDescriptorPersistence(options: { database: Database; eventSink: EventSink; dataDir: string; storeFilePath: string }): AgentDescriptorPersistence {
  const { database, eventSink } = options;
  const imported = () => (database.prepare("SELECT descriptors_imported FROM environment_meta WHERE singleton=1").get() as { descriptors_imported: number }).descriptors_imported !== 0;
  const persist = (store: AgentsStoreFile) => eventSink.transaction(tx => {
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
        database.prepare("INSERT INTO control_workers (session_id,agent_id,worker_json,updated_sequence,descriptor_json,deleted) VALUES (?,?,?,0,?,1) ON CONFLICT(session_id,agent_id) DO UPDATE SET descriptor_json=excluded.descriptor_json")
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
    }
    for (const row of database.prepare("SELECT session_id,agent_id FROM control_workers WHERE descriptor_json IS NOT NULL").all() as { session_id: string; agent_id: string }[]) if (!agents.has(row.agent_id)) database.prepare("UPDATE control_workers SET deleted=1,descriptor_json=NULL WHERE session_id=? AND agent_id=?").run(row.session_id, row.agent_id);
    database.prepare("UPDATE environment_meta SET descriptors_imported=1 WHERE singleton=1").run();
  });
  let adoption: Promise<void> | undefined;
  const adopt = () => adoption ??= (async () => {
    if (imported()) return;
    let store: AgentsStoreFile = { agents: [], profiles: [] };
    try {
      const raw = await readFile(options.storeFilePath, "utf8");
      await copyFile(options.storeFilePath, `${options.storeFilePath}.v2-before-policy-adoption`);
      store = decodeAgentsStoreFile(raw, options).store;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    persist(store);
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
