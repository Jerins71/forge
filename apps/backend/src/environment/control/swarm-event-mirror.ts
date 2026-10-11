import { loadState } from "./orchestration/store.js";
import { projectLifecycleStatus } from "./orchestration/lifecycle-projection.js";
import { requestForChoice, requestAttention } from "./orchestration/request-projection.js";
import { projectAgentMetadata } from "@forge/protocol";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, openSync, readSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Database } from "better-sqlite3";
import { decodeEnvironmentValue, PlanSnapshotV2Schema, GoalSnapshotV2Schema } from "@forge/protocol/environment-v2";
import type { ArtifactRef, ProjectSummary, SessionSummary, DetailStreamItem, RpcInput, RpcOutput } from "@forge/protocol/environment-v2";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import type { AgentDescriptor, ConversationEntryEvent, ManagerProfile, ChoiceRequestEvent } from "../../swarm/types.js";
import { backfillConversationMessageEntryId, backfillConversationTimelineMetadata } from "../../swarm/session/conversation-entry-id.js";
import { isConversationEntryEvent } from "../../swarm/session/conversation-validators.js";
import { createConversationHistorySeamCursor, readConversationHistoryPage } from "../../swarm/session/conversation-page-reader.js";
import { sessionTransferCapabilities } from "./orchestration/transfers.js";
import { runtimeProviderCapabilities } from "../../swarm/runtime/provider-selection.js";
import type { Principal } from "./control-types.js";
import { CONVERSATION_ENTRY_TYPE } from "../../swarm/session/conversation-timeline.js";
import type { ControlTransaction, EventSink } from "./event-sink.js";
import { receiptIdentity } from "./event-sink.js";

type DetailItem = Extract<Extract<DetailStreamItem, { kind: "event" }>["event"], { type: "item.upsert" }>["item"];
type ChoiceSummary = Extract<Extract<DetailStreamItem, { kind: "event" }>["event"], { type: "choice.upsert" }>["choice"];
export interface MirrorWireProjection {
  project(profile: ManagerProfile): Promise<ProjectSummary>;
  /** Read the existing policy owner's result; subscribing to shell never changes it. */
  unread(sessionId: string, projectId: string): number;
  artifacts?(entry: ConversationEntryEvent, sessionId: string): ArtifactRef[];
  prepareArtifacts?(sessionId: string, entries: readonly ConversationEntryEvent[]): Promise<void>;
  /** Notify after the existing owner updates its count, including explicit foreground mark-read. */
  observeUnread?(listener: (sessionId: string) => void): () => void;
}
export interface SwarmEventMirror {
  attach(): void;
  reconcileBeforeReady(): Promise<void>;
  ensureDetailInitialized(sessionId: string): Promise<{ historyCursor: string | null }>;
  readHistory(principal: Principal, input: RpcInput<"session.history">): Promise<RpcOutput<"session.history">>;
  readContent(principal: Principal, input: RpcInput<"session.content">): Promise<RpcOutput<"session.content">>;
  dispose(): void;
  notifyUnreadChanged(sessionId: string): void;
}
interface HistoryState { sessionId: string; sources: { agentId: string; cursor: string | null }[] }
interface CanonicalRow { actor: AgentDescriptor; entry: ConversationEntryEvent; projected: DetailItem }
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
  swarmManager: Pick<SwarmManager, "getRestartRecoverySnapshot" | "getSessionPlanSnapshot" | "getSessionGoalSnapshot" | "on" | "off" | "listAgentsForInternalUse" | "getAgentForInternalUse" | "listProfiles" | "listWorkersForSession" | "getConversationHistoryPage" | "getPendingChoiceRequestsForSession" | "getSessionAttentionSnapshot" | "getPinnedMessageIds" | "observeCatalogDirty" | "isSessionShutdownSafe">;
  database: Database; eventSink: EventSink; wireProjection: MirrorWireProjection;
}): SwarmEventMirror {
  if (eventSink.database !== database) throw new Error("Mirror requires the shared environment database.");
  const sessions = new Map<string, AgentDescriptor>();
  const actors = new Map<string, string>();
  const userTurns = new Map<string, string>();
  const initialized = new Set<string>();
  const initializing = new Map<string, Promise<{ historyCursor: string | null }>>();
  const dirty = new Set<string>();
  const errors = new Map<string, unknown>();
  const removers: (() => void)[] = [];
  let attached = false; let ready = false; let disposed = false; let catalogQueued = false; let fullCatalogDirty = false; let profilesDirty = false;
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
    const state=loadState(database);
    const model=state.threads[descriptor.agentId]?.model ?? descriptor.model;
    const nativeBinding=Object.values(state.bindings).filter(b=>b.scope.threadId===descriptor.agentId && b.capabilities.provider===runtimeProviderCapabilities(model.provider).provider).sort((a,b)=>b.scope.generation-a.scope.generation)[0];
    const lineage=state.threads[descriptor.agentId]?.lineage;
    const occurrence = requestAttention(database, state, descriptor.agentId) ?? (attention ? { attentionId: attention.attentionId, reason: attention.reason, raisedAt: attention.raisedAt } : undefined);
    const lifecycle = projectLifecycleStatus(state, descriptor.agentId);
    const status = lifecycle ? lifecycle.sessionStatus : row?.desired_state === "stopped" ? swarmManager.isSessionShutdownSafe(descriptor.agentId) ? "stopped" : "stopping"
      : descriptor.status === "streaming" ? "running" : descriptor.status === "terminated" ? "stopped"
        : descriptor.status === "idle" && pending ? "waiting" : descriptor.status;
    return { transferCapabilities:sessionTransferCapabilities(nativeBinding), ...(lineage ? {lineage}:{}), projectAgent: descriptor.projectAgent ? projectAgentMetadata(descriptor.projectAgent) : null, sessionId: descriptor.agentId, projectId: descriptor.profileId ?? descriptor.agentId,
      title: (descriptor.sessionLabel ?? descriptor.displayName).slice(0, 256), status,
      attention: pending ? "choice" : descriptor.status === "error" ? "error" : attention ? "result" : "none",
      unread: wireProjection.unread(descriptor.agentId, descriptor.profileId ?? descriptor.agentId),
      pendingCount: prior?.pendingCount ?? 0,
      workerCount: descriptor.workerCount ?? swarmManager.listWorkersForSession(descriptor.agentId).length,
      createdAt: descriptor.createdAt, pinnedAt: descriptor.pinnedAt ?? null, lastUsedAt: descriptor.lastUserMessageAt ?? null,
      updatedAt: descriptor.updatedAt, sortKey: descriptor.createdAt, archived: Boolean(descriptor.archivedAt),
      workspace: { ...(prior?.workspace ?? { kind: "current_checkout", branch: null }), cwd: descriptor.cwd },
      ...(descriptor.managerPosture ? { delegation: { managerPosture: descriptor.managerPosture, managerPostureOrigin: descriptor.managerPostureOrigin ?? "product_default", rosterId: descriptor.delegationRosterId, rosterOrigin: descriptor.delegationRosterOrigin } } : {}),
      contextMode: { effective: descriptor.contextModeOverride ?? swarmManager.listProfiles().find(p => p.profileId === descriptor.profileId)?.defaultContextMode ?? "summary", ...(descriptor.contextModeOverride ? { override: descriptor.contextModeOverride } : {}) },
      model: { provider: model.provider, modelId: model.modelId, thinkingLevel: model.thinkingLevel,
        origin: model.provider !== descriptor.model.provider || model.modelId !== descriptor.model.modelId || descriptor.modelOrigin === "session_override" ? "session_override" : "profile_default" },
      ...(occurrence ? { attentionOccurrence: occurrence } : {}) };
  }
  function upsertSession(tx: ControlTransaction, sessionId: string, pendingCount?: number) {
    const descriptor = swarmManager.getAgentForInternalUse(sessionId);
    if (!descriptor || descriptor.role !== "manager" || swarmManager.listProfiles().some(profile => profile.profileId === descriptor.profileId && profile.profileType === "system")) return;
    indexDescriptor(descriptor); const next = summary(descriptor); if (pendingCount !== undefined && !database.prepare("SELECT 1 FROM orchestration_threads WHERE thread_id=?").get(sessionId)) next.pendingCount = pendingCount;
    if (JSON.stringify(next) !== JSON.stringify(storedSummary(sessionId))) eventSink.append(tx, { topic: "shell", sessionId, event: { type: "session.upsert", session: next } });
  }
  function upsertWorker(tx: ControlTransaction, descriptor: AgentDescriptor) {
    indexDescriptor(descriptor);
    const worker = { agentId: descriptor.agentId, title: descriptor.displayName.slice(0, 256), status: projectLifecycleStatus(loadState(database), descriptor.agentId)?.agentStatus ?? descriptor.status };
    const prior = database.prepare("SELECT worker_json FROM control_workers WHERE session_id=? AND agent_id=? AND deleted=0").get(descriptor.managerId, descriptor.agentId) as { worker_json: string } | undefined;
    if (JSON.stringify(worker) !== prior?.worker_json) eventSink.append(tx, { topic: "detail", sessionId: descriptor.managerId, event: { type: "worker.upsert", worker } });
  }
  function item(entry: ConversationEntryEvent, sessionId: string): DetailItem | null {
    if (!["conversation_message", "activity_summary", "agent_message", "agent_tool_call"].includes(entry.type)) return null;
    if (entry.type === "agent_tool_call" && entry.kind !== "tool_execution_end") return null;
    if (entry.type === "conversation_message" && entry.terminal === false) return null;
    // Each worker message is also copied into its manager's transcript for the legacy All view. The session
    // detail already carries the worker's own entry, so the copy is not a second item, and not a result.
    if (entry.type === "conversation_message" && entry.source === "worker_report" && entry.excludeFromModelContext) return null;
    // An internal input to the manager is already shown as what caused it (the worker result, the peer's
    // message). A worker's is its assignment: it travels as a user item whose source is `system`.
    if (entry.type === "conversation_message" && entry.role === "user" && entry.source === "system" && entry.agentId === sessionId) return null;
    const id = entry.timelineEntryId ?? ("id" in entry && typeof entry.id === "string" ? entry.id : undefined);
    if (!id) return null;
    const text = "text" in entry && typeof entry.text === "string" ? entry.text : "displaySummary" in entry && typeof entry.displaySummary === "string" ? entry.displaySummary : "";
    const workerResult = entry.type === "conversation_message" && entry.source === "worker_report";
    const user = entry.type === "conversation_message" && entry.role === "user" && !workerResult;
    const resend = user ? database.prepare("SELECT command_id,input_id FROM control_inputs WHERE session_id=? AND canonical_entry_id=? ORDER BY rowid DESC LIMIT 1").get(sessionId, id) as { command_id: string; input_id: string } | undefined : undefined;
    const currentRun = resend ? database.prepare("SELECT run_id FROM orchestration_runs WHERE input_id=?").get(resend.input_id) as { run_id: string } | undefined : undefined;
    const runId=currentRun?.run_id ?? ("turnId" in entry && entry.turnId && database.prepare("SELECT 1 FROM orchestration_runs WHERE run_id=? AND thread_id=?").get(entry.turnId,entry.agentId) ? entry.turnId:undefined);
    return { itemId: id, ...(runId ? {runId}:{}), userTurnId: user ? entry.id ?? id : userTurns.get(sessionId) ?? ("turnId" in entry ? entry.turnId : undefined) ?? id,
      actorId: workerResult && entry.sourceWorkerId ? entry.sourceWorkerId : "actorAgentId" in entry ? entry.actorAgentId : entry.agentId,
      kind: workerResult ? "worker_result" : entry.type === "conversation_message" ? user ? "user" : "assistant" : entry.type === "agent_tool_call" ? "tool" : "activity",
      pinned: swarmManager.getPinnedMessageIds(sessionId)?.has(entry.type === "conversation_message" ? entry.id ?? id : id) ?? false,
      timestamp: entry.timestamp, ...(entry.type === "conversation_message" ? { source: entry.source } : {}), text: text.slice(0, 8192), contentRef: text.length > 8192 ? id : null,
      artifacts: (wireProjection.artifacts?.(entry, sessionId) ?? []).slice(0, 20),
      commandId: resend ? receiptIdentity(resend.command_id) : entry.type === "conversation_message" && entry.controlCommandId ? receiptIdentity(entry.controlCommandId) : null };
  }
  function canonical(tx: ControlTransaction, entry: ConversationEntryEvent, descriptor: AgentDescriptor, evidence: Source, projectedItem?: DetailItem) {
    const sessionId = actors.get(descriptor.agentId) ?? (descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId);
    if (!userTurns.has(sessionId)) {
      const head = database.prepare("SELECT user_turn_id FROM detail_items WHERE session_id=? ORDER BY updated_sequence DESC LIMIT 1").get(sessionId) as { user_turn_id: string } | undefined;
      if (head) userTurns.set(sessionId, head.user_turn_id);
    }
    if (descriptor.role === "manager" && entry.type === "conversation_message" && entry.role === "user") userTurns.set(sessionId, entry.id ?? entry.timelineEntryId!);
    const projected = projectedItem ?? item(entry, sessionId);
    if (projected && descriptor.role === "worker" && !projectedItem) projected.userTurnId = userTurns.get(sessionId) ?? projected.userTurnId;
    if (projected) eventSink.append(tx, { topic: "detail", sessionId,
      sourceKey: `canonical:${descriptor.agentId}:${evidence.generation}:${checkpoint(`detail:${sessionId}`)?.file_generation ?? "initial"}:${projected.itemId}`,
      event: { type: "item.upsert", item: projected } });
  }
  function rpcFailure(code: string, message: string): Error & { code: string; retryable: boolean } {
    return Object.assign(new Error(message), { code, retryable: false });
  }
  function sessionSources(sessionId: string): AgentDescriptor[] {
    const descriptor = swarmManager.getAgentForInternalUse(sessionId);
    if (!descriptor || descriptor.role !== "manager") throw rpcFailure("NOT_FOUND", "Session is unavailable.");
    return [descriptor, ...swarmManager.listWorkersForSession(sessionId)];
  }
  function authorizeRead(principal: Principal, sessionId: string) {
    if (!principal.scopes.has("session:read")) throw rpcFailure("FORBIDDEN", "Session reading requires session:read.");
    const device = database.prepare("SELECT revoked_at,expires_at FROM device_sessions WHERE device_session_id=?").get(principal.deviceSessionId) as { revoked_at: number | null; expires_at: number } | undefined;
    if (!device || device.revoked_at !== null || device.expires_at <= Date.now()) throw rpcFailure("UNAUTHENTICATED", "Device access is no longer active.");
    sessionSources(sessionId);
  }
  function historyState(sessionId: string, cursor?: string): HistoryState | undefined {
    if (!cursor) return;
    if (!/^history:[a-f0-9-]{36}$/.test(cursor)) throw rpcFailure("RESYNC_REQUIRED", "History cursor is unavailable.");
    const row = database.prepare("SELECT last_entry_id FROM mirror_sources WHERE source_key=? AND file_generation='history-v1'").get(cursor) as { last_entry_id: string } | undefined;
    if (!row) throw rpcFailure("RESYNC_REQUIRED", "History cursor is unavailable.");
    const state = JSON.parse(row.last_entry_id) as HistoryState;
    if (state.sessionId !== sessionId) throw rpcFailure("RESYNC_REQUIRED", "History cursor belongs to another session.");
    return state;
  }
  function saveHistoryCursor(state: HistoryState): string | null {
    if (state.sources.every(source => source.cursor === null)) return null;
    const cursor = `history:${randomUUID()}`;
    eventSink.transaction(() => {
      // Opaque source locators survive restart, without placing per-worker cursor state on the wire.
      recordSource(cursor, { generation: "history-v1", size: 0 }, JSON.stringify(state));
      database.prepare("DELETE FROM mirror_sources WHERE source_key LIKE 'history:%' AND updated_at<?").run(Date.now() - 7 * 86_400_000);
      database.prepare("DELETE FROM mirror_sources WHERE source_key IN (SELECT source_key FROM mirror_sources WHERE source_key LIKE 'history:%' ORDER BY updated_at DESC LIMIT -1 OFFSET 10000)").run();
    });
    return cursor;
  }
  function historyWindow(sessionId: string, turns: number, state?: HistoryState): { rows: CanonicalRow[]; next: HistoryState } {
    const actors = sessionSources(sessionId);
    if (state && state.sources.some(source => !actors.some(actor => actor.agentId === source.agentId))) throw rpcFailure("RESYNC_REQUIRED", "History source changed.");
    const pages = actors.flatMap(actor => {
      const prior = state?.sources.find(source => source.agentId === actor.agentId);
      if (state && (!prior || prior.cursor === null)) return [];
      const page = readConversationHistoryPage({ sessionFile: actor.sessionFile, agentId: actor.agentId, cursor: prior?.cursor ?? undefined,
        projectionKey: "environment-v2", limit: 200, projectForWire: false, isVisible: entry => Boolean(item(entry, sessionId)) });
      if (page.page.completeness === "source_changed") throw rpcFailure("RESYNC_REQUIRED", "Canonical history source changed.");
      return [{ actor, prior: prior?.cursor, page }];
    });
    const rows = pages.flatMap(({ actor, page }) => {
      let orderTime = "";
      return page.messages.map((entry, sourceIndex) => {
        // Queued input retains admission time but is appended after the prior final.
        // Keep each source's canonical order so its byte cursor cannot repeat rows.
        if (entry.timestamp > orderTime) orderTime = entry.timestamp;
        return { actor, entry, projected: item(entry, sessionId)!, orderTime, sourceIndex };
      });
    }).sort((left, right) => left.orderTime.localeCompare(right.orderTime) || left.actor.agentId.localeCompare(right.actor.agentId) || left.sourceIndex - right.sourceIndex);
    let turnId: string | undefined;
    for (const row of rows) {
      if (row.actor.role === "manager" && row.projected.kind === "user") turnId = row.projected.userTurnId;
      row.projected.userTurnId = turnId ?? row.projected.itemId;
    }
    const userRows = rows.filter(row => row.actor.role === "manager" && row.projected.kind === "user");
    const boundary = userRows.length > turns ? rows.indexOf(userRows[userRows.length - turns]!) : 0;
    const selected = rows.slice(boundary).slice(-200);
    const next = { sessionId, sources: actors.map(actor => {
      const page = pages.find(page => page.actor.agentId === actor.agentId);
      if (!page) return { agentId: actor.agentId, cursor: null };
      const delivered = selected.filter(row => row.actor.agentId === actor.agentId);
      if (delivered.length === page.page.messages.length) return { agentId: actor.agentId, cursor: page.page.page.nextCursor ?? null };
      return { agentId: actor.agentId, cursor: delivered.length
        ? createConversationHistorySeamCursor(actor.sessionFile, delivered[0]!.projected.itemId, "environment-v2") ?? null
        : page.prior ?? createConversationHistorySeamCursor(actor.sessionFile, undefined, "environment-v2") ?? null };
    }) };
    return { rows: selected, next };
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
  function resetDetail(tx: ControlTransaction, sessionId: string) {
    eventSink.append(tx, { topic: "detail", sessionId, event: { type: "detail.reset" } });
    if (checkpoint(`detail:${sessionId}`)) recordSource(`detail:${sessionId}`, { generation: `reset:${randomUUID()}`, size: 0 });
    initialized.delete(sessionId); userTurns.delete(sessionId);
  }
  function observeCanonical(entry: ConversationEntryEvent) {
    const descriptor = swarmManager.getAgentForInternalUse(entry.agentId); if (!descriptor) return;
    indexDescriptor(descriptor);
    // Live publication is best-effort for legacy inputs; only bytes from the canonical writer advance this cursor.
    tail(descriptor);
  }
  function queueCatalog(ids?: readonly string[], profiles = false) {
    if (ids && !fullCatalogDirty) for (const id of ids) dirty.add(actors.get(id) ?? id); else if (!profiles) fullCatalogDirty = true;
    if (dirty.size > 4096) { dirty.clear(); fullCatalogDirty = true; }
    profilesDirty ||= profiles;
    if (!ready || catalogQueued || disposed) return; catalogQueued = true;
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
    const wrapped = (event: T) => { if (!ready) return; try { handler(event); } catch (error) { errors.set(name, error); } };
    swarmManager.on(name, wrapped); removers.push(() => swarmManager.off(name, wrapped));
  }
  function tail(descriptor: AgentDescriptor) {
    const key = `source:${descriptor.agentId}`; const prior = checkpoint(key); const evidence = source(descriptor.sessionFile);
    const sessionId = descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
    if (!evidence.size) return;
    const reset = prior && (prior.file_generation !== evidence.generation || prior.byte_offset > evidence.size);
    let offset = reset ? 0 : prior?.byte_offset ?? 0;
    if (reset) eventSink.transaction(tx => { resetDetail(tx, sessionId); recordSource(key, { ...evidence, size: 0 }); });
    if (offset >= evidence.size) return;
    const fd = openSync(descriptor.sessionFile, "r"); let remainder = Buffer.alloc(0); let remainderStart = offset;
    try {
      while (offset < evidence.size) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, evidence.size - offset)); const bytesRead = readSync(fd, buffer, 0, buffer.length, offset); if (!bytesRead) break;
        offset += bytesRead; const combined = Buffer.concat([remainder, buffer.subarray(0, bytesRead)]); const lastNewline = combined.lastIndexOf(10);
        if (lastNewline < 0) { remainder = combined; if (remainder.length > 4 * 1024 * 1024) throw new Error("Canonical entry exceeds mirror scan budget."); continue; }
        const lines = combined.subarray(0, lastNewline + 1).toString("utf8").split("\n"); const entries: ConversationEntryEvent[] = [];
        for (const line of lines) { if (!line) continue; let raw: { id?: string; customType?: string; data?: unknown }; try { raw = JSON.parse(line) as typeof raw; } catch { throw new Error("Canonical source contains a malformed completed entry."); } if (raw.customType === CONVERSATION_ENTRY_TYPE && isConversationEntryEvent(raw.data)) entries.push(backfillConversationTimelineMetadata(backfillConversationMessageEntryId(raw.data, raw.id), raw.id, remainderStart)); }
        const completeOffset = remainderStart + lastNewline + 1;
        eventSink.transaction(tx => { for (const entry of entries) { canonical(tx, entry, descriptor, evidence); if (entry.type === "choice_request") choice(tx, entry); } upsertSession(tx, sessionId); recordSource(key, { ...evidence, size: completeOffset }, entries.at(-1)?.timelineEntryId ?? null); });
        remainder = combined.subarray(lastNewline + 1); remainderStart = completeOffset;
      }
    } finally { closeSync(fd); }
  }
  function detailFeature(sessionId: string, type: "plan.upsert" | "goal.upsert", raw: unknown) {
    const snapshot = type === "plan.upsert" ? decodeEnvironmentValue(PlanSnapshotV2Schema, raw) : decodeEnvironmentValue(GoalSnapshotV2Schema, raw);
    if (!snapshot) throw new Error("Invalid typed detail snapshot");
    const prior = database.prepare("SELECT payload_json FROM events WHERE session_id=? AND event_type=? ORDER BY sequence DESC LIMIT 1").get(sessionId, type) as { payload_json: string } | undefined;
    if (prior && JSON.stringify(JSON.parse(prior.payload_json).snapshot) === JSON.stringify(snapshot)) return;
    eventSink.transaction(tx => eventSink.append(tx, { topic: "detail", sessionId, event: type === "plan.upsert"
      ? { type, snapshot: snapshot as import("@forge/protocol").SessionPlanSnapshot }
      : { type, snapshot: snapshot as import("@forge/protocol").SessionGoalSnapshot } }));
  }
  const mirror: SwarmEventMirror = {
    attach() {
      if (attached || disposed) return; attached = true;
      listen("session_plan_snapshot", (event: { sessionAgentId: string }) => detailFeature(event.sessionAgentId, "plan.upsert", event));
      listen("session_goal_snapshot", (event: { sessionAgentId: string }) => detailFeature(event.sessionAgentId, "goal.upsert", event));
      for (const name of ["conversation_message", "activity_summary", "agent_message", "agent_tool_call"]) listen(name, observeCanonical);
      listen("choice_request", (event: ChoiceRequestEvent) => { eventSink.transaction(tx => choice(tx, event)); });
      listen("agent_status", (event: { agentId: string; pendingCount: number }) => { const descriptor = swarmManager.getAgentForInternalUse(event.agentId); if (!descriptor) return; eventSink.transaction(tx => { if (descriptor.role === "worker") upsertWorker(tx, descriptor); upsertSession(tx, descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId, descriptor.role === "manager" ? event.pendingCount : undefined); }); });
      listen("session_workers_snapshot", (event: { sessionAgentId: string; workers: AgentDescriptor[] }) => {
        eventSink.transaction(tx => { const ids = new Set(event.workers.map(worker => worker.agentId)); for (const worker of event.workers) upsertWorker(tx, worker);
          const prior = database.prepare("SELECT agent_id FROM control_workers WHERE session_id=? AND deleted=0").all(event.sessionAgentId) as { agent_id: string }[];
          for (const row of prior) if (!ids.has(row.agent_id)) eventSink.append(tx, { topic: "detail", sessionId: event.sessionAgentId, event: { type: "worker.remove", agentId: row.agent_id } }); upsertSession(tx, event.sessionAgentId); });
      });
      listen("session_lifecycle", (event: { action: string; sessionAgentId?: string }) => { if (event.action === "deleted" && event.sessionAgentId) { eventSink.transaction(tx => eventSink.append(tx, { topic: "shell", sessionId: event.sessionAgentId!, event: { type: "session.remove", sessionId: event.sessionAgentId! } })); sessions.delete(event.sessionAgentId); } else queueCatalog(event.sessionAgentId ? [event.sessionAgentId] : undefined); });
      listen("conversation_reset", (event: { agentId: string }) => { const descriptor = swarmManager.getAgentForInternalUse(event.agentId); if (!descriptor) return; eventSink.transaction(tx => { resetDetail(tx, descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId); recordSource(`source:${descriptor.agentId}`, source(descriptor.sessionFile)); }); });
      listen("message_pinned", (event: { agentId: string; messageId: string; pinned: boolean }) => {
        const rows = database.prepare("SELECT item_json FROM detail_items WHERE session_id=?").all(event.agentId) as { item_json: string }[];
        eventSink.transaction(tx => { for (const row of rows) {
          const value = JSON.parse(row.item_json) as DetailItem;
          // Clear-all emits legacy message IDs after the pin owner empties its registry.
          // Canonical item IDs may differ, so clear every projected pin in that case.
          if (value.itemId !== event.messageId && (event.pinned || swarmManager.getPinnedMessageIds(event.agentId)?.size)) continue;
          if ((value.pinned ?? false) === event.pinned) continue;
          eventSink.append(tx, { topic: "detail", sessionId: event.agentId, event: { type: "item.upsert", item: { ...value, pinned: event.pinned } } });
        } });
      });
      listen("session_attention_snapshot", () => { queueCatalog([...sessions.keys()]); });
      removers.push(swarmManager.observeCatalogDirty(change => queueCatalog(change.agentIds, change.profiles)));
      if (wireProjection.observeUnread) removers.push(wireProjection.observeUnread(sessionId => { if (!ready) return; eventSink.transaction(tx => upsertSession(tx, sessionId)); }));
    },
    async reconcileBeforeReady() {
      ready = true; // Boot events fold from the authoritative catalog and persisted sources below.
      for (const descriptor of swarmManager.listAgentsForInternalUse()) indexDescriptor(descriptor);
      queueCatalog(undefined, true); queueCatalog(); await Promise.resolve(); await catalogWork;
      if (errors.has("catalog")) throw errors.get("catalog");
      const pending = database.prepare("SELECT choice_id,session_id,runtime_generation,choice_json FROM control_choices WHERE state='pending'").all() as { choice_id: string; session_id: string; runtime_generation: string; choice_json: string }[];
      eventSink.transaction(tx => {
        for (const row of pending) {
          if (requestForChoice(loadState(database), row.choice_id)) continue;
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
        if (checkpoint(`detail:${sessionId}`)) { if (checkpoint(`detail:${sessionId}`)?.byte_offset === 1) initialized.add(sessionId); tail(descriptor); }
        else if (!checkpoint(`source:${descriptor.agentId}`)) eventSink.transaction(() => recordSource(`source:${descriptor.agentId}`, source(descriptor.sessionFile)));
      }
      errors.clear();
    },
    ensureDetailInitialized(sessionId) {
      const existing = initializing.get(sessionId); if (existing) return existing;
      const work = (async () => {
        const sources = sessionSources(sessionId);
        if (swarmManager.getSessionPlanSnapshot) detailFeature(sessionId, "plan.upsert", await swarmManager.getSessionPlanSnapshot(sessionId));
        if (swarmManager.getSessionGoalSnapshot) detailFeature(sessionId, "goal.upsert", await swarmManager.getSessionGoalSnapshot(sessionId));
        if (checkpoint(`detail:${sessionId}`)) for (const actor of sources) tail(actor);
        const recent = historyWindow(sessionId, 20);
        await wireProjection.prepareArtifacts?.(sessionId, recent.rows.map(row => row.entry));
        if (!initialized.has(sessionId) || checkpoint(`detail:${sessionId}`)?.byte_offset !== 1) {
          eventSink.transaction(tx => {
            for (const row of recent.rows) { indexDescriptor(row.actor); canonical(tx, row.entry, row.actor, source(row.actor.sessionFile), { ...row.projected, artifacts: (wireProjection.artifacts?.(row.entry, sessionId) ?? []).slice(0, 20) }); }
            for (const actor of sources) recordSource(`source:${actor.agentId}`, source(actor.sessionFile));
            for (const worker of sources.slice(1)) upsertWorker(tx, worker);
            upsertSession(tx, sessionId); recordSource(`detail:${sessionId}`, { generation: checkpoint(`detail:${sessionId}`)?.file_generation ?? "initial", size: 1 });
          }); initialized.add(sessionId);
        } else { initialized.add(sessionId); for (const actor of sources) tail(actor); }
        return { historyCursor: saveHistoryCursor(recent.next) };
      })().finally(() => initializing.delete(sessionId)); initializing.set(sessionId, work); return work;
    },
    async readHistory(principal, input) {
      authorizeRead(principal, input.sessionId);
      if (!Number.isInteger(input.turns) || input.turns < 1 || input.turns > 20) throw rpcFailure("INVALID_INPUT", "History accepts one to twenty user turns.");
      const window = historyWindow(input.sessionId, input.turns, historyState(input.sessionId, input.before));
      await wireProjection.prepareArtifacts?.(input.sessionId, window.rows.map(row => row.entry));
      authorizeRead(principal, input.sessionId);
      const nextCursor = saveHistoryCursor(window.next);
      const barrier = eventSink.readBarrier(() => window.rows.map(row => ({ ...row.projected, artifacts: (wireProjection.artifacts?.(row.entry, input.sessionId) ?? []).slice(0, 20) })));
      return { sequence: barrier.highWater, streamEpoch: barrier.streamEpoch, items: barrier.value, nextCursor };
    },
    async readContent(principal, input) {
      authorizeRead(principal, input.sessionId);
      if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 262144) throw rpcFailure("INVALID_INPUT", "Content byte range is invalid.");
      for (const actor of sessionSources(input.sessionId)) {
        const evidence = source(actor.sessionFile); if (!evidence.size) continue;
        // Content is resolved from the canonical row, including rows too large for bounded history pages.
        const stream = createReadStream(actor.sessionFile, { end: evidence.size - 1 });
        const lines = createInterface({ input: stream, crlfDelay: Infinity }); let count = 0;
        try {
          for await (const line of lines) {
            if (++count % 256 === 0) authorizeRead(principal, input.sessionId);
            let raw: { id?: string; customType?: string; data?: unknown };
            try { raw = JSON.parse(line) as typeof raw; } catch { continue; }
            if (raw.customType !== CONVERSATION_ENTRY_TYPE || !isConversationEntryEvent(raw.data)) continue;
            const entry = backfillConversationTimelineMetadata(backfillConversationMessageEntryId(raw.data, raw.id), raw.id, 0);
            if (entry.timelineEntryId !== input.contentRef && !("id" in entry && entry.id === input.contentRef)) continue;
            const text = "text" in entry && typeof entry.text === "string" ? entry.text : "displaySummary" in entry && typeof entry.displaySummary === "string" ? entry.displaySummary : "";
            const bytes = Buffer.from(text, "utf8");
            if (input.offset > bytes.length || (input.offset < bytes.length && (bytes[input.offset]! & 0xc0) === 0x80)) throw rpcFailure("INVALID_INPUT", "Content offset is not a UTF-8 boundary.");
            let end = Math.min(bytes.length, input.offset + input.maxBytes);
            while (end > input.offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
            if (end === input.offset && end < bytes.length) throw rpcFailure("INVALID_INPUT", "Content byte limit cannot contain the next character.");
            authorizeRead(principal, input.sessionId);
            const current = source(actor.sessionFile);
            if (current.generation !== evidence.generation || current.size < evidence.size) throw rpcFailure("RESYNC_REQUIRED", "Canonical content source changed.");
            return { text: bytes.subarray(input.offset, end).toString("utf8"), nextOffset: end < bytes.length ? end : null };
          }
        } finally { lines.close(); stream.destroy(); }
      }
      throw rpcFailure("NOT_FOUND", "Canonical content reference is unavailable.");
    },
    notifyUnreadChanged(sessionId) { if (ready && !disposed) eventSink.transaction(tx => upsertSession(tx, sessionId)); },
    dispose() { disposed = true; for (const remove of removers.splice(0)) remove(); initialized.clear(); sessions.clear(); actors.clear(); },
  };
  return mirror;
}
