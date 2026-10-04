import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it, expect } from "vitest";
import { scanProfilesData } from "../stats/stats-scan.js";
import { scanTokenAnalyticsProfiles } from "../stats/token-analytics/token-analytics-scan.js";
import { StatsSourceCache } from "../stats/stats-source-cache.js";

it("merges native and Pi model usage, deduplicates fork copies, and survives cache restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-native-stats-"));
  const session = join(root, "profiles/p/sessions/s");
  const worker = join(session, "workers/w.jsonl");
  const write = async (path: string, entries: unknown[]) => writeFile(path, entries.map(x => JSON.stringify(x)).join("\n") + "\n");
  const native = (input: number, hour: number) => ({ type: "custom", customType: "swarm_native_usage", data: {
    version: 1, provider: "claude-native", nativeSessionId: "native", ownerAgentId: "w", counterId: "claude-fable-5-1", modelId: "claude-fable-5-1",
    reasoningLevel: "high", capturedAt: `2026-09-25T${hour}:00:00Z`, usage: { input, output: 5, cacheRead: 20, cacheWrite: 2 },
  } });
  try {
    await mkdir(join(session, "workers"), { recursive: true });
    await mkdir(join(root, "profiles/p/sessions/fork"), { recursive: true });
    await write(join(session, "session.jsonl"), []);
    await writeFile(join(session, "meta.json"), JSON.stringify({ workers: [{ id: "w", createdAt: "2026-09-25T09:00:00Z", terminatedAt: "2026-09-25T13:00:00Z" }] }));
    await write(join(root, "profiles/p/sessions/fork/session.jsonl"), [native(10, 10), native(15, 11)]);
    await write(worker, [native(10, 10), native(15, 11), native(15, 11), {
      type: "message", timestamp: "2026-09-25T12:00:00Z", message: { provider: "anthropic", model: "claude-fable-5-1",
        usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } },
    }]);
    const scan = await scanProfilesData(root, ["p"], "UTC");
    expect(scan.usageRecords.reduce((n, r) => n + r.total, 0)).toBe(53);
    expect(scan.workerRuns[0]?.billableTokens).toBe(31);
    expect(new Set(scan.usageRecords.map(r => r.modelId))).toEqual(new Set(["claude-fable-5-1"]));
    const cached = await new StatsSourceCache(root).read(worker);
    expect(cached.some(row => row.entry.customType === "swarm_native_usage")).toBe(true);
    expect(await scanProfilesData(root, ["p"], "UTC")).toEqual(scan);
    const analytics = await scanTokenAnalyticsProfiles({ getConfig: () => ({ paths: { dataDir: root } }), listUserProfiles: () => [{ profileId: "p" }] } as never);
    expect(new Set(analytics.events.map(e => `${e.provider}/${e.modelId}`))).toEqual(new Set(["anthropic/claude-fable-5-1"]));
    expect(analytics.events.reduce((n, e) => n + e.usage.total, 0)).toBe(53);
  } finally { await rm(root, { recursive: true, force: true }); }
});
