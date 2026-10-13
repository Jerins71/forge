import { withEnvironmentRouteAccess } from "../../rpc/http-route-access.js";
import { getSessionAutoTitlesEnabled, setSessionAutoTitlesEnabled } from "../../../swarm/session-titles.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const PATH = "/api/settings/session-auto-titles/enabled";
const METHODS = "GET, PUT, OPTIONS";

/** Whether this environment names its new sessions automatically. On by default. */
export function createSessionAutoTitlesRoutes({ swarmManager }: { swarmManager: SwarmManager }): HttpRoute[] {
  return withEnvironmentRouteAccess([{
    methods: METHODS,
    matches: pathname => pathname === PATH,
    handle: async (request, response) => {
      applyCorsHeaders(request, response, METHODS);
      if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
      const dataDir = swarmManager.getConfig().paths.dataDir;
      try {
        if (request.method === "GET") { sendJson(response, 200, { enabled: await getSessionAutoTitlesEnabled(dataDir) }); return; }
        if (request.method === "PUT") {
          const body = await readJsonBody(request) as { enabled?: unknown } | null;
          if (typeof body?.enabled !== "boolean") { sendJson(response, 400, { error: "enabled must be a boolean" }); return; }
          await setSessionAutoTitlesEnabled(dataDir, body.enabled);
          sendJson(response, 200, { ok: true, enabled: body.enabled });
          return;
        }
        response.setHeader("Allow", METHODS);
        sendJson(response, 405, { error: "Method Not Allowed" });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    },
  }], { GET: { scopes: ["session:read"] }, HEAD: { scopes: ["session:read"] }, PUT: { scopes: ["settings:admin"] } });
}
