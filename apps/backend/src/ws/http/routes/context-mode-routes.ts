import { randomUUID } from "node:crypto";
import { requireHttpPrincipal } from "../../rpc/http-principal.js";
import type { ControlService } from "../../../environment/control/control-types.js";
import { withEnvironmentRouteAccess } from "../../rpc/http-route-access.js";
import type {
  ProjectContextModeSnapshot,
  SessionContextModeSnapshot,
} from "@forge/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ContextModeValidationError,
  parseSessionContextModeWrite,
  requireContextMode,
} from "../../../swarm/context-mode.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { applyCorsHeaders, decodePathSegment, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const PROFILE_CONTEXT_MODE_PATTERN = /^\/api\/profiles\/([^/]+)\/context-mode$/;
const AGENT_CONTEXT_MODE_PATTERN = /^\/api\/agents\/([^/]+)\/context-mode$/;
const CONTEXT_ARTIFACTS_PATTERN = /^\/api\/agents\/([^/]+)\/context-artifacts$/;
const CONTEXT_MODE_METHODS = "GET, PUT, OPTIONS";

export function createContextModeRoutes(options: {
  swarmManager: SwarmManager;
  control?: ControlService;
}): HttpRoute[] {
  const routes = withEnvironmentRouteAccess([
    {
      methods: "GET, OPTIONS",
      matches: pathname => CONTEXT_ARTIFACTS_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        applyCorsHeaders(request, response, "GET, OPTIONS");
        response.setHeader("Cache-Control", "no-store");
        if (request.method === "OPTIONS") {
          response.statusCode = 204;
          response.end();
          return;
        }
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET, OPTIONS");
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }
        const agentId = decodePathSegment(requestUrl.pathname.match(CONTEXT_ARTIFACTS_PATTERN)?.[1]);
        if (!agentId) {
          sendJson(response, 400, { error: "Missing agent id" });
          return;
        }
        try {
          const payload = await options.swarmManager.getSessionContextArtifacts(agentId);
          sendJson(response, 200, payload as unknown as Record<string, unknown>);
        } catch (error) {
          sendContextModeError(response, error);
        }
      },
    },
    {
      methods: CONTEXT_MODE_METHODS,
      matches: (pathname) => PROFILE_CONTEXT_MODE_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleProfileContextModeRequest(options, request, response, requestUrl);
      },
    },
    {
      methods: CONTEXT_MODE_METHODS,
      matches: (pathname) => AGENT_CONTEXT_MODE_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleAgentContextModeRequest(options, request, response, requestUrl);
      },
    },
  ], { GET: { scopes: ['session:read'] }, HEAD: { scopes: ['session:read'] }, POST: { scopes: ['session:operate'] }, PUT: { scopes: ['session:operate'] }, PATCH: { scopes: ['session:operate'] }, DELETE: { scopes: ['session:operate'] } });
  return routes.map(route => route.methods === 'PUT' && route.matches('/api/profiles/fixture/context-mode') ? { ...route, access: { scopes: ['workspace:write'] } } : route);
}

async function handleProfileContextModeRequest(
  options: { swarmManager: SwarmManager; control?: ControlService },
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, CONTEXT_MODE_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, CONTEXT_MODE_METHODS);

  const profileId = decodePathSegment(requestUrl.pathname.match(PROFILE_CONTEXT_MODE_PATTERN)?.[1]);
  if (!profileId) {
    sendJson(response, 400, { error: "Missing profile id" });
    return;
  }

  if (request.method === "GET") {
    try {
      const payload: ProjectContextModeSnapshot = options.swarmManager.getProjectContextMode(profileId);
      sendJson(response, 200, payload as unknown as Record<string, unknown>);
    } catch (error) {
      sendContextModeError(response, error);
    }
    return;
  }

  if (request.method !== "PUT") {
    response.setHeader("Allow", CONTEXT_MODE_METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const mode = requireContextMode(readModeField(body), "mode");
    if (!options.control) throw new Error("Project policy is not composed");
    const receipt = await options.control.execute(requireHttpPrincipal(request), "project.update", { commandId: (body as { commandId?: string }).commandId ?? randomUUID(), projectId: profileId, patch: { contextMode: mode } });
    if (receipt.state !== "succeeded") { sendJson(response, 409, { error: receipt.error }); return; }
    const payload: ProjectContextModeSnapshot = options.swarmManager.getProjectContextMode(profileId);
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
  } catch (error) {
    sendContextModeError(response, error);
  }
}

async function handleAgentContextModeRequest(
  options: { swarmManager: SwarmManager; control?: ControlService },
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, CONTEXT_MODE_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, CONTEXT_MODE_METHODS);

  const agentId = decodePathSegment(requestUrl.pathname.match(AGENT_CONTEXT_MODE_PATTERN)?.[1]);
  if (!agentId) {
    sendJson(response, 400, { error: "Missing agent id" });
    return;
  }

  if (request.method === "GET") {
    try {
      const payload: SessionContextModeSnapshot = options.swarmManager.getSessionContextMode(agentId);
      sendJson(response, 200, payload as unknown as Record<string, unknown>);
    } catch (error) {
      sendContextModeError(response, error);
    }
    return;
  }

  if (request.method !== "PUT") {
    response.setHeader("Allow", CONTEXT_MODE_METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const mode = parseSessionContextModeWrite(readModeField(body, { allowNull: true }));
    if (!options.control) throw new Error("Project policy is not composed");
    const receipt = await options.control.execute(requireHttpPrincipal(request), "session.configure", { commandId: (body as { commandId?: string }).commandId ?? randomUUID(), sessionId: agentId, contextMode: mode });
    if (receipt.state !== "succeeded") { sendJson(response, 409, { error: receipt.error }); return; }
    const payload: SessionContextModeSnapshot = options.swarmManager.getSessionContextMode(agentId);
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
  } catch (error) {
    sendContextModeError(response, error);
  }
}

function readModeField(value: unknown, options?: { allowNull?: boolean }): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextModeValidationError("Request body must be a JSON object");
  }
  if (!Object.prototype.hasOwnProperty.call(value, "mode")) {
    throw new ContextModeValidationError("mode is required");
  }
  if (Object.keys(value).some(key => key !== "mode" && key !== "commandId")) throw new ContextModeValidationError("Unknown context-mode request field");
  const mode = (value as { mode?: unknown }).mode;
  if (mode === null && options?.allowNull) {
    return null;
  }
  return mode;
}

function sendContextModeError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ContextModeValidationError || isBadRequestBodyError(message)) {
    sendJson(response, 400, { error: message });
    return;
  }
  if (
    message.startsWith("Unknown manager profile:") ||
    message.startsWith("Unknown session") ||
    message.startsWith("Unknown agent:") ||
    message.startsWith("Unknown manager:")
  ) {
    sendJson(response, 404, { error: message });
    return;
  }
  if (
    message.includes("only available") ||
    message.includes("only supported") ||
    message.includes("not supported") ||
    message.includes("only be updated on manager sessions") ||
    message.includes("Cannot update Builder") ||
    message.includes("archived")
  ) {
    sendJson(response, 409, { error: message });
    return;
  }
  sendJson(response, 500, { error: message });
}

function isBadRequestBodyError(message: string): boolean {
  return message === "Request body must be valid JSON" || message.startsWith("Request body too large");
}
