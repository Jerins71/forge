import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANAGER_SELECTION_CATALOG_LIMITS, getOpenRouterModelOverrideKey, type ManagerModelSurface, type OpenRouterModelEntry } from "@forge/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManagerSelectionCatalog } from "../catalog/manager-selection-catalog.js";
import { resolveExactManagerModelSelection } from "../catalog/manager-model-selection.js";
import { modelCatalogService } from "../catalog/model-catalog-service.js";
import { writeModelOverrides } from "../catalog/model-overrides.js";
import { writeOpenRouterModels } from "../catalog/openrouter-models.js";

const ALL_AVAILABLE = new Map<string, boolean>([
  ["openai-codex", true],
  ["codex-native", true],
  ["anthropic", true],
  ["xai", true],
  ["openrouter", true],
  ["cursor-sdk", true],
]);

function openRouterEntry(
  modelId: string,
  overrides: Partial<OpenRouterModelEntry> = {},
): OpenRouterModelEntry {
  return {
    modelId,
    displayName: `OpenRouter ${modelId}`,
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    supportsReasoning: true,
    supportedReasoningLevels: ["low", "medium", "high"],
    inputModes: ["text"],
    supportsTools: true,
    addedAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

describe.sequential("manager selection catalog projection", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-manager-selection-catalog-"));
    modelCatalogService.setXaiOAuthDiscoveredModels(null);
    await writeModelOverrides(dataDir, { version: 1, overrides: {} });
    await writeOpenRouterModels(dataDir, { version: 1, models: {} });
    await modelCatalogService.loadOverrides(dataDir);
  });

  afterEach(async () => {
    modelCatalogService.setXaiOAuthDiscoveredModels(null);
    await rm(dataDir, { recursive: true, force: true });
  });

  it("keeps every projected selectable surface in resolver parity and enforces response bounds", async () => {
    const models: Record<string, OpenRouterModelEntry> = {};
    const overrides: Record<string, { managerEnabled: true }> = {};
    for (let index = 0; index < 160; index += 1) {
      const model = openRouterEntry(`vendor/model-${String(index).padStart(3, "0")}`);
      models[model.modelId] = model;
      overrides[getOpenRouterModelOverrideKey(model.modelId)] = { managerEnabled: true };
    }
    const overlong = openRouterEntry(`vendor/${"x".repeat(300)}`);
    models[overlong.modelId] = overlong;
    overrides[getOpenRouterModelOverrideKey(overlong.modelId)] = { managerEnabled: true };
    await writeOpenRouterModels(dataDir, { version: 1, models });
    await writeModelOverrides(dataDir, { version: 1, overrides });
    await modelCatalogService.loadOverrides(dataDir);

    const catalog = buildManagerSelectionCatalog(ALL_AVAILABLE);
    expect(catalog.models).toHaveLength(MANAGER_SELECTION_CATALOG_LIMITS.maxModels);
    expect(catalog.models.some((model) => model.modelId === overlong.modelId)).toBe(false);

    for (const option of catalog.models) {
      for (const surface of Object.keys(option.surfaces) as ManagerModelSurface[]) {
        if (!option.surfaces[surface]?.selectable) continue;
        for (const reasoning of option.reasoningOptions) {
          expect(() => resolveExactManagerModelSelection(
            { provider: option.provider, modelId: option.modelId },
            { surface, providerAvailability: ALL_AVAILABLE, reasoningLevel: reasoning.id },
          )).not.toThrow();
        }
      }
    }
  });
});
