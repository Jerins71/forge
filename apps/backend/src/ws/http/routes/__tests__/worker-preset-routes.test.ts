import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORGE_MODEL_CATALOG } from "@forge/protocol";
import { afterEach, expect, it, vi } from "vitest";

// Credentials are the secrets service's concern; here only the model's own provider is signed in.
const SIGNED_IN = Object.values(FORGE_MODEL_CATALOG.models)[0]!.provider;
vi.mock("../../../../swarm/secrets-env-service.js", () => ({
  getManagedModelProviderCredentialAvailability: async () => new Map([[SIGNED_IN, true]]),
  resolveModelCredentialProvider: (model: { provider: string }) => model.provider,
}));
import { modelCatalogService } from "../../../../swarm/catalog/model-catalog-service.js";
import { readWorkerPresetSettings, saveWorkerPresetSettings } from "../../../../swarm/specialists/worker-presets.js";
import type { SwarmManager } from "../../../../swarm/swarm-manager.js";
import { createWorkerPresetRoutes } from "../worker-preset-routes.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function start(): Promise<{ url: string; dataDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "worker-preset-routes-"));
  // The production settings service does exactly this, plus recycling managers.
  const swarmManager = {
    getConfig: () => ({}),
    getWorkerPresetSettings: () => readWorkerPresetSettings(dataDir),
    saveWorkerPresetSettings: (input: unknown) =>
      saveWorkerPresetSettings(dataDir, input, (modelId, provider) => modelCatalogService.isKnownModelId(modelId, provider)),
  } as unknown as SwarmManager;
  const routes = createWorkerPresetRoutes({ swarmManager });
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = routes.find((entry) => entry.matches(requestUrl.pathname));
    if (!route) { response.statusCode = 404; response.end(); return; }
    void route.handle(request, response, requestUrl);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  return { url: `http://127.0.0.1:${address.port}/api/settings/worker-presets`, dataDir };
}

const put = (url: string, body: unknown) =>
  fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

it("reads an empty list, saves a valid one, and reads it back marked by provider sign-in", async () => {
  const { url, dataDir } = await start();
  const models = Object.values(FORGE_MODEL_CATALOG.models);
  const model = models[0]!;
  const other = models.find((entry) => entry.provider !== SIGNED_IN)!;
  const settings = { version: 2, presets: [
    { name: "builder", provider: model.provider, modelId: model.modelId, reasoningLevel: "high", note: "Bounded work." },
    { name: "independent-reviewer", provider: other.provider, modelId: other.modelId, reasoningLevel: "high" },
  ] };
  const answered = { version: 2, presets: [{ ...settings.presets[0], available: true }, { ...settings.presets[1], available: false }] };

  expect(await (await fetch(url)).json()).toEqual({ version: 2, presets: [] });
  const saved = await put(url, settings);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual(answered);
  expect(await (await fetch(url)).json()).toEqual(answered);
  // Availability is an answer, never stored.
  expect(await readWorkerPresetSettings(dataDir)).toEqual(settings);
});

it("rejects duplicate names, bad names and models missing from the catalog without saving", async () => {
  const { url, dataDir } = await start();
  const model = Object.values(FORGE_MODEL_CATALOG.models)[0];
  const preset = { name: "builder", provider: model.provider, modelId: model.modelId, reasoningLevel: "high" };

  for (const [presets, message] of [
    [[preset, preset], /Duplicate preset name: builder/],
    [[{ ...preset, name: "Not A Slug" }], /name must be lowercase/],
    [[{ ...preset, modelId: "no-such-model" }], /Unknown model .*no-such-model/],
  ] as const) {
    const response = await put(url, { version: 2, presets });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(message);
  }
  expect(await readWorkerPresetSettings(dataDir)).toEqual({ version: 2, presets: [] });
});
