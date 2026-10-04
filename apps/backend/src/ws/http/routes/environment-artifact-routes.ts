import { pipeline } from "node:stream/promises";
import { ENVIRONMENT_PROTOCOL_HEADER, ENVIRONMENT_PROTOCOL_VERSION } from "@forge/protocol/environment-v2";
import type { ArtifactService } from "../../../environment/control/artifact-service.js";
import type { EnvironmentAccessPort } from "../../../environment/control/control-types.js";
import { sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

export function createEnvironmentArtifactRoutes({ access, artifactService }: {
  access: Pick<EnvironmentAccessPort, "authenticateHttp" | "registerResource">;
  artifactService: ArtifactService;
}): HttpRoute[] {
  return [{
    methods: "GET, POST",
    matches: pathname => pathname === "/api/v2/artifacts" || /^\/api\/v2\/artifacts\/[^/]+$/.test(pathname),
    async handle(request, response, url) {
      const controller = new AbortController(); let unregister: (() => void) | undefined;
      const disconnect = () => controller.abort(); response.once("close", disconnect);
      try {
        if (request.headers[ENVIRONMENT_PROTOCOL_HEADER] !== String(ENVIRONMENT_PROTOCOL_VERSION)) throw Object.assign(new Error("Environment protocol version must match."), { code: "PROTOCOL_MISMATCH" });
        if (request.method === "POST" && url.pathname === "/api/v2/artifacts") {
          const principal = await access.authenticateHttp(request, "session:operate", true);
          unregister = access.registerResource(principal, () => { controller.abort(); request.destroy(); response.destroy(); });
          const encodedName = request.headers["x-forge-file-name"]; const mimeType = request.headers["content-type"];
          if (typeof encodedName !== "string" || typeof mimeType !== "string") throw Object.assign(new Error("Artifact filename and content type are required."), { code: "INVALID_INPUT" });
          let fileName: string; try { fileName = decodeURIComponent(encodedName); } catch { throw Object.assign(new Error("Artifact filename encoding is invalid."), { code: "INVALID_INPUT" }); }
          const length = request.headers["content-length"];
          const artifact = await artifactService.upload({ principal, projectId: url.searchParams.get("projectId") ?? "", uploadId: url.searchParams.get("uploadId") ?? "",
            fileName, mimeType: mimeType.split(";")[0]!.trim().toLowerCase(), sizeBytes: length === undefined ? undefined : Number(length), body: request, signal: controller.signal });
          sendJson(response, 200, artifact); return;
        }
        if (request.method === "GET" && url.pathname.startsWith("/api/v2/artifacts/")) {
          const principal = await access.authenticateHttp(request, "session:read", false);
          unregister = access.registerResource(principal, () => { controller.abort(); response.destroy(); });
          const artifactId = url.pathname.slice("/api/v2/artifacts/".length);
          const download = await artifactService.openDownload({ principal, artifactId, range: request.headers.range, signal: controller.signal });
          const name = download.ref.fileName.replace(/[\x00-\x1f\x7f"\\/]/g, "_");
          response.writeHead(download.partial ? 206 : 200, {
            "Content-Type": download.ref.mimeType, "Content-Length": download.sizeBytes, "Accept-Ranges": "bytes",
            ...(download.partial ? { "Content-Range": `bytes ${download.start}-${download.end}/${download.ref.sizeBytes}` } : {}),
            "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
            "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Content-Security-Policy": "sandbox; default-src 'none'",
          });
          await pipeline(download.stream, response); return;
        }
        sendJson(response, 405, { error: { code: "INVALID_INPUT", message: "Artifact method is not supported.", retryable: false } });
      } catch (caught) {
        if (response.destroyed || response.headersSent) { response.destroy(); return; }
        const error = caught as { code?: string; message?: string };
        const statuses: Record<string, number> = { INVALID_INPUT: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, PROTOCOL_MISMATCH: 409, PAYLOAD_TOO_LARGE: 413 };
        const code = error.code && statuses[error.code] ? error.code : "INTERNAL";
        sendJson(response, statuses[code] ?? 500, { error: { code, message: code === "INTERNAL" ? "Artifact operation failed." : error.message, retryable: false } });
      } finally { unregister?.(); response.removeListener("close", disconnect); }
    },
  }];
}
