import type { ProjectSecureSessionsSettings } from "@forge/protocol";
import { SecureSessionsContractError } from "@forge/protocol";
import type { HttpRoute } from "../shared/http-route.js";
import {
  applySecureHeaders, assertKnownKeys, handleSecureRouteError, parsePathId,
  readSecureJsonBody, requireObject, sendSecureError, sendSecureJson,
} from "./secure-secret-routes.js";

const PATH = /^\/api\/secure-secrets\/projects\/([^/]+)\/settings$/;

/** Shares the Builder secure-control authorization boundary with the secret catalog. */
export function createProjectSecureSessionsRoutes(options: { service: {
  getProjectSecureSessionsSettings(profileId: string): ProjectSecureSessionsSettings;
  updateProjectSecureSessionsSettings(profileId: string, enabled: boolean): Promise<ProjectSecureSessionsSettings>;
} }): HttpRoute[] {
  const methods = "GET, PUT, OPTIONS";
  return [{
    methods,
    matches: pathname => PATH.test(pathname),
    async handle(request, response, url) {
      applySecureHeaders(request, response, methods);
      if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
      try {
        const profileId = parsePathId(url.pathname.match(PATH)?.[1], "profileId");
        if (request.method === "GET") {
          sendSecureJson(response, 200, options.service.getProjectSecureSessionsSettings(profileId));
        } else if (request.method === "PUT") {
          const input = requireObject(await readSecureJsonBody(request, 1024));
          assertKnownKeys(input, ["enabled"]);
          if (typeof input.enabled !== "boolean") throw new SecureSessionsContractError("enabled must be a boolean");
          sendSecureJson(response, 200, await options.service.updateProjectSecureSessionsSettings(profileId, input.enabled));
        } else {
          response.setHeader("Allow", methods);
          sendSecureError(response, "SECURE_REQUEST_INVALID", 405);
        }
      } catch (error) { handleSecureRouteError(response, error); }
    },
  }];
}
