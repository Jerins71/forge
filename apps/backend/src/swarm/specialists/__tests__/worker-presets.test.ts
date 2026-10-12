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

const PLAN_CONSULTANT = {
  name: "plan-consultant",
  provider: "codex-native",
  modelId: "gpt-6-astra",
  reasoningLevel: "xhigh",
  note: "Consult on a specific consequential decision or critique a proposed plan.",
};

async function migratedPresets(rosters: unknown, store?: unknown) {
  const { dataDir, storeFile } = await dataDirWith(rosters, store);
  expect(await migrateDelegationRostersToWorkerPresets(dataDir, storeFile)).toBe(true);
  return JSON.parse(await readFile(getWorkerPresetsPath(dataDir), "utf8"));
}

// Routes exactly as Forge shipped them in the Balanced and Default rosters.
const shippedBalanced = {
  rosterId: "balanced",
  name: "Balanced",
  routes: [
    route("quick-scout", { provider: "openrouter", modelId: "meta/muse-spark-1.3", useWhen: "Use for a small, well-specified implementation change with narrow scope and clear acceptance criteria when lower cost or latency matters." }),
    route("fast-builder", { provider: "xai", modelId: "grok-4.6", useWhen: "Well-specified implementation and focused fixes with clear acceptance." }),
    route("planner", { useWhen: "Use for decomposition, implementation planning, sequencing, scope and risk analysis, and decision preparation before substantial work." }),
    route("research-analyst", { useWhen: "Use for source-backed investigation, documentation lookup, fact-checking, and focused technical analysis." }),
    route("independent-critic", { useWhen: "Use for an independent review of a proposed or completed change when correctness, regressions, API/design quality, security, or maintainability could affect acceptance." }),
    route("deep-reasoner", { useWhen: "Use only when a normal specialist lacks a credible path: architecturally ambiguous, high-risk, cross-cutting work, or difficult synthesis with evidence that stronger reasoning is justified." }),
  ],
};
const shippedDefault = {
  rosterId: "default",
  name: "Default",
  routes: [
    route("plan-consultant", { provider: "openai-codex", modelId: "gpt-6-astra", reasoningLevel: "xhigh", useWhen: "Consult on a specific consequential decision or critique a proposed plan. Supply existing findings and the unresolved question; retain implementation and integration with the manager." }),
    route("independent-reviewer", { provider: "anthropic", modelId: "claude-fable-5-1", reasoningLevel: "low", useWhen: "Request one focused review of a major feature or concrete acceptance risk. Return actionable findings and evidence for the manager to resolve." }),
    route("researcher", { provider: "xai", modelId: "grok-4.6", useWhen: "Answer a bounded question with source-backed findings that let the manager continue. Use for independent research when briefing and acceptance cost less than doing it directly." }),
  ],
};

it("seeds a fresh install with exactly the plan-consultant preset", async () => {
  expect(await migratedPresets(undefined)).toEqual({ version: 2, presets: [PLAN_CONSULTANT] });
  for (const rosters of ["not json object", { rosters: 7 }]) {
    expect((await migratedPresets(rosters)).presets).toEqual([PLAN_CONSULTANT]);
  }
});

it("drops Forge's shipped roster routes, leaving only plan-consultant", async () => {
  const handsOn = { ...shippedDefault, rosterId: "hands-on-support", name: "Hands-on support" };
  const written = await migratedPresets({ version: 1, defaultRosterId: "balanced", rosters: [shippedBalanced, shippedDefault, handsOn] });
  expect(written).toEqual({ version: 2, presets: [PLAN_CONSULTANT] });
});

it("keeps user-authored roster routes and user changes to shipped routes, then adds plan-consultant", async () => {
  const balanced = {
    ...shippedBalanced,
    routes: [
      ...shippedBalanced.routes,
      route("fast-builder-tuned", { reasoningLevel: "low" }),
    ].map((entry) => entry.routeId === "deep-reasoner" ? { ...entry, useWhen: "My own hard problems." } : entry),
  };
  const written = await migratedPresets(
    {
      version: 1,
      defaultRosterId: "balanced",
      rosters: [
        balanced,
        { rosterId: "mine", revision: 1, routes: [route("quick", { reasoningLevel: "low", useWhen: "" }), route("builder", { modelId: "other" }), route("quick-scout", { modelId: "mine" }), { routeId: "Bad Name" }, "junk"] },
        shippedDefault,
      ],
    },
    { agents: [], profiles: [{ profileId: "a", defaultDelegationRosterId: "mine" }, { profileId: "b", defaultDelegationRosterId: "mine" }, { profileId: "c", defaultDelegationRosterId: "balanced" }] },
  );
  expect(written).toEqual({
    version: 2,
    presets: [
      { name: "quick", provider: "openai-codex", modelId: "gpt-5.5", reasoningLevel: "low" },
      { name: "builder", provider: "openai-codex", modelId: "other", reasoningLevel: "high", note: "Bounded implementation work." },
      { name: "quick-scout", provider: "openai-codex", modelId: "mine", reasoningLevel: "high", note: "Bounded implementation work." },
      { name: "deep-reasoner", provider: "openai-codex", modelId: "gpt-5.5", reasoningLevel: "high", note: "My own hard problems." },
      { name: "fast-builder-tuned", provider: "openai-codex", modelId: "gpt-5.5", reasoningLevel: "low", note: "Bounded implementation work." },
      PLAN_CONSULTANT,
    ],
  });
});

it("keeps the user's own plan-consultant instead of adding the default", async () => {
  const written = await migratedPresets({ rosters: [{ rosterId: "mine", routes: [route("plan-consultant", { modelId: "gpt-6-sol" })] }] });
  expect(written.presets).toEqual([{ name: "plan-consultant", provider: "openai-codex", modelId: "gpt-6-sol", reasoningLevel: "high", note: "Bounded implementation work." }]);
});

it("falls back to defaultRosterId when no profile references a roster", async () => {
  const written = await migratedPresets({ defaultRosterId: "second", rosters: [{ rosterId: "first", routes: [route("one")] }, { rosterId: "second", routes: [route("two")] }] });
  expect(written.presets.map((preset: { name: string }) => preset.name)).toEqual(["two", "one", "plan-consultant"]);
});

it("never touches an existing worker-presets.json", async () => {
  const { dataDir, storeFile } = await dataDirWith({ rosters: [{ rosterId: "mine", routes: [route("one")] }] });
  const existing = JSON.stringify({ version: 2, presets: [{ name: "pruned", provider: "anthropic", modelId: "x", reasoningLevel: "low" }] });
  await writeFile(getWorkerPresetsPath(dataDir), existing);
  expect(await migrateDelegationRostersToWorkerPresets(dataDir, storeFile)).toBe(false);
  expect(await readFile(getWorkerPresetsPath(dataDir), "utf8")).toBe(existing);

  await writeFile(getWorkerPresetsPath(dataDir), JSON.stringify({ version: 2, presets: [] }));
  expect(await migrateDelegationRostersToWorkerPresets(dataDir, storeFile)).toBe(false);
  expect(await readWorkerPresetSettings(dataDir)).toEqual({ version: 2, presets: [] });
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
