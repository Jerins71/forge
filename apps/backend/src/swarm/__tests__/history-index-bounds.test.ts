import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistorySearchService } from "../history-recall/history-search-service.js";
import { getHistoryRecallIndexPath, getSessionFilePath, getWorkerSessionFilePath } from "../storage/data-paths.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "../types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const roots: string[] = [];
const services: HistorySearchService[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const profiles = [{ profileId: "project", displayName: "Project", defaultSessionAgentId: "session" }] as ManagerProfile[];

function agent(agentId: string, role: "manager" | "worker", activeAt: string, managerId = agentId): AgentDescriptor {
  return { agentId, managerId, role, profileId: "project", displayName: agentId, sessionFile: "ignored", status: "idle", cwd: "/tmp",
    model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "medium" }, createdAt: activeAt, updatedAt: activeAt,
    ...(role === "manager" ? { lastUserMessageAt: activeAt } : {}) } as AgentDescriptor;
}

function transcript(header: string, prefix: string, rows: number, timestamp: string): string {
  const lines = [JSON.stringify({ type: "session", id: header, version: 3 })];
  for (let index = 0; index < rows; index++) {
    lines.push(JSON.stringify({ type: "message", id: `${prefix}-${index}`, timestamp,
      message: { role: index % 2 ? "assistant" : "user", content: `${prefix} row ${index} ${index === 7 ? `${prefix}needle` : "filler words"}` } }));
  }
  return `${lines.join("\n")}\n`;
}

function service(dataDir: string, agents: AgentDescriptor[]): HistorySearchService {
  const created = new HistorySearchService({ config: { paths: { dataDir } } as Pick<SwarmConfig, "paths">,
    getAgent: (id) => agents.find((entry) => entry.agentId === id), listAgents: () => agents,
    listProfiles: () => profiles, loadDatabaseModule: async () => Database });
  services.push(created);
  return created;
}

async function indexed(dataDir: string, agents: AgentDescriptor[]): Promise<HistorySearchService> {
  const created = service(dataDir, agents);
  await created.startFromRegistry();
  const deadline = performance.now() + 20_000;
  while ((await created.getIndexStatus()).activity !== "idle") {
    if (performance.now() > deadline) throw new Error("History index did not become idle");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return created;
}

function entryIds(dataDir: string): Record<string, number[]> {
  const database = new Database(getHistoryRecallIndexPath(dataDir), { readonly: true });
  try {
    const rows = database.prepare("SELECT source_id, id FROM entries ORDER BY id").all() as Array<{ source_id: string; id: number }>;
    const bySource: Record<string, number[]> = {};
    for (const row of rows) (bySource[row.source_id] ??= []).push(row.id);
    return bySource;
  } finally {
    database.close();
  }
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forge-history-bounds-"));
  roots.push(root);
  return root;
}

describe("history index after the data directory is copied", () => {
  it("keeps rows whose transcript content is unchanged and re-indexes only replaced transcripts", async () => {
    const now = new Date().toISOString();
    const agents = [agent("session", "manager", now), agent("worker", "worker", now, "session")];
    const original = join(await tempRoot(), "original");
    const workerPath = getWorkerSessionFilePath(original, "project", "session", "worker");
    await mkdir(dirname(workerPath), { recursive: true });
    await writeFile(getSessionFilePath(original, "project", "session"), transcript("session-header", "session", 40, now));
    await writeFile(workerPath, transcript("worker-header", "worker", 40, now));
    await (await indexed(original, agents)).dispose();
    const before = entryIds(original);
    expect(before["session:session"]?.length).toBeGreaterThan(0);

    // A copy gives every transcript a new path and inode; one transcript is then replaced.
    const copy = join(dirname(original), "copy");
    await cp(original, copy, { recursive: true });
    await writeFile(getWorkerSessionFilePath(copy, "project", "session", "worker"), transcript("replaced-header", "replaced", 40, now));

    const copied = await indexed(copy, agents);
    // Search catches its scope up before answering, so both sources have been checked.
    const hit = (await copied.search("session", { query: "sessionneedle" })).results[0];
    expect(hit?.ref.entryId).toBe("session-7");
    expect((await copied.read("session", { ref: hit!.ref })).entry.text).toContain("sessionneedle");
    expect((await copied.search("session", { query: "workerneedle" })).results).toEqual([]);
    expect((await copied.search("session", { query: "replacedneedle" })).results.map((result) => result.ref.entryId)).toEqual(["replaced-7"]);
    await copied.dispose();
    const after = entryIds(copy);
    expect(after["session:session"]).toEqual(before["session:session"]);
    expect(Math.min(...after["session:worker"]!)).toBeGreaterThan(Math.max(...before["session:worker"]!));
  });
});

describe("history recall window", () => {
  it("indexes and returns a 29-day-old source but neither indexes nor returns a 31-day-old one, and prunes it as it ages", async () => {
    const started = Date.now();
    const at = (days: number) => new Date(started - days * DAY_MS).toISOString();
    const agents = [agent("recent", "manager", at(29)), agent("old", "manager", at(31))];
    const dataDir = await tempRoot();
    await mkdir(dirname(getSessionFilePath(dataDir, "project", "recent")), { recursive: true });
    await mkdir(dirname(getSessionFilePath(dataDir, "project", "old")), { recursive: true });
    await writeFile(getSessionFilePath(dataDir, "project", "recent"), transcript("recent-header", "recent", 20, at(29)));
    await writeFile(getSessionFilePath(dataDir, "project", "old"), transcript("old-header", "old", 20, at(31)));

    const history = await indexed(dataDir, agents);
    const recent = await history.search("recent", { query: "recentneedle", scope: "project" });
    expect(recent.results.map((result) => result.ref.entryId)).toEqual(["recent-7"]);
    expect((await history.read("recent", { ref: recent.results[0]!.ref })).entry.text).toContain("recentneedle");
    expect((await history.search("recent", { query: "oldneedle", scope: "project" })).results).toEqual([]);
    expect((await history.search("recent", { query: "oldneedle", scope: "project", mode: "literal" })).results).toEqual([]);
    await expect(history.items("recent", { sessionAgentId: "old" })).resolves.toMatchObject({ results: [] });
    await history.dispose();
    expect(Object.keys(entryIds(dataDir))).toEqual(["recent:recent"]);

    // Two days later the 29-day-old source is 31 days old: it leaves recall and the index.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(started + 2 * DAY_MS);
    const later = await indexed(dataDir, agents);
    expect((await later.search("recent", { query: "recentneedle", scope: "project" })).results).toEqual([]);
    await expect(later.read("recent", { ref: recent.results[0]!.ref })).rejects.toThrow();
    await later.dispose();
    expect(entryIds(dataDir)).toEqual({});
  });
});
