import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeEnvironmentValue, RecoverySnapshotSchema } from "@forge/protocol/environment-v2";
import { recordRecoveryFact, readRecoveryState, readRecoveryOccurrence, saveRecoveryOccurrence, claimRecoveryDelivery, claimRecoveryOccurrence } from "../../swarm/recovery-state.js";
import { getSessionTurnLedgerPath } from "../../swarm/storage/data-paths.js";
import { withEnvironmentDatabase } from "./database.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const dataDir = await mkdtemp(join(tmpdir(), "forge-recovery-db-")); roots.push(dataDir); return { dataDir, profileId: "project", sessionAgentId: "manager" }; }
const at = "2026-10-09T00:00:00.000Z";
describe("private recovery authority", () => {
  it("imports all legacy fact categories idempotently without changing files or copying report bodies", async () => {
    const target = await fixture(); const source = getSessionTurnLedgerPath(target.dataDir, target.profileId, target.sessionAgentId); await mkdir(dirname(source), { recursive: true });
    const facts = [{ t: "turn_dispatched", turnId: "turn", agentId: "worker", role: "worker", kind: "schedule", at }, { t: "turn_stalled", turnId: "turn", agentId: "worker", tier: 2, at }, { t: "delivery_pending", deliveryId: "result", turnId: "turn", from: "worker", to: "manager", assignmentId: "assignment", message: "private fixture body", at }, { t: "delivery_pending", deliveryId: "acked", from: "worker", to: "manager", message: "private acked body", at }, { t: "delivery_acked", deliveryId: "acked", at }, { t: "turn_terminal", turnId: "closed", outcome: "agent_end", at }, { t: "recovery_receipt", receipt: "turn_interrupted", turnId: "turn", agentId: "worker", at }];
    const raw = facts.map(fact => JSON.stringify(fact)).join("\n") + "\n"; await writeFile(source, raw);
    const first = await readRecoveryState(target); const second = await readRecoveryState(target);
    expect([...first.openTurns.keys()]).toEqual(["turn"]); expect([...second.pendingDeliveries.keys()]).toEqual(["result"]); expect(second.ackedDeliveries.has("acked")).toBe(true); expect(second.terminalTurns.has("closed")).toBe(true);
    expect(await readFile(source, "utf8")).toBe(raw);
    await withEnvironmentDatabase(target.dataDir, async db => { const rows = db.prepare("SELECT * FROM control_deliveries").all(); expect(JSON.stringify(rows)).not.toContain("private fixture body"); expect(rows).toHaveLength(2); });
  });
  it("persists occurrence identity and result dispatch claims through process restart; unknown dispatch remains pending", async () => {
    const target = await fixture(); const recoveryId = randomUUID();
    await recordRecoveryFact(target, { t: "turn_dispatched", turnId: "schedule-turn", agentId: "manager", role: "manager", kind: "schedule", at });
    await recordRecoveryFact(target, { t: "delivery_pending", deliveryId: "result", from: "worker", to: "manager", assignmentId: "assignment", contentRef: { file: join(target.dataDir, "canonical.jsonl"), entryId: "result-entry" }, at });
    await saveRecoveryOccurrence(target.dataDir, { recoveryId, bootId: recoveryId, createdAt: at, interruptedManagers: ["manager"], interruptedWorkers: [], undeliveredReports: [{ deliveryId: "result", fromAgentId: "worker", toAgentId: "manager", assignmentId: "assignment" }] });
    expect((await readRecoveryOccurrence(target.dataDir))?.bootId).toBe(recoveryId);
    expect((await claimRecoveryOccurrence(target.dataDir, "resume", at))?.recoveryId).toBe(recoveryId);
    expect(await claimRecoveryOccurrence(target.dataDir, "resume", at)).toBeNull();
    expect((await readRecoveryState(target)).openTurns.has("schedule-turn")).toBe(false);
    expect(await claimRecoveryDelivery(target, "result")).toBe(true); expect(await claimRecoveryDelivery(target, "result")).toBe(false);
    expect((await readRecoveryState(target)).pendingDeliveries.get("result")?.state).toBe("dispatching");
    await recordRecoveryFact(target, { t: "turn_terminal", turnId: "schedule-turn", outcome: "abandoned", at }); expect((await readRecoveryState(target)).openTurns.size).toBe(0);
  });
  it("imports and restores composed report IDs for a maximum-length worker ID", async () => {
    const target = await fixture();
    const workerId = "worker-" + "w".repeat(121);
    const turnId = randomUUID();
    const deliveryId = `worker-result:${workerId}:${turnId}:${randomUUID()}`;
    const assignmentId = `assignment:${workerId}:${randomUUID()}`;
    const source = getSessionTurnLedgerPath(target.dataDir, target.profileId, target.sessionAgentId);
    await mkdir(dirname(source), { recursive: true });
    const raw = JSON.stringify({ t: "turn_dispatched", turnId, agentId: workerId, role: "worker", kind: "agent_message", at }) + "\n"
      + JSON.stringify({ t: "delivery_pending", deliveryId, turnId, from: workerId, to: "manager", assignmentId, message: "private long-ID fixture body", at }) + "\n";
    await writeFile(source, raw);
    const imported = await readRecoveryState(target);
    expect(workerId).toHaveLength(128);
    expect(deliveryId.length).toBeGreaterThan(128);
    expect(assignmentId.length).toBeGreaterThan(128);
    expect(imported.pendingDeliveries.get(deliveryId)?.assignmentId).toBe(assignmentId);
    const recoveryId = randomUUID();
    const snapshot = decodeEnvironmentValue(RecoverySnapshotSchema, { recoveryId, bootId: recoveryId, createdAt: at, interruptedManagers: [], interruptedWorkers: [workerId], undeliveredReports: [{ deliveryId, fromAgentId: workerId, toAgentId: "manager", assignmentId }] });
    expect(snapshot).toBeDefined();
    await saveRecoveryOccurrence(target.dataDir, snapshot!);
    expect(decodeEnvironmentValue(RecoverySnapshotSchema, await readRecoveryOccurrence(target.dataDir))).toEqual(snapshot);
    expect((await readRecoveryState(target)).pendingDeliveries.get(deliveryId)?.assignmentId).toBe(assignmentId);
    expect(await readFile(source, "utf8")).toBe(raw);
    await withEnvironmentDatabase(target.dataDir, async db => {
      expect(db.prepare("SELECT count(*) n FROM control_deliveries").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT count(*) n FROM recovery_imports").get()).toEqual({ n: 1 });
      expect(JSON.stringify(db.prepare("SELECT * FROM control_deliveries").all())).not.toContain("private long-ID fixture body");
    });
  });
  it("gates a partial recovery import when a typed fact is malformed", async () => {
    const target = await fixture(); const source = getSessionTurnLedgerPath(target.dataDir, target.profileId, target.sessionAgentId);
    await mkdir(dirname(source), { recursive: true });
    const raw = JSON.stringify({ t: "turn_dispatched", turnId: "valid", agentId: "manager", role: "manager", kind: "schedule", at }) + "\n" + JSON.stringify({ t: "turn_dispatched", turnId: "invalid", at }) + "\n";
    await writeFile(source, raw);
    await expect(readRecoveryState(target)).rejects.toThrow();
    expect(await readFile(source, "utf8")).toBe(raw);
    await withEnvironmentDatabase(target.dataDir, async db => {
      expect(db.prepare("SELECT count(*) n FROM recovery_imports").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) n FROM control_turns").get()).toEqual({ n: 0 });
    });
  });

});
