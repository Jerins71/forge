import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { loadConfiguredSqliteDatabaseConstructor } from "../../../sqlite-database-loader.js";
import { prepareControlDatabase } from "../database.js";
import { createEventSink } from "../event-sink.js";
import { loadState, rebuildLifecycleProjections } from "./store.js";

const roots: string[] = []; const databases: Database[] = [];
afterEach(async () => { for (const db of databases) if (db.open) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function database() {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-kernel-store-")); roots.push(root);
  const Constructor = await loadConfiguredSqliteDatabaseConstructor();
  const db = new Constructor(path.join(root, "control.sqlite")); databases.push(db);
  return db;
}
const now = 1_800_000_000_000;
function initialize(db: Database) { return prepareControlDatabase(db, { environmentId: "fixture", streamEpoch: "fixture" }); }

describe("retained lifecycle commit", () => {
  it("commits facts, projection and outbox together and publishes only after the commit", async () => {
    const db = await database(); await initialize(db);
    let id = 0; const sink = createEventSink(db, () => now, () => `id-${++id}`);
    const observed: boolean[] = [];
    sink.subscribe(() => observed.push(!db.inTransaction && loadState(db).runs.run.inputId === "input"));
    sink.transaction(tx => {
      db.prepare("INSERT INTO commands VALUES ('00000000-0000-4000-8000-000000000001','device','session.send','hash','{}','thread',?)").run(now);
      db.prepare("INSERT INTO command_receipts VALUES ('00000000-0000-4000-8000-000000000001','accepted',0,0,?)").run(JSON.stringify({ commandId: "00000000-0000-4000-8000-000000000001", method: "session.send", sessionId: "thread", state: "accepted", acceptedSequence: 0, updatedSequence: 0, acceptedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), inputId: "input", delivery: "pending", error: null }));
      sink.commitCommand(tx, { type: "thread.create", commandId: "00000000-0000-4000-8000-000000000001", now, threadId: "thread", role: "manager", projectId: "project" });
      sink.commitCommand(tx, { type: "run.submit", commandId: "00000000-0000-4000-8000-000000000001", now, threadId: "thread", runId: "run", inputId: "input", attemptId: "attempt", bindingId: "binding", delivery: "queue", input: { text: "fixture", artifactIds: [] } });
      sink.updateReceipt(tx, "00000000-0000-4000-8000-000000000001", {});
    });
    expect(observed).toEqual([true]);
    expect((db.prepare("SELECT kind FROM effects").all())).toEqual([{ kind: "runtime.acquire" }, { kind: "transcript.append" }]);
    expect(db.prepare("SELECT COUNT(*) n FROM lifecycle_events").get()).toEqual({ n: 4 });
    const before = loadState(db); sink.close(); db.close();
    const Constructor = await loadConfiguredSqliteDatabaseConstructor(); const reopened = new Constructor(db.name); databases.push(reopened); await initialize(reopened);
    rebuildLifecycleProjections(reopened);
    expect(loadState(reopened)).toEqual(before);
  });
  it("rolls back retained facts and outbox if a later write fails, without publishing", async () => {
    const db = await database(); await initialize(db);
    const sink = createEventSink(db, () => now, () => "id"); let published = 0; sink.subscribe(() => published++);
    expect(() => sink.transaction(tx => {
      sink.commitCommand(tx, { type: "thread.create", commandId: "00000000-0000-4000-8000-000000000001", now, threadId: "thread", role: "manager", projectId: "project" });
      throw new Error("fixture rollback");
    })).toThrow("fixture rollback");
    expect(loadState(db).threads).toEqual({}); expect(db.prepare("SELECT COUNT(*) n FROM lifecycle_events").get()).toEqual({ n: 0 }); expect(published).toBe(0);
  });
  it("retains lifecycle events independently of the bounded stream journal", async () => {
    const db = await database(); await initialize(db);
    const sink = createEventSink(db, () => now, () => "id");
    sink.transaction(tx => sink.commitCommand(tx, { type: "thread.create", commandId: "00000000-0000-4000-8000-000000000001", now, threadId: "thread", role: "manager", projectId: "project" }));
    db.prepare("DELETE FROM events").run(); rebuildLifecycleProjections(db);
    expect(loadState(db).threads.thread.threadId).toBe("thread");
  });
  it("rejects an incompatible database without creating tables or importing files", async () => {
    const db = await database(); db.exec("CREATE TABLE environment_meta (singleton INTEGER PRIMARY KEY, schema_version INTEGER); INSERT INTO environment_meta VALUES (1,2)");
    await expect(initialize(db)).rejects.toThrow(/incompatible/i);
    expect(db.prepare("SELECT schema_version FROM environment_meta").get()).toEqual({ schema_version: 2 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: "environment_meta" }]);
  });
});
