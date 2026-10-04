import { withEnvironmentRouteAccess } from "../../rpc/http-route-access.js";
import type {
  PhoenixObservabilitySettingsPatch,
} from "@forge/protocol";
import type { ObservabilityFacade } from "../../../observability/observability-types.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const SETTINGS_PATH = "/api/phoenix-observability/settings";
const STATUS_PATH = "/api/phoenix-observability/status";
const TEST_PATH = "/api/phoenix-observability/test";
const OBSERVABILITY_METHODS = "GET, PUT, POST, OPTIONS";

export function createPhoenixObservabilityRoutes(options: {
  observabilityService: ObservabilityFacade;
}): HttpRoute[] {
  const { observabilityService } = options;

  return withEnvironmentRouteAccess([
    {
      methods: OBSERVABILITY_METHODS,
      matches: (pathname) => pathname === SETTINGS_PATH || pathname === STATUS_PATH || pathname === TEST_PATH,
      handle: async (request, response, requestUrl) => {
        applyCorsHeaders(request, response, OBSERVABILITY_METHODS);

        if (request.method === "OPTIONS") {
          response.statusCode = 204;
          response.end();
          return;
        }

        try {
          if (requestUrl.pathname === SETTINGS_PATH) {
            await handleSettingsRequest(request, response, observabilityService);
            return;
          }

          if (requestUrl.pathname === STATUS_PATH) {
            if (request.method !== "GET") {
              sendMethodNotAllowed(response, "GET, OPTIONS");
              return;
            }

            sendJson(response, 200, { status: observabilityService.getStatus() });
            return;
          }

          if (requestUrl.pathname === TEST_PATH) {
            if (request.method !== "POST") {
              sendMethodNotAllowed(response, "POST, OPTIONS");
              return;
            }

            const payload = await readJsonBody(request);
            const patch = parseTestPayload(payload);
            const result = await observabilityService.testConnection(patch);
            sendJson(response, result.ok ? 200 : 400, result as unknown as Record<string, unknown>);
            return;
          }

          sendJson(response, 404, { error: "Not Found" });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to process Phoenix observability request.";
          sendJson(response, 400, { error: message });
        }
      },
    },
  ], { GET: { scopes: ['settings:admin'] }, HEAD: { scopes: ['settings:admin'] }, POST: { scopes: ['settings:admin'] }, PUT: { scopes: ['settings:admin'] }, PATCH: { scopes: ['settings:admin'] }, DELETE: { scopes: ['settings:admin'] } });
}

async function handleSettingsRequest(
  request: Parameters<HttpRoute["handle"]>[0],
  response: Parameters<HttpRoute["handle"]>[1],
  observabilityService: ObservabilityFacade,
): Promise<void> {
  if (request.method === "GET") {
    const settings = await observabilityService.getSettings();
    sendJson(response, 200, { settings, status: observabilityService.getStatus() });
    return;
  }

  if (request.method === "PUT") {
    const payload = await readJsonBody(request);
    const settings = await observabilityService.updateSettings(parseSettingsPatch(payload));
    sendJson(response, 200, { settings, status: observabilityService.getStatus() });
    return;
  }

  sendMethodNotAllowed(response, "GET, PUT, OPTIONS");
}

function parseSettingsPatch(value: unknown): PhoenixObservabilitySettingsPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object.");
  }

  return value as PhoenixObservabilitySettingsPatch;
}

function parseTestPayload(value: unknown): PhoenixObservabilitySettingsPatch | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const maybe = value as { settings?: unknown };
  if (maybe.settings === undefined) {
    return undefined;
  }

  return parseSettingsPatch(maybe.settings);
}

function sendMethodNotAllowed(response: Parameters<HttpRoute["handle"]>[1], methods: string): void {
  response.setHeader("Allow", methods);
  sendJson(response, 405, { error: "Method Not Allowed" });
}
