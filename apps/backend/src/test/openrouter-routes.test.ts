import { createTestEnvironment } from "../test-support/environment-auth.js";
import { readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModels } from "../swarm/pi/pi-ai-compat.js";
import type { SwarmConfig } from "../swarm/types.js";
import { getOpenRouterModelsPath, getSharedModelOverridesPath } from "../swarm/data-paths.js";
import { getPiModelsProjectionPath } from "../swarm/catalog/model-catalog-projection.js";
import * as modelOverrides from "../swarm/catalog/model-overrides.js";
import { addOpenRouterModel } from "../swarm/catalog/openrouter-models.js";
import { resetLiveOpenRouterModelsCacheForTests } from "../ws/http/routes/openrouter-routes.js";
import { SwarmWebSocketServer } from "../ws/server.js";
import { TestSwarmManager, bootWithDefaultManager, createTempConfig, getAvailablePort } from "../test-support/index.js";

const tempRoots: string[] = [];
const TEST_OPENROUTER_MODEL_ID =
  getModels("openrouter").find((model) => model.id.startsWith("anthropic/claude"))?.id ??
  "anthropic/claude-sonnet-4";

beforeEach(() => {
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://openrouter.ai/")) return Promise.reject(new Error("No external network in routing tests"));
    return originalFetch(input, init);
  });
});

afterEach(async () => {
  resetLiveOpenRouterModelsCacheForTests();
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => removeTempRoot(root)));
  delete process.env.OPENROUTER_API_KEY;
});

async function removeTempRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOTEMPTY" && code !== "EBUSY") {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }

  await rm(root, { recursive: true, force: true });
}

async function makeTempConfig(port: number): Promise<SwarmConfig> {
  const handle = await createTempConfig({ prefix: "forge-openrouter-routes-", port });
  tempRoots.push(handle.tempRootDir);
  return handle.config;
}

async function startServer(): Promise<{
  config: SwarmConfig;
  manager: TestSwarmManager;
  server: SwarmWebSocketServer;
  pairedFetch: typeof fetch;
}> {
  const port = await getAvailablePort();
  const config = await makeTempConfig(port);
  const manager = new TestSwarmManager(config);
  await bootWithDefaultManager(manager, config, { clearBootstrapSendCalls: false });

  const { environment, unreadTracker, paired } = await createTestEnvironment(manager);
  const pairedFetch: typeof fetch = (input, init) => fetch(input, { ...init, headers: { ...paired.headers, ...init?.headers } });
  const server = new SwarmWebSocketServer({
    environment, unreadTracker,
    swarmManager: manager,
    host: config.host,
    port: config.port,
  });
  await server.start();

  return { config, manager, server, pairedFetch };
}

describe("openrouter-routes", () => {

  it("persists live-verified tool capability and ignores request-body supportsTools claims", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const originalFetch = globalThis.fetch;
    const liveModel = {
      id: "z-ai/glm-5.1",
      name: "Z.ai: GLM 5.1",
      context_length: 202_752,
      max_completion_tokens: 202_752,
      pricing: {
        prompt: 0.000001,
        completion: 0.0000032,
      },
      supported_parameters: ["reasoning", "tools"],
      architecture: {
        modality: "text->text",
      },
      top_provider: {
        max_completion_tokens: 202_752,
      },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://openrouter.ai/api/v1/models") {
        return new Response(JSON.stringify({ data: [liveModel] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return originalFetch(input as Parameters<typeof fetch>[0], init);
    });

    const { config, server, pairedFetch } = await startServer();
    const modelId = "z-ai/glm-5.1";

    try {
      const addResponse = await pairedFetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent(modelId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: {
              modelId,
              displayName: "Client Claim",
              upstreamProvider: "z-ai",
              contextWindow: 1,
              maxOutputTokens: 1,
              supportsReasoning: false,
              supportsTools: false,
              inputModes: ["text"],
            },
          }),
        },
      );
      expect(addResponse.status).toBe(200);
      await expect(addResponse.json()).resolves.toMatchObject({
        modelId,
        displayName: "Z.ai: GLM 5.1",
        supportsTools: true,
      });

      const storedFile = JSON.parse(await readFile(getOpenRouterModelsPath(config.paths.dataDir), "utf8")) as {
        models: Record<string, { supportsTools?: boolean }>;
      };
      expect(storedFile.models[modelId]?.supportsTools).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("rolls back overlay and override files when OpenRouter deletion fails during mutation", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const { config, server, pairedFetch } = await startServer();
    const modelId = TEST_OPENROUTER_MODEL_ID;
    const overrideKey = `openrouter:${modelId}`;

    try {
      const addResponse = await pairedFetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent(modelId)}`,
        { method: "PUT" },
      );
      expect(addResponse.status).toBe(200);
      await modelOverrides.writeModelOverrides(config.paths.dataDir, {
        version: 1,
        overrides: {
          [overrideKey]: { managerEnabled: true },
        },
      });

      const writeSpy = vi.spyOn(modelOverrides, "resetModelOverride").mockRejectedValueOnce(
        new Error("override write failed"),
      );
      const failedDeleteResponse = await pairedFetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent(modelId)}`,
        { method: "DELETE" },
      );
      expect(failedDeleteResponse.status).toBe(500);
      await expect(failedDeleteResponse.json()).resolves.toMatchObject({ error: "override write failed" });

      const restoredModels = JSON.parse(await readFile(getOpenRouterModelsPath(config.paths.dataDir), "utf8")) as {
        models: Record<string, { modelId: string }>;
      };
      expect(restoredModels.models[modelId]?.modelId).toBe(modelId);
      const restoredOverrides = JSON.parse(await readFile(getSharedModelOverridesPath(config.paths.dataDir), "utf8")) as {
        overrides: Record<string, { managerEnabled?: boolean }>;
      };
      expect(restoredOverrides.overrides[overrideKey]).toEqual({ managerEnabled: true });
      writeSpy.mockRestore();
    } finally {
      await server.stop();
    }
  });

  it("adds and removes URL-encoded model ids, regenerates the projection, and exposes OpenRouter selector entries", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const { config, manager, server, pairedFetch } = await startServer();
    const modelId = TEST_OPENROUTER_MODEL_ID;
    const projectionPath = getPiModelsProjectionPath(config.paths.dataDir);
    const addReloadSpy = vi.spyOn(manager, "reloadOpenRouterModelsAndProjection");
    const deleteReloadSpy = vi.spyOn(manager, "reloadModelCatalogOverridesAndProjection");

    try {
      const initialProjection = JSON.parse(await readFile(projectionPath, "utf8")) as {
        providers: Record<string, unknown>;
      };
      expect(initialProjection.providers.openrouter).toBeUndefined();

      const addResponse = await pairedFetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent(modelId)}`,
        { method: "PUT" },
      );
      expect(addResponse.status).toBe(200);
      const added = (await addResponse.json()) as {
        modelId: string;
        displayName: string;
        supportedReasoningLevels: string[];
        inputModes: string[];
        addedAt: string;
      };
      expect(added.modelId).toBe(modelId);
      expect(added.displayName.length).toBeGreaterThan(0);
      expect(added.supportedReasoningLevels.length).toBeGreaterThan(0);
      expect(added.inputModes.length).toBeGreaterThan(0);
      expect(addReloadSpy).toHaveBeenCalledTimes(1);
      expect(deleteReloadSpy).not.toHaveBeenCalled();

      const duplicateAddResponse = await pairedFetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent(modelId)}`,
        { method: "PUT" },
      );
      expect(duplicateAddResponse.status).toBe(200);
      const duplicateAdded = (await duplicateAddResponse.json()) as { modelId: string; addedAt: string };
      expect(duplicateAdded.modelId).toBe(modelId);
      expect(duplicateAdded.addedAt).toBe(added.addedAt);
      expect(addReloadSpy).toHaveBeenCalledTimes(1);
      expect(deleteReloadSpy).not.toHaveBeenCalled();

      const storedFile = JSON.parse(await readFile(getOpenRouterModelsPath(config.paths.dataDir), "utf8")) as {
        models: Record<string, { modelId: string; addedAt: string }>;
      };
      expect(storedFile.models[modelId]?.modelId).toBe(modelId);
      expect(storedFile.models[modelId]?.addedAt).toBe(added.addedAt);

      const afterAddProjection = JSON.parse(await readFile(projectionPath, "utf8")) as {
        providers: Record<string, { models?: Array<{ id: string }> }>;
      };
      expect(afterAddProjection.providers.openrouter?.models).toEqual([
        expect.objectContaining({ id: modelId }),
      ]);

      const openRouterModelsResponse = await pairedFetch(`http://${config.host}:${config.port}/api/settings/openrouter/models`);
      expect(openRouterModelsResponse.status).toBe(200);
      const openRouterModelsPayload = (await openRouterModelsResponse.json()) as {
        models: Array<{ modelId: string }>;
        isConfigured: boolean;
      };
      expect(openRouterModelsPayload.isConfigured).toBe(true);
      expect(openRouterModelsPayload.models.map((model) => model.modelId)).toEqual([modelId]);

      const selectableResponse = await pairedFetch(`http://${config.host}:${config.port}/api/settings/models`);
      expect(selectableResponse.status).toBe(200);
      const selectablePayload = (await selectableResponse.json()) as {
        models: Array<{ provider: string; modelId: string; presetId: string }>;
      };
      expect(selectablePayload.models).toContainEqual(
        expect.objectContaining({
          provider: "openrouter",
          modelId,
          presetId: `openrouter:${modelId}`,
        }),
      );
      deleteReloadSpy.mockClear();

      const deleteResponse = await pairedFetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent(modelId)}`,
        { method: "DELETE" },
      );
      expect(deleteResponse.status).toBe(200);
      expect(addReloadSpy).toHaveBeenCalledTimes(1);
      expect(deleteReloadSpy).toHaveBeenCalledTimes(1);

      const afterDeleteProjection = JSON.parse(await readFile(projectionPath, "utf8")) as {
        providers: Record<string, unknown>;
      };
      expect(afterDeleteProjection.providers.openrouter).toBeUndefined();

      const afterDeleteModelsResponse = await pairedFetch(`http://${config.host}:${config.port}/api/settings/openrouter/models`);
      expect(afterDeleteModelsResponse.status).toBe(200);
      const afterDeleteModelsPayload = (await afterDeleteModelsResponse.json()) as {
        models: Array<{ modelId: string }>;
      };
      expect(afterDeleteModelsPayload.models).toEqual([]);

      const afterDeleteSelectableResponse = await pairedFetch(`http://${config.host}:${config.port}/api/settings/models`);
      expect(afterDeleteSelectableResponse.status).toBe(200);
      const afterDeleteSelectablePayload = (await afterDeleteSelectableResponse.json()) as {
        models: Array<{ provider: string; modelId: string; presetId: string }>;
      };
      expect(afterDeleteSelectablePayload.models).not.toContainEqual(
        expect.objectContaining({
          provider: "openrouter",
          modelId,
          presetId: `openrouter:${modelId}`,
        }),
      );
    } finally {
      addReloadSpy.mockRestore();
      deleteReloadSpy.mockRestore();
      await server.stop();
    }
  });
});

describe("OpenRouter routing settings API", () => {
  it("saves global and exact-model routing, rejects stale/invalid changes, and rolls back failed apply", async () => {
    const { config, manager, server, pairedFetch } = await startServer();
    const base = `http://${config.host}:${config.port}/api/settings/openrouter/routing`;
    const modelId = "test/routing-model";
    const modelUrl = `${base}/models/${encodeURIComponent(modelId)}`;
    const put = (url: string, body: unknown) => pairedFetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      const initial = await (await pairedFetch(base)).json() as { revision: string };
      const saved = await put(base, { revision: initial.revision, routing: { zdr: true, data_collection: "deny", only: ["azure"], max_price: { prompt: 1 } } });
      expect(saved.status).toBe(200);
      const global = await saved.json() as { revision: string };
      expect((await put(base, { revision: initial.revision, routing: {} })).status).toBe(409);
      expect((await put(base, { revision: global.revision, routing: { only: [] } })).status).toBe(400);
      expect((await put(base, { revision: global.revision, routing: { zdr: "false" } })).status).toBe(400);
      expect((await pairedFetch(modelUrl)).status).toBe(404);
      await addOpenRouterModel(config.paths.dataDir, { modelId, displayName: "Test", contextWindow: 1000, maxOutputTokens: 100, supportsReasoning: false, supportedReasoningLevels: ["none"], inputModes: ["text"], addedAt: "2026-09-10T00:00:00Z" });
      const model = await (await pairedFetch(modelUrl)).json() as { revision: string };
      const modelSave = await put(modelUrl, { revision: model.revision, routing: { zdr: null, data_collection: "allow", only: ["openai"], max_price: null, sort: "latency" } });
      expect(modelSave.status).toBe(200);
      const modelSaved = await modelSave.json() as { revision: string; effective: unknown; routing: unknown };
      expect(modelSaved.effective).toEqual({ zdr: true, data_collection: "deny", only: ["openai"], sort: "latency" });
      expect(modelSaved.routing).toMatchObject({ zdr: null, max_price: null });
      const reloaded = await (await pairedFetch(modelUrl)).json();
      expect(reloaded).toEqual(modelSaved);
      const projection = JSON.parse(await readFile(getPiModelsProjectionPath(config.paths.dataDir), "utf8"));
      expect(projection.providers.openrouter.models.find((entry: { id: string }) => entry.id === modelId).compat.openRouterRouting).toEqual(modelSaved.effective);
      const spy = vi.spyOn(manager, "reloadOpenRouterModelsAndProjection").mockRejectedValueOnce(new Error("apply failed"));
      expect((await put(base, { revision: modelSaved.revision, routing: { zdr: true } })).status).toBe(500);
      spy.mockRestore();
      expect(await (await pairedFetch(modelUrl)).json()).toEqual(modelSaved);
      // Two editors of different scopes still share one file-wide revision.
      const outcomes = await Promise.all([
        put(base, { revision: modelSaved.revision, routing: { zdr: true } }),
        put(modelUrl, { revision: modelSaved.revision, routing: { only: ["google-vertex"] } }),
      ]);
      expect(outcomes.map((response) => response.status).sort()).toEqual([200, 409]);
    } finally { await server.stop(); }
  });
});
