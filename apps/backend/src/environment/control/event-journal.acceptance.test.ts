// The event journal stays bounded without making every commit pay for pruning.
// Ways this can fail: a write at the cap prunes again on every commit (the hot path then scans the
// whole journal per write); a prune removes more than the retained window; the journal grows past its
// count or byte cap; pruned history is still offered for replay; expired rows are never removed.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfiguredSqliteDatabaseConstructor } from "../../sqlite-database-loader.js";
import { session } from "../../ws/rpc/__tests__/fixtures.js";
import { createEventSink } from "./event-sink.js";
import { migrateControlDatabase } from "./migrations.js";

const DAY = 86_400_000;

async function journal(rows: number, options: { bytesPerRow?: number; createdAt?: number } = {}) {
  const Constructor = await loadConfiguredSqliteDatabaseConstructor();
  const database = new Constructor(":memory:");
  migrateControlDatabase(database, { environmentId: randomUUID(), streamEpoch: randomUUID() });
  const insert = database.prepare("INSERT INTO events (event_id,topic,session_id,event_type,payload_json,payload_bytes,created_at) VALUES (?,'shell',NULL,'project.remove','{}',?,?)");
  database.transaction(() => { for (let i = 0; i < rows; i++) insert.run(randomUUID(), options.bytesPerRow ?? 2, options.createdAt ?? 0); })();
  const high = rows;
  database.prepare("UPDATE environment_meta SET high_water_sequence=? WHERE singleton=1").run(high);
  let now = options.createdAt ?? 0;
  const sink = createEventSink(database, () => now, randomUUID);
  const write = () => sink.transaction(tx => { sink.append(tx, { topic: "shell", sessionId: "session", event: { type: "session.upsert", session: session() } }); });
  const count = () => (database.prepare("SELECT COUNT(*) count FROM events").get() as { count: number }).count;
  const retainedAfter = () => (database.prepare("SELECT retained_after_sequence r FROM environment_meta").get() as { r: number }).r;
  return { database, sink, write, count, retainedAfter, advance: (ms: number) => { now += ms; } };
}

describe("control event journal retention", () => {
  it("prunes once at the count cap, down to a low-water mark, and later writes do not prune again", async () => {
    const j = await journal(100_000);
    j.write();
    const afterPrune = j.count();
    expect(afterPrune).toBeLessThanOrEqual(90_000);
    expect(afterPrune).toBeGreaterThanOrEqual(80_000);
    // Replay never claims rows that were removed.
    const oldest = (j.database.prepare("SELECT MIN(sequence) s FROM events").get() as { s: number }).s;
    expect(j.retainedAfter()).toBe(oldest - 1);
    const started = performance.now();
    for (let i = 0; i < 2_000; i++) j.write();
    const perWrite = (performance.now() - started) / 2_000;
    expect(j.count()).toBe(afterPrune + 2_000);
    // A full-journal scan per commit costs tens of milliseconds at this size; a plain append does not.
    expect(perWrite).toBeLessThan(2);
  });

  it("never lets the journal exceed its count cap", async () => {
    const j = await journal(99_990);
    for (let i = 0; i < 20; i++) j.write();
    expect(j.count()).toBeLessThanOrEqual(100_000);
  });

  it("prunes to below the byte cap once, then appends without pruning", async () => {
    // 4,200 rows of 64 KiB are just over 256 MiB.
    const j = await journal(4_200, { bytesPerRow: 65_536 });
    j.write();
    const bytes = () => (j.database.prepare("SELECT SUM(payload_bytes) b FROM events").get() as { b: number }).b;
    expect(bytes()).toBeLessThanOrEqual(0.9 * 268_435_456);
    const afterPrune = j.count();
    for (let i = 0; i < 100; i++) j.write();
    expect(j.count()).toBe(afterPrune + 100);
  });

  it("removes rows older than seven days on the periodic prune", async () => {
    const j = await journal(500, { createdAt: Date.parse("2026-10-01T00:00:00.000Z") });
    j.write();
    expect(j.count()).toBe(501);
    j.advance(8 * DAY);
    j.write();
    expect(j.count()).toBe(1);
    expect(j.retainedAfter()).toBe(501);
  });
});
