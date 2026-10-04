import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChatArtifactRoutes } from "../chat-artifact-routes.js";
import { getSessionFilePath } from "../../../../swarm/storage/data-paths.js";
import { CONVERSATION_ENTRY_TYPE } from "../../../../swarm/session/conversation-timeline.js";
import { MAX_PRESENTED_CHAT_ARTIFACT_PDF_BYTES } from "../../../../swarm/session/presented-chat-artifact.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("chat artifact HTTP route", () => {

  it("issues a one-use PDF ticket and returns application/pdf bytes on redeem", async () => {
    const tempRoot = process.platform === "darwin" ? `/private${tmpdir()}` : tmpdir(); const root = await mkdtemp(join(tempRoot, "artifact-pdf-route-")); cleanup.push(root);
    const dataDir = join(root, "data"); const profileId = "profile"; const agentId = "manager"; const sessionFile = getSessionFilePath(dataDir, profileId, agentId); await mkdir(join(dataDir, "profiles", profileId, "sessions", agentId), { recursive: true });
    const pdf = join(root, "outside.pdf"); const pdfBytes = Buffer.from("%PDF-1.4\nspec\n%%EOF\n"); await writeFile(pdf, pdfBytes);
    const presentedPdf = process.platform === "darwin" ? pdf.replace(/^\/private\/tmp\//, "/tmp/") : pdf;
    await writeFile(sessionFile, JSON.stringify({ type: "custom", customType: CONVERSATION_ENTRY_TYPE, id: "pdf", data: { type: "conversation_message", id: "pdf", agentId, role: "assistant", source: "speak_to_user", text: `[pdf](swarm-file://${presentedPdf})`, timestamp: new Date().toISOString() } }) + "\n");
    const descriptor: any = { agentId, managerId: agentId, role: "manager", profileId, sessionFile, cwd: root };
    const manager: any = { getAgent: (id: string) => id === agentId ? descriptor : undefined, listProfiles: () => [{ profileId }], getConfig: () => ({ paths: { dataDir } }) };
    const routes = createChatArtifactRoutes({ swarmManager: manager, artifactSecurityPlatform: "win32" }); const server = createServer((req, res) => { const url = new URL(req.url ?? "/", "http://x"); const route = routes.find(r => r.matches(url.pathname)); if (route) void route.handle(req, res, url); else { res.statusCode = 404; res.end(); } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address() as any; const url = `http://127.0.0.1:${address.port}/api/chat-artifacts/read`;
    try {
      const ticketResponse = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "pdf", path: presentedPdf, imageTransport: "http_ticket" }) });
      expect(ticketResponse.status).toBe(200); const ticket: any = await ticketResponse.json();
      expect(ticket).toMatchObject({ binary: true, transport: "http_ticket", contentType: "application/pdf", totalBytes: pdfBytes.length }); expect(ticket).not.toHaveProperty("content");
      const raw = await fetch(`http://127.0.0.1:${address.port}${ticket.ticket.url}`);
      expect(raw.status).toBe(200); expect(raw.headers.get("content-type")).toBe("application/pdf"); expect(Buffer.from(await raw.arrayBuffer())).toEqual(pdfBytes);
      const reused = await fetch(`http://127.0.0.1:${address.port}${ticket.ticket.url}`); expect(reused.status).toBe(404);
      await writeFile(pdf, Buffer.alloc(MAX_PRESENTED_CHAT_ARTIFACT_PDF_BYTES + 1, 0x25));
      const oversized = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "pdf", path: presentedPdf, imageTransport: "http_ticket" }) });
      expect(oversized.status).toBe(413); expect(await oversized.json()).toMatchObject({ code: "file_too_large" });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 15_000);
});
