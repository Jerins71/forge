import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import type { Database } from "better-sqlite3";
import type { ArtifactRef, ProjectSummary, SessionSummary, DetailStreamItem } from "@forge/protocol/environment-v2";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import type { AgentDescriptor, ConversationEntryEvent, ManagerProfile, ChoiceRequestEvent } from "../../swarm/types.js";
import { isConversationEntryEvent } from "../../swarm/session/conversation-validators.js";
import { CONVERSATION_ENTRY_TYPE } from "../../swarm/session/conversation-timeline.js";
import type { ControlTransaction, EventSink } from "./event-sink.js";

type DetailItem = Extract<Extract<DetailStreamItem, { kind: "event" }>["event"], { type: "item.upsert" }>["item"];
type ChoiceSummary = Extract<Extract<DetailStreamItem, { kind: "event" }>["event"], { type: "choice.upsert" }>["choice"];
export interface MirrorWireProjection {
  project(profile: ManagerProfile): Promise<ProjectSummary>;
  /** Read the existing policy owner's result; subscribing to shell never changes it. */
  unread(sessionId: string, projectId: string): number;
  artifacts?(entry: ConversationEntryEvent): ArtifactRef[];
  /** Notify after the existing owner updates its count, including explicit foreground mark-read. */
  observeUnread?(listener: (sessionId: string) => void): () => void;
}
export interface SwarmEventMirror {
  attach(): void;
  reconcileBeforeReady(): Promise<void>;
  ensureDetailInitialized(sessionId: string): Promise<void>;
  dispose(): void;
  notifyUnreadChanged(sessionId: string): void;
}
interface Source { generation: string; size: number }
interface Checkpoint { file_generation: string; byte_offset: number; last_entry_id: string | null }
function source(file: string): Source {
  try {
    const info = statSync(file); const fd = openSync(file, "r"); const buffer = Buffer.alloc(Math.min(info.size, 4096));
    try { readSync(fd, buffer, 0, buffer.length, 0); } finally { closeSync(fd); }
    const header = buffer.toString("utf8").split("\n")[0] ?? "";
    return { generation: `${info.dev}:${info.ino}:${createHash("sha256").update(header).digest("hex").slice(0, 16)}`, size: info.size };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { generation: "missing", size: 0 }; throw error; }
}
export function createSwarmEventMirror({ swarmManager, database, eventSink, wireProjection }: {
  swarmManager: Pick<SwarmManager, "on" | "off" | "listAgentsForInternalUse" | "getAgentForInternalUse" | "listProfiles" | "listWorkersForSession" | "getConversationHistoryPage" | "getPendingChoiceRequestsForSession" | "getSessionAttentionSnapshot" | "observeCatalogDirty" | "isSessionShutdownSafe">;
  database: Database; eventSink: EventSink; wireProjection: MirrorWireProjection;
}): SwarmEventMirror {
  if (eventSink.database !== database) throw new Error("Mirror requires the shared environment database.");
  const sessions = new Map<string, AgentDescriptor>();
  const actors = new Map<string, string>();
  const userTurns = new Map<string, string>();
  const initialized = new Set<string>();
  const initializing = new Map<string, Promise<void>>();
  const dirty = new Set<string>();
  const errors = new Map<string, unknown>();
  const removers: (() => void)[] = [];
  let attached = false; let disposed = false; let catalogQueued = false; let fullCatalogDirty = false; let profilesDirty = false;
  let catalogWork = Promise.resolve();
  function checkpoint(key: string): Checkpoint | undefined { return database.prepare("SELECT file_generation,byte_offset,last_entry_id FROM mirror_sources WHERE source_key=?").get(key) as Checkpoint | undefined; }
  function recordSource(key: string, evidence: Source, lastId: string | null = null) {
    database.prepare(`INSERT INTO mirror_sources (source_key,file_generation,byte_offset,last_entry_id,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(source_key) DO UPDATE SET file_generation=excluded.file_generation,byte_offset=excluded.byte_offset,last_entry_id=excluded.last_entry_id,updated_at=excluded.updated_at`)
      .run(key, evidence.generation, evidence.size, lastId, Date.now());
  }
  function indexDescriptor(descriptor: AgentDescriptor) {
    const sessionId = descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
    actors.set(descriptor.agentId, sessionId); if (descriptor.role === "manager") sessions.set(sessionId, descriptor);
  }
  function storedSummary(sessionId: string): SessionSummary | undefined {
    const row = database.prepare("SELECT summary_json FROM control_sessions WHERE session_id=?").get(sessionId) as { summary_json: string } | undefined;
    return row && JSON.parse(row.summary_json) as SessionSummary;
  }
  function summary(descriptor: AgentDescriptor): SessionSummary {
    const prior = storedSummary(descriptor.agentId);
    const pending = swarmManager.getPendingChoiceRequestsForSession(descriptor.agentId).length > 0 || Boolean(database.prepare("SELECT 1 FROM control_choices WHERE session_id=? AND state='pending' LIMIT 1").get(descriptor.agentId));
    const attention = swarmManager.getSessionAttentionSnapshot().attentions.find(attention => attention.sessionAgentId === descriptor.agentId);
    const row = database.prepare("SELECT desired_state FROM control_sessions WHERE session_id=?").get(descriptor.agentId) as { desired_state: string } | undefined;
    const status = row?.desired_state === "stopped" ? swarmManager.isSessionShutdownSafe(descriptor.agentId) ? "stopped" : "stopping"
      : descriptor.status === "streaming" ? "running" : descriptor.status === "terminated" ? "stopped"
        : descriptor.status === "idle" && pending ? "waiting" : descriptor.status;
    return { sessionId: descriptor.agentId, projectId: descriptor.profileId ?? descriptor.agentId,
      title: (descriptor.sessionLabel ?? descriptor.displayName).slice(0, 256), status,
      attention: pending ? "choice" : descriptor.status === "error" ? "error" : attention ? "result" : "none",
      unread: wireProjection.unread(descriptor.agentId, descriptor.profileId ?? descriptor.agentId),
      workerCount: descriptor.workerCount ?? swarmManager.listWorkersForSession(descriptor.agentId).length,
      updatedAt: descriptor.updatedAt, sortKey: descriptor.updatedAt, archived: Boolean(descriptor.archivedAt),
      workspace: prior?.workspace ?? { kind: "current_checkout", cwd: descriptor.cwd, branch: null } };
  }
  function upsertSession(tx: ControlTransaction, sessionId: string) {
    const descriptor = swarmManager.getAgentForInternalUse(sessionId);
    if (!descriptor || descriptor.role !== "manager") return;
    indexDescriptor(descriptor); const next = summary(descriptor);
    if (JSON.stringify(next) !== JSON.stringify(storedSummary(sessionId))) eventSink.append(tx, { topic: "shell", sessionId, event: { type: "session.upsert", session: next } });
  }
  function upsertWorker(tx: ControlTransaction, descriptor: AgentDescriptor) {
    indexDescriptor(descriptor);
    const worker = { agentId: descriptor.agentId, title: descriptor.displayName.slice(0, 256), status: descriptor.status };
    const prior = database.prepare("SELECT worker_json FROM control_workers WHERE session_id=? AND agent_id=?").get(descriptor.managerId, descriptor.agentId) as { worker_json: string } | undefined;
    if (JSON.stringify(worker) !== prior?.worker_json) eventSink.append(tx, { topic: "detail", sessionId: descriptor.managerId, event: { type: "worker.upsert", worker } });
  }
  function item(entry: ConversationEntryEvent, sessionId: string): DetailItem | null {
    if (!["conversation_message", "activity_summary", "agent_message"].includes(entry.type)) return null;
    if (entry.type === "conversation_message" && entry.terminal === false) return null;
    const id = entry.timelineEntryId ?? ("id" in entry && typeof entry.id === "string" ? entry.id : undefined);
    if (!id) return null;
    const text = "text" in entry && typeof entry.text === "string" ? entry.text : "displaySummary" in entry && typeof entry.displaySummary === "string" ? entry.displaySummary : "";
    const user = entry.type === "conversation_message" && entry.role === "user";
    if (user) userTurns.set(sessionId, entry.id ?? id);
    return { itemId: id, userTurnId: userTurns.get(sessionId) ?? ("turnId" in entry ? entry.turnId : undefined) ?? id,
      actorId: "actorAgentId" in entry ? entry.actorAgentId : entry.agentId,
      kind: entry.type === "conversation_message" ? user ? "user" : "assistant" : entry.type === "agent_message" ? "worker_result" : "activity",
      timestamp: entry.timestamp, text: text.slice(0, 8192), contentRef: text.length > 8192 ? id : null,
      artifacts: (wireProjection.artifacts?.(entry) ?? []).slice(0, 20),
      commandId: entry.type === "conversation_message" ? entry.controlCommandId ?? null : null };
  }
  function canonical(tx: ControlTransaction, entry: ConversationEntryEvent, descriptor: AgentDescriptor, evidence: Source) {
    const sessionId = actors.get(descriptor.agentId) ?? (descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId);
    const projected = item(entry, sessionId);
    if (projected) eventSink.append(tx, { topic: "detail", sessionId,
      sourceKey: `canonical:${descriptor.agentId}:${evidence.generation}:${projected.itemId}`,
      event: { type: "item.upsert", item: projected } });
  }
  function choice(tx: ControlTransaction, entry: ChoiceRequestEvent, generation?: string) {
    const sessionId = entry.sessionAgentId ?? actors.get(entry.agentId) ?? entry.agentId;
    const status = entry.status;
    const value: ChoiceSummary = { choiceId: entry.choiceId, agentId: entry.agentId, status, questions: entry.questions };
    const runtimeGeneration = generation ?? (entry as typeof entry & { runtimeGeneration?: string }).runtimeGeneration;
    if (!runtimeGeneration) return; // Historical Promise continuations cannot be reconstructed.
    const prior = database.prepare("SELECT choice_json FROM control_choices WHERE choice_id=?").get(entry.choiceId) as { choice_json: string } | undefined;
    if (prior?.choice_json === JSON.stringify(value)) return;
    database.prepare(`INSERT INTO control_choices (choice_id,session_id,runtime_generation,state,choice_json,updated_sequence) VALUES (?,?,?,?,?,0)
      ON CONFLICT(choice_id) DO UPDATE SET runtime_generation=excluded.runtime_generation`)
      .run(entry.choiceId, sessionId, runtimeGeneration, status, JSON.stringify(value));
    eventSink.append(tx, { topic: "detail", sessionId, event: { type: "choice.upsert", choice: value } });
    upsertSession(tx, sessionId);
  }
  function observeCanonical(entry: ConversationEntryEvent) {
    const descriptor = swarmManager.getAgentForInternalUse(entry.agentId); if (!descriptor) return;
    indexDescriptor(descriptor); const evidence = source(descriptor.sessionFile);
    // Runtime/custom entries are authoritative only when the owning writer has persisted a file.
    if (!evidence.size) return;
    eventSink.transaction(tx => {
      canonical(tx, entry, descriptor, evidence);
      if (entry.type === "choice_request") choice(tx, entry);
      upsertSession(tx, actors.get(descriptor.agentId)!);
      recordSource(`source:${descriptor.agentId}`, evidence, entry.timelineEntryId ?? null);
    });
  }
  function queueCatalog(ids?: readonly string[], profiles = false) {
    if (ids) for (const id of ids) dirty.add(actors.get(id) ?? id); else if (!profiles) fullCatalogDirty = true;
    profilesDirty ||= profiles;
    if (catalogQueued || disposed) return; catalogQueued = true;
    queueMicrotask(() => {
      catalogQueued = false;
      catalogWork = catalogWork.then(async () => {
        if (disposed) return;
        const full = fullCatalogDirty; fullCatalogDirty = false; const projectChanges = profilesDirty; profilesDirty = false;
        const ids = full ? swarmManager.listAgentsForInternalUse().filter(agent => agent.role === "manager").map(agent => agent.agentId) : [...dirty]; dirty.clear();
        if (full) for (const descriptor of swarmManager.listAgentsForInternalUse()) indexDescriptor(descriptor);
        const projects = projectChanges ? await Promise.all(swarmManager.listProfiles().filter(profile => profile.profileType !== "system").map(profile => wireProjection.project(profile))) : [];
        eventSink.transaction(tx => {
          for (const project of projects) {
            const prior = database.prepare("SELECT summary_json FROM control_projects WHERE project_id=?").get(project.projectId) as { summary_json: string } | undefined;
            if (JSON.stringify(project) !== prior?.summary_json) eventSink.append(tx, { topic: "shell", sessionId: null, event: { type: "project.upsert", project } });
          }
          for (const id of ids) upsertSession(tx, id);
          if (full) {
            const active = new Set(ids);
            for (const id of sessions.keys()) if (!active.has(id)) {
              eventSink.append(tx, { topic: "shell", sessionId: id, event: { type: "session.remove", sessionId: id } }); sessions.delete(id);
            }
          }
        });
      }).catch(error => { errors.set("catalog", error); });
    });
  }
  function listen<T>(name: string, handler: (event: T) => void) {
    const wrapped = (event: T) => { try { handler(event); } catch (error) { errors.set(name, error); } };
    swarmManager.on(name, wrapped); removers.push(() => swarmManager.off(name, wrapped));
  }
  async function tail(descriptor: AgentDescriptor) {
    const key = `source:${descriptor.agentId}`; const prior = checkpoint(key); const evidence = source(descriptor.sessionFile);
    const sessionId = descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
    if (!evidence.size) return;
    const reset = prior && (prior.file_generation !== evidence.generation || prior.byte_offset > evidence.size);
    let offset = reset ? 0 : prior?.byte_offset ?? 0;
    if (reset) eventSink.transaction(tx => { eventSink.append(tx, { topic: "detail", sessionId, event: { type: "detail.reset" } }); recordSource(key, { ...evidence, size: 0 }); });
    if (offset >= evidence.size) return;
    const file = await open(descriptor.sessionFile, "r"); let remainder = Buffer.alloc(0); let remainderStart = offset;
    try {
      while (offset < evidence.size) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, evidence.size - offset)); const read = await file.read(buffer, 0, buffer.length, offset); if (!read.bytesRead) break;
        offset += read.bytesRead; const combined = Buffer.concat([remainder, buffer.subarray(0, read.bytesRead)]); const lastNewline = combined.lastIndexOf(10);
        if (lastNewline < 0) { remainder = combined; if (remainder.length > 4 * 1024 * 1024) throw new Error("Canonical entry exceeds mirror scan budget."); continue; }
        const lines = combined.subarray(0, lastNewline + 1).toString("utf8").split("\n"); const entries: ConversationEntryEvent[] = [];
        for (const line of lines) { if (!line) continue; let raw: { customType?: string; data?: unknown }; try { raw = JSON.parse(line) as typeof raw; } catch { throw new Error("Canonical source contains a malformed completed entry."); } if (raw.customType === CONVERSATION_ENTRY_TYPE && isConversationEntryEvent(raw.data)) entries.push(raw.data); }
        const completeOffset = remainderStart + lastNewline + 1;
        eventSink.transaction(tx => { for (const entry of entries) canonical(tx, entry, descriptor, evidence); upsertSession(tx, sessionId); recordSource(key, { ...evidence, size: completeOffset }, entries.at(-1)?.timelineEntryId ?? null); });
        remainder = combined.subarray(lastNewline + 1); remainderStart = completeOffset;
      }
    } finally { await file.close(); }
  }
  const mirror: SwarmEventMirror = {
    attach() {
      if (attached || disposed) return; attached = true;
      for (const name of ["conversation_message", "activity_summary", "agent_message"]) listen(name, observeCanonical);
      listen("choice_request", (event: ChoiceRequestEvent) => { eventSink.transaction(tx => choice(tx, event)); });
      listen("agent_status", (event: { agentId: string }) => { const descriptor = swarmManager.getAgentForInternalUse(event.agentId); if (!descriptor) return; eventSink.transaction(tx => { if (descriptor.role === "worker") upsertWorker(tx, descriptor); upsertSession(tx, descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId); }); });
      listen("session_workers_snapshot", (event: { sessionAgentId: string; workers: AgentDescriptor[] }) => {
        eventSink.transaction(tx => { const ids = new Set(event.workers.map(worker => worker.agentId)); for (const worker of event.workers) upsertWorker(tx, worker);
          const prior = database.prepare("SELECT agent_id FROM control_workers WHERE session_id=?").all(event.sessionAgentId) as { agent_id: string }[];
          for (const row of prior) if (!ids.has(row.agent_id)) eventSink.append(tx, { topic: "detail", sessionId: event.sessionAgentId, event: { type: "worker.remove", agentId: row.agent_id } }); upsertSession(tx, event.sessionAgentId); });
      });
      listen("session_lifecycle", (event: { action: string; sessionAgentId?: string }) => { if (event.action === "deleted" && event.sessionAgentId) { eventSink.transaction(tx => eventSink.append(tx, { topic: "shell", sessionId: event.sessionAgentId!, event: { type: "session.remove", sessionId: event.sessionAgentId! } })); sessions.delete(event.sessionAgentId); } else queueCatalog(event.sessionAgentId ? [event.sessionAgentId] : undefined); });
      listen("conversation_reset", (event: { agentId: string }) => { const descriptor = swarmManager.getAgentForInternalUse(event.agentId); if (!descriptor) return; eventSink.transaction(tx => { eventSink.append(tx, { topic: "detail", sessionId: descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId, event: { type: "detail.reset" } }); recordSource(`source:${descriptor.agentId}`, source(descriptor.sessionFile)); }); });
      listen("session_attention_snapshot", () => { queueCatalog([...sessions.keys()]); });
      removers.push(swarmManager.observeCatalogDirty(change => queueCatalog(change.agentIds, change.profiles)));
      if (wireProjection.observeUnread) removers.push(wireProjection.observeUnread(sessionId => { eventSink.transaction(tx => upsertSession(tx, sessionId)); }));
    },
    async reconcileBeforeReady() {
      for (const descriptor of swarmManager.listAgentsForInternalUse()) indexDescriptor(descriptor);
      queueCatalog(undefined, true); queueCatalog(); await Promise.resolve(); await catalogWork;
      if (errors.has("catalog")) throw errors.get("catalog");
      const pending = database.prepare("SELECT choice_id,session_id,runtime_generation,choice_json FROM control_choices WHERE state='pending'").all() as { choice_id: string; session_id: string; runtime_generation: string; choice_json: string }[];
      eventSink.transaction(tx => {
        for (const row of pending) {
          const live = swarmManager.getPendingChoiceRequestsForSession(row.session_id).find(choice => choice.choiceId === row.choice_id);
          if (!live || (live as typeof live & { runtimeGeneration?: string }).runtimeGeneration !== row.runtime_generation) {
            const value = JSON.parse(row.choice_json) as ChoiceSummary; value.status = "interrupted";
            eventSink.append(tx, { topic: "detail", sessionId: row.session_id, event: { type: "choice.upsert", choice: value } }); upsertSession(tx, row.session_id);
          }
        }
        for (const descriptor of sessions.values()) for (const pending of swarmManager.getPendingChoiceRequestsForSession(descriptor.agentId)) choice(tx, pending);
      });
      for (const descriptor of swarmManager.listAgentsForInternalUse()) {
        const sessionId = actors.get(descriptor.agentId)!;
        if (checkpoint(`detail:${sessionId}`)) { initialized.add(sessionId); await tail(descriptor); }
        else if (!checkpoint(`source:${descriptor.agentId}`)) eventSink.transaction(() => recordSource(`source:${descriptor.agentId}`, source(descriptor.sessionFile)));
      }
      errors.clear();
    },
    ensureDetailInitialized(sessionId) {
      const existing = initializing.get(sessionId); if (existing) return existing;
      const work = (async () => {
        const descriptor = swarmManager.getAgentForInternalUse(sessionId); if (!descriptor || descriptor.role !== "manager") throw Object.assign(new Error("Session is missing."), { code: "NOT_FOUND", retryable: false });
        const sources = [descriptor, ...swarmManager.listWorkersForSession(sessionId)];
        if (!initialized.has(sessionId) && !checkpoint(`detail:${sessionId}`)) {
          const recent = sources.map(actor => ({ actor, evidence: source(actor.sessionFile), entries: swarmManager.getConversationHistoryPage(actor.agentId, { limit: 200 }).messages }));
          eventSink.transaction(tx => {
            for (const { actor, evidence, entries } of recent) { indexDescriptor(actor); for (const entry of entries) canonical(tx, entry, actor, evidence); recordSource(`source:${actor.agentId}`, evidence, entries.at(-1)?.timelineEntryId ?? null); }
            for (const worker of sources.slice(1)) upsertWorker(tx, worker);
            upsertSession(tx, sessionId); recordSource(`detail:${sessionId}`, { generation: "initialized", size: 0 });
          }); initialized.add(sessionId);
        } else { initialized.add(sessionId); for (const actor of sources) await tail(actor); }
      })().finally(() => initializing.delete(sessionId)); initializing.set(sessionId, work); return work;
    },
    notifyUnreadChanged(sessionId) { if (!disposed) eventSink.transaction(tx => upsertSession(tx, sessionId)); },
    dispose() { disposed = true; for (const remove of removers.splice(0)) remove(); initialized.clear(); sessions.clear(); actors.clear(); },
  };
  return mirror;
}
