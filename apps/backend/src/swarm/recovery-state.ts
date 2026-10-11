import type { Database } from "better-sqlite3";
import type { RecoverySnapshot } from "@forge/protocol/environment-v2";
import { withEnvironmentDatabase } from "../environment/control/database.js";

export type RecoveryInboundKind = "user" | "worker_report" | "schedule" | "agent_message" | "project_agent" | "system";
export type RecoveryTerminalOutcome = "agent_end" | "idle" | "error" | "recycled" | "abandoned" | "reconciled";
export interface RecoveryTarget { dataDir: string; profileId: string; sessionAgentId: string; canonicalFiles?: readonly string[]; actorIds?: readonly string[] }
export type RecoveryFact =
  | { t: "turn_dispatched"; turnId: string; agentId: string; role: "manager" | "worker"; inboundId?: string; kind: RecoveryInboundKind; at: string }
  | { t: "turn_terminal"; turnId: string; outcome: RecoveryTerminalOutcome; at: string }
  | { t: "turn_stalled"; turnId: string; agentId: string; tier: 1 | 2 | 3; at: string };
export interface RecoveryState {
  openTurns: Map<string, Extract<RecoveryFact, { t: "turn_dispatched" }> & { recoveryId?: string }>;
  terminalTurns: Map<string, Extract<RecoveryFact, { t: "turn_terminal" }>>;
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

  }
}

export async function recordRecoveryFact(target: RecoveryTarget, fact: RecoveryFact): Promise<void> {
  await withEnvironmentDatabase(target.dataDir, async database => { database.transaction(() => applyFact(database, target.sessionAgentId, fact)).immediate(); });
}
export async function readRecoveryState(target: RecoveryTarget): Promise<RecoveryState> {
  return withEnvironmentDatabase(target.dataDir, async database => {

    const state: RecoveryState = { openTurns: new Map(), terminalTurns: new Map() };
    const turns = database.prepare("SELECT * FROM control_turns WHERE session_id=? ORDER BY turn_id").all(target.sessionAgentId) as { turn_id: string; agent_id: string; role: "manager" | "worker"; inbound_kind: RecoveryInboundKind; inbound_id: string | null; dispatched_at: string | null; terminal_outcome: RecoveryTerminalOutcome | null; terminal_at: string | null; recovery_id: string | null }[];
    for (const turn of turns) {
      if (turn.terminal_outcome) state.terminalTurns.set(turn.turn_id, { t: "turn_terminal", turnId: turn.turn_id, outcome: turn.terminal_outcome, at: turn.terminal_at! });
      else if (turn.dispatched_at) state.openTurns.set(turn.turn_id, { t: "turn_dispatched", turnId: turn.turn_id, agentId: turn.agent_id, role: turn.role, kind: turn.inbound_kind, ...(turn.inbound_id ? { inboundId: turn.inbound_id } : {}), ...(turn.recovery_id ? { recoveryId: turn.recovery_id } : {}), at: turn.dispatched_at });
    }
    return state;
  });
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
