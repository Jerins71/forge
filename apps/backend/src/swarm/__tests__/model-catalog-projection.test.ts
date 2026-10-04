import { getOpenRouterModelOverrideKey } from "@forge/protocol";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getModels, streamSimple } from "../pi/pi-ai-compat.js";

import { generatePiProjection } from "../catalog/model-catalog-projection.js";
import { writeModelOverrides } from "../catalog/model-overrides.js";
import { addOpenRouterModel } from "../catalog/openrouter-models.js";

const authStorageStub = {
  getOAuthProviders: () => [],
  get: () => undefined,
  hasAuth: () => false,
  getApiKey: async () => undefined,
};

describe("model-catalog-projection", () => {
  it("projects pending Opus 5.5 with adaptive-thinking compatibility and curated pricing", async () => {
    const { ModelRegistry: RealModelRegistry } = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
      "@earendil-works/pi-coding-agent",
    );
    expect(getModels("anthropic").some((model) => model.id === "claude-opus-5-5")).toBe(false);

    const rootDir = await mkdtemp(join(tmpdir(), "forge-model-catalog-projection-opus55-"));
    const dataDir = join(rootDir, "data");
    await mkdir(dataDir, { recursive: true });

    const projectionPath = await generatePiProjection(dataDir);
    const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
      providers: Record<string, {
        models?: Array<{
          id: string;
          contextWindow?: number;
          maxTokens?: number;
          thinkingLevelMap?: Record<string, string | null>;
          cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
          compat?: Record<string, unknown>;
        }>;
      }>;
    };
    const projectedOpus55 = projection.providers.anthropic?.models?.find(
      (model) => model.id === "claude-opus-5-5",
    );

    expect(projectedOpus55).toMatchObject({
      id: "claude-opus-5-5",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
      compat: { forceAdaptiveThinking: true, supportsTemperature: false },
    });

    const registry = new RealModelRegistry(authStorageStub as any, projectionPath);
    expect(registry.getError()).toBeUndefined();
    expect(registry.find("anthropic", "claude-opus-5-5")).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
      compat: { forceAdaptiveThinking: true, supportsTemperature: false },
    });
    const runtimeModel = registry.find("anthropic", "claude-opus-5-5");
    expect(runtimeModel).toBeDefined();
    const onPayload = vi.fn((_payload: unknown) => { throw new Error("request captured before network"); });
    await streamSimple(runtimeModel!, {
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    }, { apiKey: "test-key", reasoning: "medium", onPayload }).result();
    expect(onPayload).toHaveBeenCalledOnce();
    expect(onPayload.mock.calls[0]?.[0]).toMatchObject({
      model: "claude-opus-5-5",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
    });
  });

  it("adds user-selected OpenRouter models as a custom provider merge block", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-model-catalog-projection-"));
    const dataDir = join(rootDir, "data");
    await mkdir(dataDir, { recursive: true });
    await addOpenRouterModel(dataDir, {
      modelId: "anthropic/claude-3.5-sonnet",
      displayName: "Claude 3.5 Sonnet",
      contextWindow: 200_000,
      maxOutputTokens: 128_000,
      supportsReasoning: true,
      supportedReasoningLevels: ["none", "low", "medium", "high"],
      inputModes: ["text", "image"],
      addedAt: "2026-04-03T00:00:00.000Z",
    });

    await writeModelOverrides(dataDir, {
      version: 1,
      overrides: { [getOpenRouterModelOverrideKey("anthropic/claude-3.5-sonnet")]: { contextWindowCap: 50_000, managerEnabled: true } },
    });

    const projectionPath = await generatePiProjection(dataDir);
    const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
      providers: Record<string, { baseUrl?: string; apiKey?: string; api?: string; models?: Array<{ id: string; name?: string }> }>;
    };

    expect(projection.providers.openrouter).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "$OPENROUTER_API_KEY",
      api: "openai-completions",
    });
    expect(projection.providers.openrouter?.models).toEqual([
      expect.objectContaining({
        id: "anthropic/claude-3.5-sonnet",
        name: "Claude 3.5 Sonnet",
        contextWindow: 50_000,
      }),
    ]);

    const { ModelRegistry: RealModelRegistry } = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
      "@earendil-works/pi-coding-agent",
    );
    const registry = new RealModelRegistry(authStorageStub as any, projectionPath);
    expect(registry.getError()).toBeUndefined();
    expect(registry.find("openrouter", "anthropic/claude-3.5-sonnet")).toMatchObject({
      contextWindow: 50_000, maxTokens: 128_000, api: "openai-completions",
    });
    // Match built-in caps: advertised output metadata stays intact, while Pi bounds
    // each request's output budget to the effective window minus prompt and reserve.
    const { buildBaseOptions } = await import("@earendil-works/pi-ai/api/simple-options");
    const projectedModel = registry.find("openrouter", "anthropic/claude-3.5-sonnet")!;
    expect(buildBaseOptions(projectedModel, { messages: [] }).maxTokens).toBe(50_000 - 4096);

  });
});
