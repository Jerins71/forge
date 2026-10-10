import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { SwarmAgentRuntime } from "./runtime-contracts.js";
import type { Database } from "better-sqlite3";
import type { RecoverySnapshot } from "@forge/protocol/environment-v2";
import { withEnvironmentDatabase } from "../environment/control/database.js";
import { getSessionTurnLedgerPath } from "./storage/data-paths.js";

export type RecoveryInboundKind = "user" | "worker_report" | "schedule" | "agent_message" | "project_agent" | "system";
export type RecoveryTerminalOutcome = "agent_end" | "idle" | "error" | "recycled" | "abandoned" | "reconciled";
export interface RecoveryTarget { dataDir: string; profileId: string; sessionAgentId: string; canonicalFiles?: readonly string[]; actorIds?: readonly string[] }
export type RecoveryContentRef = { file: string; entryId: string } | { file: string; line: number };
export type RecoveryFact =
  | { t: "turn_dispatched"; turnId: string; agentId: string; role: "manager" | "worker"; inboundId?: string; kind: RecoveryInboundKind; at: string }
  | { t: "turn_terminal"; turnId: string; outcome: RecoveryTerminalOutcome; at: string }
  | { t: "turn_stalled"; turnId: string; agentId: string; tier: 1 | 2 | 3; at: string }
  | { t: "delivery_pending"; turnId?: string; deliveryId: string; from: string; to: string; contentRef?: RecoveryContentRef; assignmentId?: string; at: string }
  | { t: "delivery_acked"; deliveryId: string; at: string };
export type RecoveryDelivery = Extract<RecoveryFact, { t: "delivery_pending" }> & { state: "pending" | "dispatching" };
export interface RecoveryState {
  openTurns: Map<string, Extract<RecoveryFact, { t: "turn_dispatched" }> & { recoveryId?: string }>;
  terminalTurns: Map<string, Extract<RecoveryFact, { t: "turn_terminal" }>>;
  pendingDeliveries: Map<string, RecoveryDelivery>;
  ackedDeliveries: Set<string>;
}

function applyFact(database: Database, sessionId: string, fact: RecoveryFact): void {
  switch (fact.t) {
    case "turn_dispatched":
      database.prepare(`INSERT INTO control_turns (session_id,turn_id,agent_id,role,inbound_kind,inbound_id,dispatched_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(session_id,turn_id) DO UPDATE SET agent_id=excluded.agent_id,role=excluded.role,inbound_kind=excluded.inbound_kind,inbound_id=excluded.inbound_id,dispatched_at=COALESCE(control_turns.dispatched_at,excluded.dispatched_at)`)
        .run(sessionId, fact.turnId, fact.agentId, fact.role, fact.kind, fact.inboundId ?? null, fact.at); break;
    case "turn_terminal":
      database.prepare(`INSERT INTO control_turns (session_id,turn_id,terminal_outcome,terminal_at) VALUES (?,?,?,?)
        ON CONFLICT(session_id,turn_id) DO UPDATE SET terminal_outcome=excluded.terminal_outcome,terminal_at=excluded.terminal_at`).run(sessionId, fact.turnId, fact.outcome, fact.at); break;
    case "turn_stalled":
      database.prepare(`INSERT INTO control_turns (session_id,turn_id,agent_id,stalled_tier,stalled_at) VALUES (?,?,?,?,?)
        ON CONFLICT(session_id,turn_id) DO UPDATE SET stalled_tier=excluded.stalled_tier,stalled_at=excluded.stalled_at`).run(sessionId, fact.turnId, fact.agentId, fact.tier, fact.at); break;
    case "delivery_pending":
      database.prepare(`INSERT INTO control_deliveries (session_id,delivery_id,turn_id,from_agent_id,to_agent_id,assignment_id,content_ref_json,pending_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(session_id,delivery_id) DO NOTHING`).run(sessionId, fact.deliveryId, fact.turnId ?? null, fact.from, fact.to, fact.assignmentId ?? null, fact.contentRef ? JSON.stringify(fact.contentRef) : null, fact.at); break;
    case "delivery_acked":
      database.prepare(`INSERT INTO control_deliveries (session_id,delivery_id,state,acked_at) VALUES (?,?,'acked',?)
        ON CONFLICT(session_id,delivery_id) DO UPDATE SET state='acked',acked_at=excluded.acked_at`).run(sessionId, fact.deliveryId, fact.at); break;
  }
}

/** Read-only import codec. The historical files are retained, including content referenced by deliveries. */
export async function prepareRecoveryImport(database: Database, target: RecoveryTarget): Promise<() => void> {
  if (database.prepare("SELECT 1 FROM recovery_imports WHERE session_id=?").get(target.sessionAgentId)) return () => {};
  const facts: RecoveryFact[] = [];
  const notes: { turnId: string; receipt: string; at: string }[] = [];
  for (const file of [getSessionTurnLedgerPath(target.dataDir, target.profileId, target.sessionAgentId) + ".1", getSessionTurnLedgerPath(target.dataDir, target.profileId, target.sessionAgentId)]) {
    let raw: string;
    try { raw = await readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const lines = raw.split("\n");
    for (let line = 0; line < lines.length; line++) {
      if (!lines[line]?.trim()) continue;
      let record: RecoveryFact & { message?: string; receipt?: string };
      try { record = JSON.parse(lines[line]!); }
      catch { throw new Error("Invalid historical recovery data; runtime is gated"); }
      assertHistoricalFact(record);
      if (record.t as string === "recovery_receipt") {
        const receipt = record as unknown as { turnId?: string; receipt: string; at: string };
        if (receipt.turnId) notes.push({ turnId: receipt.turnId, receipt: receipt.receipt, at: receipt.at });
        continue;
      }
      if (!["turn_dispatched", "turn_terminal", "turn_stalled", "delivery_pending", "delivery_acked"].includes(record.t)) throw new Error("Unknown historical recovery fact; runtime is gated");
      if (record.t === "delivery_pending") { const { message: _message, ...fact } = record; facts.push({ ...fact, ...(record.message ? { contentRef: { file, line } } : {}) }); }
      else facts.push(record);
    }
  }
  return () => database.transaction(() => {
    if (database.prepare("SELECT 1 FROM recovery_imports WHERE session_id=?").get(target.sessionAgentId)) return;
    for (const fact of facts) applyFact(database, target.sessionAgentId, fact);
    for (const note of notes) database.prepare("UPDATE control_turns SET recovery_note=?,recovery_at=? WHERE session_id=? AND turn_id=?").run(note.receipt, note.at, target.sessionAgentId, note.turnId);
    database.prepare("INSERT INTO recovery_imports VALUES (?,?)").run(target.sessionAgentId, facts.length + notes.length);
  }).immediate();
}
function assertHistoricalFact(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid historical recovery fact; runtime is gated");
  const record = value as Record<string, unknown>;
  const text = (key: string) => typeof record[key] === "string" && (record[key] as string).length > 0;
  const optional = (key: string) => record[key] === undefined || typeof record[key] === "string";
  let valid = text("at");
  switch (record.t) {
    case "turn_dispatched": valid &&= text("turnId") && text("agentId") && ["manager", "worker"].includes(String(record.role)) && ["user", "worker_report", "schedule", "agent_message", "project_agent", "system"].includes(String(record.kind)) && optional("inboundId"); break;
    case "turn_terminal": valid &&= text("turnId") && ["agent_end", "idle", "error", "recycled", "abandoned", "reconciled"].includes(String(record.outcome)); break;
    case "turn_stalled": valid &&= text("turnId") && text("agentId") && typeof record.tier === "number" && [1, 2, 3].includes(record.tier); break;
    case "delivery_pending": valid &&= text("deliveryId") && text("from") && text("to") && optional("message") && optional("turnId") && optional("assignmentId"); break;
    case "delivery_acked": valid &&= text("deliveryId"); break;
    case "recovery_receipt": valid &&= text("receipt") && optional("turnId") && optional("deliveryId") && optional("agentId"); break;
    default: valid = false;
  }
  if (!valid) throw new Error("Invalid historical recovery fact; runtime is gated");
}

export async function importRecoveryState(database: Database, target: RecoveryTarget): Promise<void> {
  (await prepareRecoveryImport(database, target))();
}
export async function recordRecoveryFact(target: RecoveryTarget, fact: RecoveryFact): Promise<void> {
  await withEnvironmentDatabase(target.dataDir, async database => { await importRecoveryState(database, target); database.transaction(() => applyFact(database, target.sessionAgentId, fact)).immediate(); });
}
export async function readRecoveryState(target: RecoveryTarget): Promise<RecoveryState> {
  return withEnvironmentDatabase(target.dataDir, async database => {
    await importRecoveryState(database, target);
    await reconcileRecoveryContent(database, target);
    const state: RecoveryState = { openTurns: new Map(), terminalTurns: new Map(), pendingDeliveries: new Map(), ackedDeliveries: new Set() };
    const turns = database.prepare("SELECT * FROM control_turns WHERE session_id=? ORDER BY turn_id").all(target.sessionAgentId) as { turn_id: string; agent_id: string; role: "manager" | "worker"; inbound_kind: RecoveryInboundKind; inbound_id: string | null; dispatched_at: string | null; terminal_outcome: RecoveryTerminalOutcome | null; terminal_at: string | null; recovery_id: string | null }[];
    for (const turn of turns) {
      if (turn.terminal_outcome) state.terminalTurns.set(turn.turn_id, { t: "turn_terminal", turnId: turn.turn_id, outcome: turn.terminal_outcome, at: turn.terminal_at! });
      else if (turn.dispatched_at) state.openTurns.set(turn.turn_id, { t: "turn_dispatched", turnId: turn.turn_id, agentId: turn.agent_id, role: turn.role, kind: turn.inbound_kind, ...(turn.inbound_id ? { inboundId: turn.inbound_id } : {}), ...(turn.recovery_id ? { recoveryId: turn.recovery_id } : {}), at: turn.dispatched_at });
    }
    const deliveries = database.prepare("SELECT * FROM control_deliveries WHERE session_id=? ORDER BY delivery_id").all(target.sessionAgentId) as { delivery_id: string; turn_id: string | null; from_agent_id: string; to_agent_id: string; assignment_id: string | null; content_ref_json: string | null; pending_at: string; state: "pending" | "dispatching" | "acked" }[];
    for (const delivery of deliveries) {
      if (delivery.state === "acked") state.ackedDeliveries.add(delivery.delivery_id);
      else state.pendingDeliveries.set(delivery.delivery_id, { t: "delivery_pending", deliveryId: delivery.delivery_id, from: delivery.from_agent_id, to: delivery.to_agent_id, at: delivery.pending_at, state: delivery.state, ...(delivery.turn_id ? { turnId: delivery.turn_id } : {}), ...(delivery.assignment_id ? { assignmentId: delivery.assignment_id } : {}), ...(delivery.content_ref_json ? { contentRef: JSON.parse(delivery.content_ref_json) } : {}) });
    }
    return state;
  });
}
export async function claimRecoveryDelivery(target: RecoveryTarget, deliveryId: string): Promise<boolean> {
  return withEnvironmentDatabase(target.dataDir, async db => db.prepare("UPDATE control_deliveries SET state='dispatching' WHERE session_id=? AND delivery_id=? AND state='pending'").run(target.sessionAgentId, deliveryId).changes === 1);
}
export async function readRecoveryContent(ref: RecoveryContentRef): Promise<string | undefined> {
  let line = 0;
  for await (const text of createInterface({ input: createReadStream(ref.file, { encoding: "utf8" }), crlfDelay: Infinity })) {
    const index = line++;
    if (!text.trim() || "line" in ref && ref.line !== index) continue;
    const record = JSON.parse(text) as { id?: string; data?: { message?: string }; message?: string };
    if ("line" in ref || ref.entryId === record.id) return record.data?.message ?? record.message;
  }
  return undefined;
}
export async function readRecoveryOccurrence(dataDir: string): Promise<RecoverySnapshot | null> {
  return withEnvironmentDatabase(dataDir, async db => {
    const row = db.prepare("SELECT snapshot_json FROM control_recovery WHERE json_extract(snapshot_json,'$.supersededBy') IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 1").get() as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) : null;
  });
}
export async function saveRecoveryOccurrence(dataDir: string, snapshot: RecoverySnapshot, supersedes?: string): Promise<void> {
  await withEnvironmentDatabase(dataDir, async db => {
    db.transaction(() => {
      const inserted = db.prepare("INSERT INTO control_recovery (recovery_id,snapshot_json,created_at) VALUES (?,?,?) ON CONFLICT(recovery_id) DO NOTHING").run(snapshot.recoveryId, JSON.stringify(snapshot), snapshot.createdAt).changes;
      if (!inserted) return;
      if (supersedes) {
        const superseded = db.prepare(`UPDATE control_recovery SET snapshot_json=json_set(snapshot_json,'$.supersededBy',?),decision_applied=1
          WHERE recovery_id=? AND json_extract(snapshot_json,'$.supersededBy') IS NULL
          AND json_extract(snapshot_json,'$.resumedAt') IS NULL AND json_extract(snapshot_json,'$.dismissedAt') IS NULL`).run(snapshot.recoveryId, supersedes).changes;
        if (superseded !== 1) throw new Error("Pending recovery occurrence changed before boot reconciliation");
        db.prepare("UPDATE control_turns SET recovery_id=? WHERE recovery_id=? AND terminal_outcome IS NULL").run(snapshot.recoveryId, supersedes);
      }
      for (const agentId of [...snapshot.interruptedManagers, ...snapshot.interruptedWorkers]) db.prepare("UPDATE control_turns SET recovery_id=? WHERE agent_id=? AND terminal_outcome IS NULL AND recovery_id IS NULL").run(snapshot.recoveryId, agentId);
    }).immediate();
  });
}

/** Claim and close only the captured turns in one transaction, before any external dispatch. */
export async function claimRecoveryOccurrence(dataDir: string, action: "resume" | "dismiss", at: string): Promise<RecoverySnapshot | null> {
  return withEnvironmentDatabase(dataDir, async db => db.transaction(() => {
    const row = db.prepare("SELECT recovery_id,snapshot_json FROM control_recovery WHERE json_extract(snapshot_json,'$.supersededBy') IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 1").get() as { recovery_id: string; snapshot_json: string } | undefined;
    if (!row) return null;
    const snapshot: RecoverySnapshot = JSON.parse(row.snapshot_json);
    if (snapshot.resumedAt || snapshot.dismissedAt) return null;
    const decided = { ...snapshot, [action === "resume" ? "resumedAt" : "dismissedAt"]: at };
    db.prepare("UPDATE control_recovery SET snapshot_json=?,decision_applied=? WHERE recovery_id=?").run(JSON.stringify(decided), action === "resume" ? 1 : 0, row.recovery_id);
    db.prepare("UPDATE control_turns SET terminal_outcome='reconciled',terminal_at=? WHERE recovery_id=? AND terminal_outcome IS NULL").run(at, row.recovery_id);
    return decided;
  }).immediate());
}

export async function applyRecoveryDismissal(dataDir: string, snapshot: RecoverySnapshot, apply: (workerIds: readonly string[]) => Promise<void>): Promise<void> {
  const pending = await withEnvironmentDatabase(dataDir, async db => Boolean(db.prepare("SELECT 1 FROM control_recovery WHERE recovery_id=? AND decision_applied=0").get(snapshot.recoveryId)));
  if (!pending) return;
  await apply(snapshot.interruptedWorkers);
  await withEnvironmentDatabase(dataDir, async db => { db.prepare("UPDATE control_recovery SET decision_applied=1 WHERE recovery_id=?").run(snapshot.recoveryId); });
}

export function appendRecoveryDeliveryContent(runtime: Pick<SwarmAgentRuntime, "appendCustomEntry"> | undefined, file: string | undefined, input: { deliveryId: string; fromAgentId: string; targetAgentId: string; message: string; turnId?: string; assignmentId?: string; at: string }): RecoveryContentRef {
  if (!runtime || !file) throw new Error("Delivery requires a canonical writer");
  const entryId = runtime.appendCustomEntry("swarm_recovery_delivery", input);
  if (!entryId) throw new Error("Delivery content was not persisted");
  return { file, entryId };
}

/** Repairs canonical append -> DB failure using bounded offset witnesses in the existing source table. */
async function reconcileRecoveryContent(database: Database, target: RecoveryTarget): Promise<void> {
  for (const file of target.canonicalFiles ?? []) {
    let info;
    try { info = await stat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const generation = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    const sourceKey = `recovery-content:${target.sessionAgentId}:${file}`;
    const prior = database.prepare("SELECT file_generation,byte_offset FROM mirror_sources WHERE source_key=?").get(sourceKey) as { file_generation: string; byte_offset: number } | undefined;
    const offset = prior?.file_generation === generation && prior.byte_offset <= info.size ? prior.byte_offset : 0;
    if (offset === info.size) continue;
    const facts: RecoveryFact[] = [];
    let end = offset;
    let pending = "";
    for await (const chunk of createReadStream(file, { encoding: "utf8", start: offset, end: info.size - 1 })) {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        end += Buffer.byteLength(line) + 1;
        if (!line.trim()) continue;
        let entry: { id?: string; customType?: string; data?: Parameters<typeof appendRecoveryDeliveryContent>[2] };
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.customType !== "swarm_recovery_delivery" || !entry.id || !entry.data?.deliveryId) continue;
        const data = entry.data;
        if (target.actorIds && !target.actorIds.includes(data.targetAgentId)) continue;
        facts.push({ t: "delivery_pending", deliveryId: data.deliveryId, from: data.fromAgentId, to: data.targetAgentId, at: data.at, contentRef: { file, entryId: entry.id }, ...(data.turnId ? { turnId: data.turnId } : {}), ...(data.assignmentId ? { assignmentId: data.assignmentId } : {}) });
      }
    }
    database.transaction(() => {
      for (const fact of facts) applyFact(database, target.sessionAgentId, fact);
      database.prepare("INSERT INTO mirror_sources (source_key,file_generation,byte_offset,updated_at) VALUES (?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET file_generation=excluded.file_generation,byte_offset=excluded.byte_offset,updated_at=excluded.updated_at").run(sourceKey, generation, Math.min(end, info.size), Date.now());
    }).immediate();
  }
}
