import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { getSharedConfigDir } from "../../data-paths.js";
import {
  formatWorkerPresetBlock,
  getWorkerPresetsPath,
  mergeWorkerPresets,
  migrateDelegationRostersToWorkerPresets,
  normalizeWorkerPresetSettings,
  readWorkerPresetSettings,
  saveWorkerPresetSettings,
} from "../worker-presets.js";

const anyModel = () => true;

async function dataDirWith(rosters: unknown, store?: unknown): Promise<{ dataDir: string; storeFile: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-presets-"));
  const storeFile = join(dataDir, "swarm", "agents.json");
  await mkdir(getSharedConfigDir(dataDir), { recursive: true });
  await mkdir(dirname(storeFile), { recursive: true });
  if (rosters !== undefined) {
    await writeFile(join(getSharedConfigDir(dataDir), "delegation-rosters.json"), JSON.stringify(rosters));
  }
  if (store !== undefined) await writeFile(storeFile, JSON.stringify(store));
  return { dataDir, storeFile };
}

function route(routeId: string, extra: Record<string, unknown> = {}) {
  return {
    routeId,
    label: routeId,
    provider: "openai-codex",
    modelId: "gpt-5.5",
    reasoningLevel: "high",
    useWhen: "Bounded implementation work. Not for reviews.",
    behaviorMode: "general",
    availabilityFallback: { provider: "anthropic", modelId: "x", reasoningLevel: "low" },
    ...extra,
  };
}

it("migrates the roster most profiles reference first, then appends other rosters' routes, de-duplicated by name", async () => {
  const { dataDir, storeFile } = await dataDirWith(
    {
      version: 1,
      defaultRosterId: "balanced",
      rosters: [
        { rosterId: "balanced", revision: 3, routes: [route("builder"), route("deep", { modelId: "gpt-6-sol", reasoningLevel: "xhigh", useWhen: "Hard design" })] },
        { rosterId: "mine", revision: 1, routes: [route("quick", { reasoningLevel: "low", useWhen: "" }), route("builder", { modelId: "other" }), { routeId: "Bad Name" }, "junk"] },
      ],
    },
    { agents: [], profiles: [{ profileId: "a", defaultDelegationRosterId: "mine" }, { profileId: "b", defaultDelegationRosterId: "mine" }, { profileId: "c", defaultDelegationRosterId: "balanced" }] },
  );

  expect(await migrateDelegationRostersToWorkerPresets(dataDir, storeFile)).toBe(true);

  const written = JSON.parse(await readFile(getWorkerPresetsPath(dataDir), "utf8"));
  expect(written).toEqual({
    version: 2,
    presets: [
      { name: "quick", provider: "openai-codex", modelId: "gpt-5.5", reasoningLevel: "low" },
      { name: "builder", provider: "openai-codex", modelId: "other", reasoningLevel: "high", note: "Bounded implementation work." },
      { name: "deep", provider: "openai-codex", modelId: "gpt-6-sol", reasoningLevel: "xhigh", note: "Hard design" },
    ],
  });
  // One-time: an existing presets file is never overwritten.
  expect(await migrateDelegationRostersToWorkerPresets(dataDir, storeFile)).toBe(false);
});

it("falls back to defaultRosterId when no profile references a roster, and writes an empty list without a roster file", async () => {
  const withDefault = await dataDirWith({ defaultRosterId: "second", rosters: [{ rosterId: "first", routes: [route("one")] }, { rosterId: "second", routes: [route("two")] }] });
  await migrateDelegationRostersToWorkerPresets(withDefault.dataDir, withDefault.storeFile);
  expect((await readWorkerPresetSettings(withDefault.dataDir)).presets.map((preset) => preset.name)).toEqual(["two", "one"]);

  for (const rosters of [undefined, "not json object", { rosters: 7 }]) {
    const empty = await dataDirWith(rosters);
    await migrateDelegationRostersToWorkerPresets(empty.dataDir, empty.storeFile);
    expect(await readWorkerPresetSettings(empty.dataDir)).toEqual({ version: 2, presets: [] });
  }
});

it("validates saved presets: slug names, unique names, known models", async () => {
  const { dataDir } = await dataDirWith(undefined);
  const preset = { name: "builder", provider: "openai-codex", modelId: "gpt-5.5", reasoningLevel: "high" };
  await saveWorkerPresetSettings(dataDir, { version: 2, presets: [{ ...preset, note: "  Quick work  " }] }, anyModel);
  expect(await readWorkerPresetSettings(dataDir)).toEqual({ version: 2, presets: [{ ...preset, note: "Quick work" }] });

  expect(() => normalizeWorkerPresetSettings({ version: 2, presets: [preset, preset] }, anyModel)).toThrow(/Duplicate preset name: builder/);
  expect(() => normalizeWorkerPresetSettings({ version: 2, presets: [{ ...preset, name: "Bad Name" }] }, anyModel)).toThrow(/name/);
  expect(() => normalizeWorkerPresetSettings({ version: 2, presets: [{ ...preset, reasoningLevel: "huge" }] }, anyModel)).toThrow(/reasoningLevel/);
  expect(() => normalizeWorkerPresetSettings({ version: 2, presets: [preset] }, () => false)).toThrow(/Unknown model openai-codex\/gpt-5.5/);
  expect(() => normalizeWorkerPresetSettings({ version: 1, presets: [] }, anyModel)).toThrow(/version/);
});

it("lets a specialist file win a name collision and carry its instructions", () => {
  const merged = mergeWorkerPresets(
    [
      { name: "builder", provider: "openai-codex", modelId: "gpt-5.5", reasoningLevel: "high" },
      { name: "reviewer", provider: "openai-codex", modelId: "gpt-5.5", reasoningLevel: "low", note: "global" },
    ],
    [{ name: "reviewer", provider: "anthropic", modelId: "claude-opus-5-5", reasoningLevel: "high", note: "file", instructions: "Review carefully." }],
  );
  expect(merged).toEqual([
    { name: "builder", provider: "openai-codex", modelId: "gpt-5.5", reasoningLevel: "high" },
    { name: "reviewer", provider: "anthropic", modelId: "claude-opus-5-5", reasoningLevel: "high", note: "file", instructions: "Review carefully." },
  ]);
});

it("renders the preset list for the manager system prompt", () => {
  expect(formatWorkerPresetBlock([
    { name: "builder", provider: "openai-codex", modelId: "gpt-5.5", reasoningLevel: "high", note: "Bounded implementation work." },
    { name: "quick", provider: "anthropic", modelId: "claude-haiku-5-5", reasoningLevel: "low" },
  ])).toBe([
    "Worker presets (pass the name as preset to spawn_agent; omit it to use your own model):",
    "- builder: openai-codex/gpt-5.5, high. Bounded implementation work.",
    "- quick: anthropic/claude-haiku-5-5, low.",
  ].join("\n"));
  expect(formatWorkerPresetBlock([])).toBe("No worker presets are configured; spawn_agent uses your own model.");
});
