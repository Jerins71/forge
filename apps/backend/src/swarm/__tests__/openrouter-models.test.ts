import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OpenRouterModelEntry } from "@forge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { getOpenRouterModelsPath } from "../data-paths.js";
import { ModelCatalogService } from "../catalog/model-catalog-service.js";
import { addOpenRouterModel, getOpenRouterModels, readOpenRouterModels, removeOpenRouterModel, writeOpenRouterModels, mutateOpenRouterModelsFile, getOpenRouterRoutingRevision } from "../catalog/openrouter-models.js";

const tempDirs: string[] = [];

async function makeTempDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "forge-openrouter-models-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("openrouter-models", () => {
  it("preserves persisted retired entries while hiding and rejecting them", async () => {
    const dataDir = await makeTempDataDir();
    const adjacentModel = {
      modelId: "anthropic/claude-3.5-sonnet",
      displayName: "Claude 3.5 Sonnet",
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      supportsReasoning: true,
      supportedReasoningLevels: ["none", "low", "medium", "high"],
      inputModes: ["text", "image"],
      addedAt: "2026-04-03T00:00:00.000Z",
    } satisfies OpenRouterModelEntry;
    const retiredModels = [
      {
        modelId: "anthropic/claude-haiku-4.5",
        displayName: "Claude Haiku 4.5",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        supportsReasoning: true,
        supportedReasoningLevels: ["low", "medium", "high"],
        inputModes: ["text", "image"],
        addedAt: "2026-07-26T00:00:00.000Z",
      },
      {
        modelId: "openai/gpt-5.3-codex-spark",
        displayName: "GPT-5.3 Codex Spark",
        contextWindow: 128_000,
        maxOutputTokens: 128_000,
        supportsReasoning: true,
        supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
        inputModes: ["text"],
        addedAt: "2026-07-26T00:00:00.000Z",
      },
    ] satisfies OpenRouterModelEntry[];

    await writeOpenRouterModels(dataDir, {
      version: 1,
      models: {
        [adjacentModel.modelId]: adjacentModel,
        ...Object.fromEntries(retiredModels.map((model) => [model.modelId, model])),
      },
    });

    const persisted = await readOpenRouterModels(dataDir);
    for (const retiredModel of retiredModels) {
      expect(persisted.models).toHaveProperty(retiredModel.modelId);
      await expect(addOpenRouterModel(dataDir, retiredModel)).rejects.toThrow(
        "Retired OpenRouter model cannot be added",
      );
    }

    await expect(getOpenRouterModels(dataDir)).resolves.toEqual([adjacentModel]);

    const service = new ModelCatalogService();
    await service.loadOverrides(dataDir);
    expect(service.getOpenRouterModels()).toEqual([adjacentModel]);
    expect(service.isKnownModelId(adjacentModel.modelId, "openrouter")).toBe(true);
    expect(service.inferProvider(adjacentModel.modelId)).toBe("openrouter");
    expect(service.isModelEnabled(adjacentModel.modelId, "openrouter")).toBe(true);
    expect(service.getAllModelIds()).toContain(adjacentModel.modelId);

    for (const retiredModel of retiredModels) {
      expect(service.isKnownModelId(retiredModel.modelId, "openrouter")).toBe(false);
      expect(service.inferProvider(retiredModel.modelId)).toBeNull();
      expect(service.isModelEnabled(retiredModel.modelId, "openrouter")).toBe(false);
      expect(service.getAllModelIds()).not.toContain(retiredModel.modelId);
    }
  });

  it("supports add/list/remove CRUD operations and catalog service reloads", async () => {
    const dataDir = await makeTempDataDir();

    await addOpenRouterModel(dataDir, {
      modelId: "anthropic/claude-3.5-sonnet",
      displayName: "Claude 3.5 Sonnet",
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      supportsReasoning: true,
      supportedReasoningLevels: ["none", "low", "medium", "high"],
      inputModes: ["text", "image"],
      addedAt: "2026-04-03T00:00:00.000Z",
    });

    expect(await getOpenRouterModels(dataDir)).toEqual([
      {
        modelId: "anthropic/claude-3.5-sonnet",
        displayName: "Claude 3.5 Sonnet",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        supportsReasoning: true,
        supportedReasoningLevels: ["none", "low", "medium", "high"],
        inputModes: ["text", "image"],
        addedAt: "2026-04-03T00:00:00.000Z",
      },
    ]);

    const service = new ModelCatalogService();
    await service.loadOverrides(dataDir);

    expect(service.isKnownModelId("anthropic/claude-3.5-sonnet")).toBe(true);
    expect(service.inferProvider("anthropic/claude-3.5-sonnet")).toBe("openrouter");
    expect(service.getOpenRouterModels()).toEqual([
      {
        modelId: "anthropic/claude-3.5-sonnet",
        displayName: "Claude 3.5 Sonnet",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        supportsReasoning: true,
        supportedReasoningLevels: ["none", "low", "medium", "high"],
        inputModes: ["text", "image"],
        addedAt: "2026-04-03T00:00:00.000Z",
      },
    ]);

    await addOpenRouterModel(dataDir, {
      modelId: "google/gemini-2.0-flash",
      displayName: "Gemini 2.0 Flash",
      contextWindow: 1_000_000,
      maxOutputTokens: 8_192,
      supportsReasoning: false,
      supportedReasoningLevels: ["none"],
      inputModes: ["text", "image"],
      addedAt: "2026-04-03T00:05:00.000Z",
    });
    await service.reloadOpenRouterModels();

    expect(service.getOpenRouterModels().map((model) => model.modelId)).toEqual([
      "anthropic/claude-3.5-sonnet",
      "google/gemini-2.0-flash",
    ]);

    await removeOpenRouterModel(dataDir, "anthropic/claude-3.5-sonnet");
    await service.reloadOpenRouterModels();

    expect(service.isKnownModelId("anthropic/claude-3.5-sonnet")).toBe(false);
    expect(service.getOpenRouterModels().map((model) => model.modelId)).toEqual([
      "google/gemini-2.0-flash",
    ]);
  });

  it("writes atomically via temp-file rename", async () => {
    const dataDir = await makeTempDataDir();
    const filePath = getOpenRouterModelsPath(dataDir);
    const fileDir = dirname(filePath);

    await addOpenRouterModel(dataDir, {
      modelId: "qwen/qwen3-coder:free",
      displayName: "Qwen3 Coder Free",
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
      supportsReasoning: true,
      supportedReasoningLevels: ["none", "low", "medium", "high"],
      inputModes: ["text"],
      addedAt: "2026-04-03T00:10:00.000Z",
    });

    const storedAfterAdd = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
      models: Record<string, { modelId: string }>;
    };

    expect(storedAfterAdd.version).toBe(1);
    expect(storedAfterAdd.models["qwen/qwen3-coder:free"]?.modelId).toBe("qwen/qwen3-coder:free");
    expect((await readdir(fileDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    await removeOpenRouterModel(dataDir, "qwen/qwen3-coder:free");

    const storedAfterRemove = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
      models: Record<string, unknown>;
    };

    expect(storedAfterRemove).toEqual({ version: 1, models: {} });
    expect((await readdir(fileDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("OpenRouter routing persistence", () => {
  it("serializes mutation plus apply/rollback, preserving the later write", async () => {
    const dataDir = await makeTempDataDir();
    await writeOpenRouterModels(dataDir, { version: 1, models: {}, routingDefaults: { zdr: true } });
    const before = await readOpenRouterModels(dataDir);
    let calls = 0;
    const first = mutateOpenRouterModelsFile(dataDir, (file) => ({ ...file, routingDefaults: { zdr: false } }), async () => { if (++calls === 1) throw new Error("apply failed"); });
    const second = mutateOpenRouterModelsFile(dataDir, (file) => ({ ...file, routingDefaults: { ...file.routingDefaults, require_parameters: true } }));
    await expect(first).rejects.toThrow("apply failed");
    await second;
    const after = await readOpenRouterModels(dataDir);
    expect(after.routingDefaults).toEqual({ zdr: true, require_parameters: true });
    expect(getOpenRouterRoutingRevision(after)).not.toBe(getOpenRouterRoutingRevision(before));
  });
});
