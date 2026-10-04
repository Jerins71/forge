import { withEnvironmentRouteAccess } from "../../rpc/http-route-access.js";
import type { OnboardingState, OnboardingTechnicalLevel } from "@forge/protocol";
import { ONBOARDING_TECHNICAL_LEVEL_VALUES } from "@forge/protocol";
import { getOnboardingSnapshot, saveOnboardingPreferences, skipOnboarding } from "../../../swarm/onboarding-state.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const ONBOARDING_STATE_ENDPOINT_PATH = "/api/onboarding/state";
const ONBOARDING_STATE_METHODS = "GET, OPTIONS";
const ONBOARDING_PREFERENCES_ENDPOINT_PATH = "/api/onboarding/preferences";
const ONBOARDING_PREFERENCES_METHODS = "POST, OPTIONS";
const ONBOARDING_PREFERRED_NAME_MAX_LENGTH = 200;
const ONBOARDING_ADDITIONAL_PREFERENCES_MAX_LENGTH = 2000;

export function createOnboardingRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return withEnvironmentRouteAccess([
    {
      methods: ONBOARDING_STATE_METHODS,
      matches: (pathname) => pathname === ONBOARDING_STATE_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") return optionsResponse(request, response, ONBOARDING_STATE_METHODS);
        if (request.method !== "GET") return methodNotAllowed(request, response, ONBOARDING_STATE_METHODS);
        applyCorsHeaders(request, response, ONBOARDING_STATE_METHODS);
        try {
          const snapshot = await getOnboardingSnapshot(swarmManager.getConfig().paths.dataDir);
          sendJson(response, 200, { state: buildOnboardingStateResponse(snapshot) });
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : "Unable to load onboarding state." });
        }
      },
    },
    {
      methods: ONBOARDING_PREFERENCES_METHODS,
      matches: (pathname) => pathname === ONBOARDING_PREFERENCES_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") return optionsResponse(request, response, ONBOARDING_PREFERENCES_METHODS);
        if (request.method !== "POST") return methodNotAllowed(request, response, ONBOARDING_PREFERENCES_METHODS);
        applyCorsHeaders(request, response, ONBOARDING_PREFERENCES_METHODS);
        try {
          const payload = await readJsonBody(request, 8 * 1024);
          const mutation = parseOnboardingPreferencesPayload(payload);
          if (!mutation) {
            sendJson(response, 400, { error: "Request body must include onboarding preferences or skipped status." });
            return;
          }
          const dataDir = swarmManager.getConfig().paths.dataDir;
          const snapshot = "status" in mutation
            ? await skipOnboarding(dataDir)
            : await saveOnboardingPreferences(dataDir, mutation);
          sendJson(response, 200, { state: buildOnboardingStateResponse(snapshot) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to save onboarding preferences.";
          sendJson(response, message.includes("Request body too large") ? 413 : 400, { error: message });
        }
      },
    },
  ], { GET: { scopes: ['settings:admin'] }, HEAD: { scopes: ['settings:admin'] }, POST: { scopes: ['settings:admin'] }, PUT: { scopes: ['settings:admin'] }, PATCH: { scopes: ['settings:admin'] }, DELETE: { scopes: ['settings:admin'] } });
}

function buildOnboardingStateResponse(snapshot: OnboardingState) {
  return {
    status: snapshot.status,
    completedAt: snapshot.completedAt,
    skippedAt: snapshot.skippedAt,
    preferences: snapshot.preferences,
  };
}

function parseOnboardingPreferencesPayload(
  payload: unknown,
):
  | { status: "skipped" }
  | { preferredName: string; technicalLevel: OnboardingTechnicalLevel; additionalPreferences?: string | null }
  | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const maybe = payload as Record<string, unknown>;
  if (maybe.status === "skipped") return { status: "skipped" };
  const preferredName = typeof maybe.preferredName === "string" ? maybe.preferredName.trim() : "";
  const technicalLevel = typeof maybe.technicalLevel === "string" ? maybe.technicalLevel.trim() as OnboardingTechnicalLevel : null;
  const additionalPreferences = typeof maybe.additionalPreferences === "string" && maybe.additionalPreferences.trim()
    ? maybe.additionalPreferences.trim()
    : null;
  if (preferredName.length > ONBOARDING_PREFERRED_NAME_MAX_LENGTH) throw new Error(`preferredName must be ${ONBOARDING_PREFERRED_NAME_MAX_LENGTH} characters or fewer.`);
  if (additionalPreferences && additionalPreferences.length > ONBOARDING_ADDITIONAL_PREFERENCES_MAX_LENGTH) throw new Error(`additionalPreferences must be ${ONBOARDING_ADDITIONAL_PREFERENCES_MAX_LENGTH} characters or fewer.`);
  if (!preferredName || !technicalLevel || !ONBOARDING_TECHNICAL_LEVEL_VALUES.includes(technicalLevel)) return null;
  return { preferredName, technicalLevel, additionalPreferences };
}

function optionsResponse(request: Parameters<HttpRoute["handle"]>[0], response: Parameters<HttpRoute["handle"]>[1], methods: string): void {
  applyCorsHeaders(request, response, methods);
  response.statusCode = 204;
  response.end();
}

function methodNotAllowed(request: Parameters<HttpRoute["handle"]>[0], response: Parameters<HttpRoute["handle"]>[1], methods: string): void {
  applyCorsHeaders(request, response, methods);
  response.setHeader("Allow", methods);
  sendJson(response, 405, { error: "Method Not Allowed" });
}
