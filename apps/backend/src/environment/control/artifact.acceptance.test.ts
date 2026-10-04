import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfiguredSqliteDatabaseConstructor } from "../../sqlite-database-loader.js";
import { migrateControlDatabase } from "./migrations.js";
import { createArtifactService } from "./artifact-service.js";
import { getEnvironmentArtifactDir } from "../../swarm/storage/data-paths.js";
import type { Principal } from "./control-types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const principal: Principal = { deviceSessionId: "device", scopes: new Set(["session:read", "session:operate"]) };
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "v2-artifacts-"));
  const Database = await loadConfiguredSqliteDatabaseConstructor(); const database = new Database(join(dataDir, "control.sqlite"));
  migrateControlDatabase(database, { environmentId: randomUUID(), streamEpoch: randomUUID() });
  cleanup.push(async () => { database.close(); await rm(dataDir, { recursive: true, force: true }); });
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
    f.database.exec("PRAGMA foreign_keys=OFF"); restarted.pinInput("input", rows);
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
});
