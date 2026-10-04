import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CompactionSettingsService } from "../compaction-settings-service.js";
import { getCompactionSettingsPath } from "../data-paths.js";

function createAvailabilityMap(overrides: Record<string, boolean> = {}): Map<string, boolean> {
  return new Map<string, boolean>([
    ["openai-codex", true],
    ["anthropic", true],
    ["claude-sdk", true],
    ["xai", true],
    ...Object.entries(overrides),
  ]);
}

describe("CompactionSettingsService", () => {
  it("persists validated updates and merges partial patches", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "compaction-settings-update-"));
    const now = new Date("2026-06-24T12:00:00.000Z");
    const service = new CompactionSettingsService({
      dataDir,
      now: () => now,
      getProviderAvailability: async () => createAvailabilityMap(),
    });

    await service.load();
    const result = await service.update({ reasoningLevel: "medium", timeoutMs: 360_000 });

    expect(result.settings).toEqual({
      model: { provider: "openai-codex", modelId: "gpt-5.5" },
      reasoningLevel: "medium",
      timeoutMs: 360_000,
      updatedAt: "2026-06-24T12:00:00.000Z",
    });
    expect(result.availability).toEqual({
      providerConfigured: true,
      modelValid: true,
      reasoningSupported: true,
    });

    const stored = JSON.parse(await readFile(getCompactionSettingsPath(dataDir), "utf8")) as Record<string, unknown>;
    expect(stored).toEqual({
      version: 1,
      model: { provider: "openai-codex", modelId: "gpt-5.5" },
      reasoningLevel: "medium",
      timeoutMs: 360_000,
      updatedAt: "2026-06-24T12:00:00.000Z",
    });
  });
});

it("loads retired Terra compaction as Sol low and preserves it after saving and restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "compaction-terra-retirement-"));
  const settingsPath = getCompactionSettingsPath(dataDir);
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({
    version: 1,
    model: { provider: "openai-codex", modelId: "gpt-5.6-terra" },
    reasoningLevel: "ultra",
    timeoutMs: 120_000,
  }));
  const options = { dataDir, getProviderAvailability: async () => createAvailabilityMap() };
  const service = new CompactionSettingsService(options);
  await service.load();
  expect(service.getSettings()).toMatchObject({
    model: { provider: "openai-codex", modelId: "gpt-6-sol" }, reasoningLevel: "low",
  });
  await service.update({ timeoutMs: 180_000 });
  const restarted = new CompactionSettingsService(options);
  await restarted.load();
  expect(restarted.getSettings()).toEqual(service.getSettings());
});
