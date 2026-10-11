import { withEnvironmentRouteAccess } from "../../rpc/http-route-access.js";
import type { CodexAuthService } from "../../../swarm/runtime/codex/codex-auth-service.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";
import type { NativeApiAccessUpdate } from "@forge/protocol";
import { isRecord } from "../../../utils/normalize.js";

export function createCodexAuthRoutes(service: Pick<CodexAuthService, "status" | "start" | "cancel" | "configure" | "test">): HttpRoute[] {
  const path = "/api/settings/codex-native";
  const methods = "GET, POST, DELETE, OPTIONS";
  return withEnvironmentRouteAccess([{ methods, matches: pathname => pathname === path, handle: async (request, response) => {
    applyCorsHeaders(request, response, methods);
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
    if (request.method === "GET") { sendJson(response, 200, { ...await service.status() }); return; }
    if (request.method !== "POST" && request.method !== "DELETE") { sendJson(response, 405, { error: "Method not allowed" }); return; }
    try {
      const body = await readJsonBody(request, 8192) as { action?: unknown; flowId?: unknown; access?: unknown } | null;
      if (request.method === "DELETE" && typeof body?.flowId === "string") service.cancel(body.flowId);
      else if (request.method === "POST" && body?.action === "configure" && isRecord(body.access)) { sendJson(response, 200, { ...await service.configure(body.access as unknown as NativeApiAccessUpdate) }); return; }
      else if (request.method === "POST" && body?.action === "test") { sendJson(response, 200, { ...await service.test() }); return; }
      else if (request.method === "POST" && body?.action === "start") { sendJson(response, 200, { ...await service.start() }); return; }
      else { sendJson(response, 400, { error: "Invalid Codex sign-in request" }); return; }
      sendJson(response, 200, { ...await service.status() });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Codex sign-in request failed" });
    }
  } }], { GET: { scopes: ['settings:admin'] }, HEAD: { scopes: ['settings:admin'] }, POST: { scopes: ['settings:admin'] }, PUT: { scopes: ['settings:admin'] }, PATCH: { scopes: ['settings:admin'] }, DELETE: { scopes: ['settings:admin'] } });
}
