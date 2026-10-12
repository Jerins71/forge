import { withEnvironmentRouteAccess } from "../../rpc/http-route-access.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MANAGER_REASONING_LEVELS,
  type ManagerReasoningLevel,
  type ModelPresetInfo,
  type WorkerPresetSettings,
  type WorkerPresetSettingsResponse,
} from "@forge/protocol";
import { modelCatalogService } from "../../../swarm/catalog/model-catalog-service.js";
import { getManagedModelProviderCredentialAvailability, resolveModelCredentialProvider } from "../../../swarm/secrets-env-service.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import {
  applyCorsHeaders,
  readJsonBody,
  sendJson,
} from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const WORKER_PRESETS_ENDPOINT_PATH = "/api/settings/worker-presets";
const SETTINGS_MODELS_ENDPOINT_PATH = "/api/settings/models";
const ENABLED_METHODS = "GET, PUT, OPTIONS";
const SETTINGS_MODELS_METHODS = "GET, OPTIONS";

export function createWorkerPresetRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return withEnvironmentRouteAccess([
    {
      methods: SETTINGS_MODELS_METHODS,
      matches: (pathname) => pathname === SETTINGS_MODELS_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        await handleSettingsModelsRequest(swarmManager, request, response, requestUrl);
      },
    },
    {
      methods: ENABLED_METHODS,
      matches: (pathname) => pathname === WORKER_PRESETS_ENDPOINT_PATH,
      handle: async (request, response) => {
        await handleWorkerPresetsRequest(swarmManager, request, response);
      },
    },
  ], { GET: { scopes: ['session:read'] }, HEAD: { scopes: ['session:read'] }, POST: { scopes: ['workspace:write'] }, PUT: { scopes: ['workspace:write'] }, PATCH: { scopes: ['workspace:write'] }, DELETE: { scopes: ['workspace:write'] } });
}

async function handleWorkerPresetsRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, ENABLED_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }
  applyCorsHeaders(request, response, ENABLED_METHODS);
  if (request.method === "GET") {
    try {
      sendJson(response, 200, { ...await withAvailability(swarmManager, await swarmManager.getWorkerPresetSettings()) });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (request.method === "PUT") {
    try {
      const saved = await swarmManager.saveWorkerPresetSettings(await readJsonBody(request));
      sendJson(response, 200, { ...await withAvailability(swarmManager, saved) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, getErrorStatusCode(message), { error: message });
    }
    return;
  }
  response.setHeader("Allow", ENABLED_METHODS);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

async function getProviderAvailability(swarmManager: SwarmManager): Promise<Map<string, boolean>> {
  const credentialPoolService = typeof swarmManager.getCredentialPoolService === "function"
    ? swarmManager.getCredentialPoolService()
    : undefined;
  return getManagedModelProviderCredentialAvailability(swarmManager.getConfig(), { credentialPoolService });
}

/** Same credential rule the worker spawn path uses: a preset is usable when its provider is signed in. */
async function withAvailability(swarmManager: SwarmManager, settings: WorkerPresetSettings): Promise<WorkerPresetSettingsResponse> {
  const availability = await getProviderAvailability(swarmManager);
  return {
    version: settings.version,
    presets: settings.presets.map((preset) => ({ ...preset, available: availability.get(resolveModelCredentialProvider(preset)) === true })),
  };
}

async function handleSettingsModelsRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, SETTINGS_MODELS_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, SETTINGS_MODELS_METHODS);

  if (request.method === "GET" && requestUrl.pathname === SETTINGS_MODELS_ENDPOINT_PATH) {
    await swarmManager.reloadModelCatalogOverridesAndProjection();
    const providerAvailability = await getProviderAvailability(swarmManager);
    const models = [
      ...modelCatalogService.getSpecialistModelPresetInfoList(),
      ...buildOpenRouterSelectableModels(),
    ].filter((model) => {
      // Providers without a managed credential check stay visible.
      const isAvailable = providerAvailability.get(model.provider);
      return isAvailable ?? true;
    });

    sendJson(response, 200, { models });
    return;
  }

  response.setHeader("Allow", SETTINGS_MODELS_METHODS);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

function buildOpenRouterSelectableModels(): ModelPresetInfo[] {
  return modelCatalogService.getOpenRouterModels().map((model) => ({
    presetId: `openrouter:${model.modelId}`,
    displayName: model.displayName,
    provider: "openrouter",
    modelId: model.modelId,
    defaultReasoningLevel: model.supportsReasoning ? "medium" : "none",
    supportedReasoningLevels: normalizeReasoningLevels(model.supportedReasoningLevels, model.supportsReasoning),
  }));
}

function normalizeReasoningLevels(
  levels: readonly string[],
  supportsReasoning: boolean,
): ManagerReasoningLevel[] {
  const normalized = levels.filter((level): level is ManagerReasoningLevel =>
    MANAGER_REASONING_LEVELS.includes(level as ManagerReasoningLevel),
  );

  if (normalized.length > 0) {
    return normalized;
  }

  return supportsReasoning ? ["none", "low", "medium", "high"] : ["none"];
}

function getErrorStatusCode(message: string): number {
  if (message === "Malformed URL path") {
    return 400;
  }

  if (
    message.includes("Request body") ||
    message.includes("is required") ||
    message.includes("must be") ||
    message.includes("needs a") ||
    message.includes("Duplicate preset") ||
    message.includes("Unknown model") ||
    message.includes("Invalid")
  ) {
    return 400;
  }

  return 500;
}
