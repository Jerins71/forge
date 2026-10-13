import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type StartedServer } from "../server.js";
import { HistoryRecallIndexStore } from "../swarm/history-recall/index-store.js";
import { getHistoryRecallIndexPath } from "../swarm/storage/data-paths.js";
import { createTempConfig, type TempConfigHandle } from "../test-support/temp-config.js";

const ROWS = 200_000;
let server: StartedServer | undefined;
let temp: TempConfigHandle | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
  await temp?.cleanup();
  temp = undefined;
});

/** A large transcript indexed as if by an earlier run, as in a copied data directory. */
async function seedLargeIndex(dataDir: string): Promise<void> {
  const path = join(dataDir, "previous-run", "session.jsonl");
  await mkdir(dirname(path), { recursive: true });
  const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon".split(" ");
  const timestamp = new Date().toISOString();
  const lines = [JSON.stringify({ type: "session", id: "previous", version: 3 })];
  for (let row = 0; row < ROWS; row++) {
    const content = Array.from({ length: 30 }, (_, word) => `${words[(row * 7 + word * 13) % words.length]}${(row * 31 + word) % 997}`).join(" ");
    lines.push(JSON.stringify({ type: "message", id: `m${row}`, timestamp, message: { role: row % 2 ? "assistant" : "user", content } }));
  }
  await writeFile(path, `${lines.join("\n")}\n`);
  const store = await HistoryRecallIndexStore.open(getHistoryRecallIndexPath(dataDir), async () => Database as never);
  const source = { sourceId: "previous:previous", profileId: "previous", sessionAgentId: "previous", actorAgentId: "previous",
    path, archived: false, sessionLabel: "Previous", actorLabel: "Previous" };
  while (store.ingestSource(source, 64 * 1024 * 1024).pending);
  store.close();
}

function indexedRows(dataDir: string): number {
  const database = new Database(getHistoryRecallIndexPath(dataDir), { readonly: true });
  try {
    return (database.prepare("SELECT count(*) AS n FROM entries").get() as { n: number }).n;
  } finally {
    database.close();
  }
}

describe("backend startup with a large history index to clean up", () => {
  it("serves health in under a second throughout history index work", async () => {
    temp = await createTempConfig();
    const { dataDir } = temp.config.paths;
    await seedLargeIndex(dataDir);
    expect(indexedRows(dataDir)).toBe(ROWS);

    // The registry has no session for the indexed source, so startup must remove all of it.
    const booting = performance.now();
    server = await startServer({
      config: temp.config,
      environmentIdentity: { installationStateDir: join(dataDir, ".test-installation") },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const readyMs = performance.now() - booting;
    const base = `http://${server.host}:${server.port}`;

    const latencies: number[] = [];
    const remaining: number[] = [];
    const deadline = performance.now() + 120_000;
    while (performance.now() < deadline) {
      const started = performance.now();
      const response = await fetch(`${base}/api/health`);
      expect(response.status).toBe(200);
      await response.text();
      latencies.push(performance.now() - started);
      remaining.push(indexedRows(dataDir));
      if (remaining.at(-1) === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const during = remaining.filter((rows) => rows > 0 && rows < ROWS).length;
    console.log(JSON.stringify({ readyMs: Math.round(readyMs), polls: latencies.length, pollsDuringCleanup: during,
      maxHealthMs: Math.round(Math.max(...latencies)), finalRows: remaining.at(-1) }));
    expect(readyMs).toBeLessThan(15_000);
    expect(remaining.at(-1)).toBe(0);
    expect(during).toBeGreaterThan(10);
    expect(Math.max(...latencies)).toBeLessThan(1_000);
  }, 240_000);
});
