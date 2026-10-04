import type { NativeRuntimeStatusResponse } from "@forge/protocol";
import {
  NativeRuntimeUpdateError,
  type NativeRuntimeUpdateService,
} from "../../../swarm/runtime/runtime-updates/native-runtime-update-service.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

export const NATIVE_RUNTIMES_PATH = "/api/settings/native-runtimes";

/** Composed only by the local Builder: updates run installers on this computer. */
export function createNativeRuntimeRoutes(service: Pick<NativeRuntimeUpdateService, "status" | "startUpdate">): HttpRoute[] {
  const methods = "GET, POST, OPTIONS";
  return [{ methods, matches: pathname => pathname === NATIVE_RUNTIMES_PATH, handle: async (request, response) => {
    applyCorsHeaders(request, response, methods);
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
    if (request.method === "GET") {
      sendJson(response, 200, { runtimes: await service.status() } satisfies NativeRuntimeStatusResponse);
      return;
    }
    if (request.method !== "POST") { sendJson(response, 405, { error: "Method not allowed" }); return; }
    const body = await readJsonBody(request, 4096).catch(() => null) as { runtime?: unknown; expectedCommand?: unknown } | null;
    const runtime = body?.runtime;
    const expectedCommand = body?.expectedCommand;
    if ((runtime !== "codex" && runtime !== "claude") || (expectedCommand !== null && typeof expectedCommand !== "string")) {
      sendJson(response, 400, { error: "Invalid runtime update request" });
      return;
    }
    try {
      sendJson(response, 202, { runtimes: await service.startUpdate(runtime, expectedCommand) } satisfies NativeRuntimeStatusResponse);
    } catch (error) {
      if (!(error instanceof NativeRuntimeUpdateError)) throw error;
      sendJson(response, 409, { error: error.message });
    }
  } }];
}
