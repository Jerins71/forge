import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDelegationRostersPath, resolveDelegationRosterSettings, saveDelegationRosterSettings } from "../delegation-roster-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

async function makeDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "delegation-rosters-"));
  tempDirs.push(dataDir);
  return dataDir;
}

describe("delegation roster settings", () => {

  it("migrates persisted GPT-5.4 and retired xAI route and fallback models on load without rewriting the file", async () => {
    const dataDir = await makeDataDir();
    const settings = await resolveDelegationRosterSettings(dataDir);
    const roster = settings.rosters[0]!;
    const persisted = {
      ...settings,
      defaultRosterId: roster.rosterId,
      rosters: [{
        ...roster,
        routes: roster.routes.map((route) => {
          if (route.routeId === "fast-builder") {
            return {
              ...route,
              label: "My Custom Builder",
              provider: "openai-codex",
              modelId: "gpt-5.4",
              reasoningLevel: "high" as const,
              availabilityFallback: {
                provider: "openai-codex",
                modelId: "gpt-5.4-mini",
                reasoningLevel: "low" as const,
              },
            };
          }
          if (route.routeId === "research-analyst") {
            return {
              ...route,
              label: "My Custom Researcher",
              provider: "xai",
              modelId: "grok-4",
              reasoningLevel: "high" as const,
              availabilityFallback: {
                provider: "xai",
                modelId: "grok-4-fast",
                reasoningLevel: "medium" as const,
              },
            };
          }
          return route;
        }),
      }],
    };
    const rosterPath = getDelegationRostersPath(dataDir);
    await mkdir(dirname(rosterPath), { recursive: true });
    const persistedJson = `${JSON.stringify(persisted, null, 2)}\n`;
    await writeFile(rosterPath, persistedJson, "utf8");

    const loaded = await resolveDelegationRosterSettings(dataDir);
    const loadedRoster = loaded.rosters[0]!;

    expect(loadedRoster.routes.find((route) => route.routeId === "fast-builder")).toMatchObject({
      label: "My Custom Builder",
      provider: "openai-codex",
      modelId: "gpt-5.5",
      reasoningLevel: "high",
      availabilityFallback: {
        provider: "openai-codex",
        modelId: "gpt-5.5",
        reasoningLevel: "low",
      },
    });
    expect(loadedRoster.routes.find((route) => route.routeId === "research-analyst")).toMatchObject({
      label: "My Custom Researcher",
      provider: "xai",
      modelId: "grok-4.6",
      reasoningLevel: "high",
      availabilityFallback: {
        provider: "xai",
        modelId: "grok-4.6",
        reasoningLevel: "medium",
      },
    });
    expect(await readFile(rosterPath, "utf8")).toBe(persistedJson);
  });

  it("increments only changed roster revisions and persists a clone-safe file", async () => {
    const dataDir = await makeDataDir();
    const initial = await resolveDelegationRosterSettings(dataDir);
    const first = await saveDelegationRosterSettings(dataDir, initial);
    const unchanged = await saveDelegationRosterSettings(dataDir, first);
    const changedInput = {
      ...unchanged,
      rosters: unchanged.rosters.map((roster) => ({
        ...roster,
        description: "Changed description.",
      })),
    };
    const changed = await saveDelegationRosterSettings(dataDir, changedInput);

    expect(first.rosters[0]?.revision).toBe(1);
    expect(unchanged.rosters[0]?.revision).toBe(1);
    expect(changed.rosters[0]?.revision).toBe(2);
    expect(JSON.parse(await readFile(getDelegationRostersPath(dataDir), "utf8")))
      .toEqual(changed);
  });
});

it("retains native primary and cross-runtime fallback choices through save and reload", async () => {
  const dataDir = await makeDataDir();
  const settings = await resolveDelegationRosterSettings(dataDir);
  const roster = settings.rosters[0]!;
  roster.routes[0] = { ...roster.routes[0]!, provider: "claude-native", modelId: "claude-fable-5-1", reasoningLevel: "high",
    availabilityFallback: { provider: "codex-native", modelId: "gpt-6-sol", reasoningLevel: "xhigh" } };
  await saveDelegationRosterSettings(dataDir, settings);
  const loaded = await resolveDelegationRosterSettings(dataDir);
  expect(loaded.rosters[0]!.routes[0]).toMatchObject({ provider: "claude-native", modelId: "claude-fable-5-1",
    availabilityFallback: { provider: "codex-native", modelId: "gpt-6-sol", reasoningLevel: "xhigh" } });
});
