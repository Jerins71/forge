import { createServer } from "node:http";
import { once } from "node:events";
import { createEnvironmentArtifactRoutes } from "../../ws/http/routes/environment-artifact-routes.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfiguredSqliteDatabaseConstructor } from "../../sqlite-database-loader.js";
import { migrateControlDatabase } from "./migrations.js";
import { createArtifactService } from "./artifact-service.js";
import { getEnvironmentArtifactDir, getUploadsDir } from "../../swarm/storage/data-paths.js";
import type { Principal } from "./control-types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const principal: Principal = { deviceSessionId: "device", scopes: new Set(["session:read", "session:operate"]) };
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "v2-artifacts-"));
  const Database = await loadConfiguredSqliteDatabaseConstructor(); const database = new Database(join(dataDir, "control.sqlite"));
  migrateControlDatabase(database, { environmentId: randomUUID(), streamEpoch: randomUUID() });
  cleanup.push(async () => { database.close(); await rm(dataDir, { recursive: true, force: true }); });
  database.prepare("INSERT INTO device_sessions (device_session_id,token_hash,proof_thumbprint,device_name,kind,scopes_json,created_at,last_seen_at,expires_at) VALUES ('device','fixture-token','fixture-proof','Fixture','cli','[]',0,0,?)").run(Date.now() + 86_400_000);
  database.prepare("INSERT INTO control_projects VALUES ('project','{}',0)").run();
  const service = createArtifactService({ database, dataDir });
  const upload = { principal, projectId: "project", uploadId: randomUUID(), fileName: "fixture.txt", mimeType: "text/plain", sizeBytes: 7 };
  async function* body(text = "fixture") { yield Buffer.from(text); }
  return { dataDir, database, service, upload, body };
}
describe("environment artifact ingress and references", () => {
  it("retries immutable uploads across restart, rejects changed bytes and pins one stored file", async () => {
    const f = await fixture(); const ref = await f.service.upload({ ...f.upload, body: f.body() });
    const restarted = createArtifactService({ database: f.database, dataDir: f.dataDir });
    expect(await restarted.upload({ ...f.upload, body: f.body() })).toEqual(ref);
    await expect(restarted.upload({ ...f.upload, body: f.body("changed") })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readdir(getEnvironmentArtifactDir(f.dataDir))).toHaveLength(1);
    const rows = restarted.validateInput({ principal, projectId: "project", artifactIds: [ref.artifactId] });
    f.database.transaction(() => {
      f.database.prepare("INSERT INTO commands VALUES ('command','device','session.send','fixture','{}','session',0)").run();
      f.database.prepare("INSERT INTO control_sessions (session_id,project_id,desired_state,summary_json,updated_sequence) VALUES ('session','project','running','{}',0)").run();
      f.database.prepare("INSERT INTO control_inputs VALUES ('input','command','session','{}',NULL,'pending','pending',0,0)").run();
      restarted.pinInput("input", rows);
    })();
    expect(restarted.validateInput({ principal: { ...principal, deviceSessionId: "device" }, projectId: "project", sessionId: "session", artifactIds: [ref.artifactId] })).toEqual(rows);
    expect((await restarted.attachmentsForInput("input"))[0]?.filePath).toContain(getEnvironmentArtifactDir(f.dataDir));
    await restarted.sweep(Date.now() + 2 * 86_400_000);
    expect(await readdir(getEnvironmentArtifactDir(f.dataDir))).toHaveLength(1);
  });
  it("rejects cross-device/project references and streaming overflow without publishing an artifact", async () => {
    const f = await fixture(); const ref = await f.service.upload({ ...f.upload, body: f.body() });
    expect(() => f.service.validateInput({ principal: { ...principal, deviceSessionId: "other" }, projectId: "project", artifactIds: [ref.artifactId] })).toThrow();
    expect(() => f.service.validateInput({ principal, projectId: "different", artifactIds: [ref.artifactId] })).toThrow();
    async function* overflow() { yield Buffer.alloc(25 * 1024 * 1024); yield Buffer.from("overflow"); }
    await expect(f.service.upload({ ...f.upload, uploadId: randomUUID(), sizeBytes: undefined, body: overflow() })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 1 });
    expect(await readdir(getEnvironmentArtifactDir(f.dataDir))).toHaveLength(1);
  });
  it("rejects an artifact whose owned file disappeared before acceptance", async () => {
    const f = await fixture(); const ref = await f.service.upload({ ...f.upload, body: f.body() });
    const row = f.database.prepare("SELECT storage_name FROM artifacts WHERE artifact_id=?").get(ref.artifactId) as { storage_name: string };
    await rm(join(getEnvironmentArtifactDir(f.dataDir), row.storage_name));
    expect(() => f.service.validateInput({ principal, projectId: "project", artifactIds: [ref.artifactId] })).toThrow();
  });

  it("cleans interrupted and failed-commit uploads, and aborts a download when revoked", async () => {
    const f = await fixture();
    async function* interrupted() { yield Buffer.from("partial"); throw new Error("disconnect"); }
    await expect(f.service.upload({ ...f.upload, body: interrupted() })).rejects.toThrow("disconnect");
    f.database.exec("CREATE TRIGGER reject_upload BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT,'db fail'); END");
    await expect(f.service.upload({ ...f.upload, body: f.body() })).rejects.toThrow("db fail");
    expect(await readdir(getEnvironmentArtifactDir(f.dataDir))).toHaveLength(0); f.database.exec("DROP TRIGGER reject_upload");
    const ref = await f.service.upload({ ...f.upload, body: f.body() }); const controller = new AbortController();
    const download = await f.service.openDownload({ principal, artifactId: ref.artifactId, signal: controller.signal, range: "bytes=1-3" });
    controller.abort(); expect(download.stream.destroyed).toBe(true); expect(download.sizeBytes).toBe(3);
  });
  it("serves the real authenticated HTTP upload/download boundary with ranges and fail-closed credentials", async () => {
    const f = await fixture(); const resources = new Set<() => void>();
    const routes = createEnvironmentArtifactRoutes({ artifactService: f.service, access: {
      authenticateHttp: async request => { if (request.headers.authorization !== "Bearer fixture") throw Object.assign(new Error("Unauthorized fixture"), { code: "UNAUTHENTICATED" }); return principal; },
      registerResource: (_principal, close) => { resources.add(close); return () => resources.delete(close); },
    } });
    const server = createServer((request, response) => { const url = new URL(request.url!, "http://fixture"); void routes[0]!.handle(request, response, url); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}/api/v2/artifacts`;
    cleanup.unshift(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
    const headers = { authorization: "Bearer fixture", "x-forge-environment-protocol": "1", "x-forge-file-name": encodeURIComponent("fixture.txt"), "content-type": "text/plain" };
    const uploaded = await fetch(`${base}?projectId=project&uploadId=${randomUUID()}`, { method: "POST", headers, body: "fixture" });
    expect(uploaded.status).toBe(200); const artifact = await uploaded.json() as { artifactId: string };
    const download = await fetch(`${base}/${artifact.artifactId}`, { headers: { ...headers, range: "bytes=1-3" } });
    expect(download.status).toBe(206); expect(download.headers.get("content-range")).toBe("bytes 1-3/7"); expect(await download.text()).toBe("ixt");
    expect(download.headers.get("cache-control")).toBe("private, no-store"); expect(download.headers.get("content-security-policy")).toContain("sandbox");
    const denied = await fetch(`${base}/${artifact.artifactId}`, { headers: { "x-forge-environment-protocol": "1" } }); expect(denied.status).toBe(401);
    const wrongVersion = await fetch(`${base}/${artifact.artifactId}`, { headers: { authorization: "Bearer fixture", "x-forge-environment-protocol": "2" } }); expect(wrongVersion.status).toBe(409);
    expect(resources.size).toBe(0);
  });

  it("projects historical attachments to stable authenticated IDs without trusting client filesystem paths", async () => {
    const f = await fixture(); const uploads = getUploadsDir(f.dataDir); await mkdir(uploads); await writeFile(join(uploads, "legacy.txt"), "historical fixture");
    const descriptor = { role: "manager", agentId: "session", profileId: "project" } as import("../../swarm/types.js").AgentDescriptor;
    const service = createArtifactService({ database: f.database, dataDir: f.dataDir, swarmManager: { getAgentForInternalUse: id => id === "session" ? descriptor : undefined } });
    const entry = { type: "conversation_message", agentId: "session", role: "user", text: "legacy input", timestamp: new Date().toISOString(), source: "user_input", attachments: [{ type: "text", fileRef: "legacy.txt", fileName: "Legacy.txt", mimeType: "text/plain", sizeBytes: 18 }] } as import("../../swarm/types.js").ConversationEntryEvent;
    await service.prepareHistoricalArtifacts("session", [entry]); const refs = service.refsForEntry("session", entry); expect(refs).toHaveLength(1);
    await service.prepareHistoricalArtifacts("session", [entry]); expect(service.refsForEntry("session", entry)).toEqual(refs);
    const download = await service.openDownload({ principal, artifactId: refs[0]!.artifactId }); let text = ""; for await (const chunk of download.stream) text += chunk.toString(); expect(text).toBe("historical fixture");
    const unsafe = { ...entry, attachments: [{ fileRef: "../outside", mimeType: "text/plain" }] } as typeof entry;
    await service.prepareHistoricalArtifacts("session", [unsafe]); expect(service.refsForEntry("session", unsafe)).toEqual([]);
  });

});
