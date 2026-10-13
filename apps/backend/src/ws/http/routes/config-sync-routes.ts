import { withEnvironmentRouteAccess } from "../../rpc/http-route-access.js";
import type { ConfigSyncApplyRequest, ConfigSyncLeaseRequest, ConfigSyncResolvePromptRequest, ConfigSyncRestoreRequest, ConfigSyncResolutionCommitRequest } from "@forge/protocol";
import { createConfigSyncStore, isConfigSyncKeyError, type ConfigSyncStore } from "../../../environment/sync/config-sync.js";
import { isEnoentError } from "../../../utils/fs-errors.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const PREFIX = "/api/settings/sync/";

/** Configuration sync: a manifest of allowlisted files, single-file reads, and guarded writes. */
export function createConfigSyncRoutes(options: { dataDir: string }): HttpRoute[] {
  const store: ConfigSyncStore = createConfigSyncStore(options.dataDir);
  const route = (name: string, methods: string, handle: HttpRoute["handle"]): HttpRoute => ({
    methods: `${methods}, OPTIONS`,
    matches: (pathname) => pathname === `${PREFIX}${name}`,
    handle: async (request, response, requestUrl) => {
      applyCorsHeaders(request, response, `${methods}, OPTIONS`);
      if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
      if (request.method !== methods) { response.setHeader("Allow", methods); sendJson(response, 405, { error: "Method Not Allowed" }); return; }
      try {
        await handle(request, response, requestUrl);
      } catch (error) {
        const status = isConfigSyncKeyError(error) ? 400 : isEnoentError(error) ? 404 : 500;
        sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
  return withEnvironmentRouteAccess([
    route("manifest", "GET", async (_request, response) => { sendJson(response, 200, { ...await store.manifest() }); }),
    route("file", "GET", async (_request, response, requestUrl) => {
      sendJson(response, 200, { ...await store.readFile(requestUrl.searchParams.get("key") ?? "", requestUrl.searchParams.get("versionId") ?? undefined) });
    }),
    route("apply", "POST", async (request, response) => {
      sendJson(response, 200, { ...await store.apply(await readJsonBody(request, 32 * 1024 * 1024) as ConfigSyncApplyRequest) });
    }),
    route("history", "GET", async (_request, response) => { sendJson(response, 200, { ...await store.history() }); }),
    route("restore", "POST", async (request, response) => {
      await store.restore(await readJsonBody(request) as ConfigSyncRestoreRequest);
      sendJson(response, 200, { ok: true });
    }),
    route("lease", "POST", async (request, response) => {
      sendJson(response, 200, { ...await store.lease(await readJsonBody(request) as ConfigSyncLeaseRequest) });
    }),
    route("resolve-commit", "POST", async (request, response) => {
      sendJson(response, 200, { ...await store.commitResolution(await readJsonBody(request) as ConfigSyncResolutionCommitRequest) });
    }),
    route("resolve-prompt", "POST", async (request, response) => {
      sendJson(response, 200, { ...await store.resolvePrompt(await readJsonBody(request, 8 * 1024 * 1024) as ConfigSyncResolvePromptRequest) });
    }),
  // The same access as editing presets, skills and prompts directly, so existing pairings can sync.
  ], { GET: { scopes: ["session:read", "workspace:read"] }, POST: { scopes: ["workspace:write"] } });
}
