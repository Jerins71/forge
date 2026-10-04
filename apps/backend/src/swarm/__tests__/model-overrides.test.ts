import { getOpenRouterModelOverrideKey } from "@forge/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCatalogService } from "../catalog/model-catalog-service.js";
import * as openRouterModels from "../catalog/openrouter-models.js";
import { readModelOverrides, writeModelOverrides } from "../catalog/model-overrides.js";

const tempDirs: string[] = [];

async function makeTempDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "forge-model-overrides-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("model-overrides", () => {
  it("reloads provider-scoped OpenRouter caps on restart and preserves them through metadata refresh", async () => {
    const dataDir = await makeTempDataDir();
    const model = {
      modelId: "anthropic/claude-opus-4-6", displayName: "OpenRouter Opus", contextWindow: 200_000,
      maxOutputTokens: 8_192, supportsReasoning: false,
      supportedReasoningLevels: ["none"] as const, inputModes: ["text"] as const,
      addedAt: "2026-04-03T00:00:00.000Z", supportsTools: true,
    };
    await openRouterModels.addOpenRouterModel(dataDir, model);
    await openRouterModels.addOpenRouterModel(dataDir, { ...model, modelId: "other/model" });
    await writeModelOverrides(dataDir, {
      version: 1, overrides: {
        [getOpenRouterModelOverrideKey(model.modelId)]: { contextWindowCap: 80_000, managerEnabled: true },
        "claude-opus-4-6": { contextWindowCap: 300_000 },
      },
    });
    const service = new ModelCatalogService();
    await service.loadOverrides(dataDir);
    expect(service.getContextWindow(model.modelId, "openrouter")).toBe(80_000);
    expect(service.getEffectiveContextWindow(model.modelId)).toBe(80_000);
    expect(service.getEffectiveContextWindow(model.modelId, "anthropic")).toBeUndefined();
    expect(service.getEffectiveContextWindow("claude-opus-4-6", "anthropic")).toBe(300_000);
    expect(service.getEffectiveContextWindow("other/model", "openrouter")).toBe(200_000);
    expect(service.getOpenRouterModel(model.modelId)?.contextWindow).toBe(200_000);
    await openRouterModels.addOpenRouterModel(dataDir, { ...model, contextWindow: 60_000 });
    await service.reloadOpenRouterModels();
    expect(service.getContextWindow(model.modelId, "openrouter")).toBe(60_000);
    expect(service.getOverride(model.modelId, "openrouter")).toEqual({ contextWindowCap: 80_000, managerEnabled: true });
    const restarted = new ModelCatalogService();
    await restarted.loadOverrides(dataDir);
    expect(restarted.getContextWindow(model.modelId, "openrouter")).toBe(60_000);
    expect(restarted.getOverride(model.modelId, "openrouter")).toEqual({ contextWindowCap: 80_000, managerEnabled: true });
  });

  it("preserves non-empty model-specific instructions and omits empty overrides on write", async () => {
    const dataDir = await makeTempDataDir();
    await writeModelOverrides(dataDir, {
      version: 1,
      overrides: {
        "gpt-5.5": {
          modelSpecificInstructions: "Line one\r\nLine two",
        },
        "claude-opus-4-6": {
          modelSpecificInstructions: "",
        },
        "claude-sdk/claude-opus-4-6": {
          modelSpecificInstructions: "   \r\n\t  ",
        },
        empty: {},
      },
    });

    await expect(readModelOverrides(dataDir)).resolves.toEqual({
      version: 1,
      overrides: {
        "gpt-5.5": {
          modelSpecificInstructions: "Line one\nLine two",
        },
      },
    });
  });
});
