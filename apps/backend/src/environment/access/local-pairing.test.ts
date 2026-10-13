// Ways the local pairing channel could fail, each pinned below:
// - a local process that cannot read the data directory issues a link (token check);
// - the endpoint file is readable by other users (0600);
// - a stale file left by a crashed backend hangs or misleads the CLI (clear "not running" error);
// - a malformed, oversized or out-of-range request crashes the backend or mints a broader grant;
// - a long data directory path exceeds the Unix socket limit (fallback endpoint);
// - stopping the backend leaves the endpoint behind;
// - the issued link does not pair (it must redeem through the ordinary exchange, once).
import { connect } from "node:net";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PairingExchange, Scope } from "@forge/protocol/environment-v2";
import { loadConfiguredSqliteDatabaseConstructor } from "../../sqlite-database-loader.js";
import { getLocalPairingEndpointPath } from "../../swarm/storage/data-paths.js";
import { loadEnvironmentIdentity } from "../identity.js";
import { createExposurePolicy } from "../exposure-policy.js";
import { applyAccessMigrations } from "./access-migrations.js";
import { canonicalPairingFields, createEnvironmentAccess, pairingProofMessage } from "./access-service.js";
import { requestLocalPairingGrant, startLocalPairingChannel } from "./local-pairing.js";

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function environment(dataDirName = "data", publicBaseUrl?: string) {
  const root = await mkdtemp(join(tmpdir(), "forge-local-pair-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, dataDirName);
  const identity = await loadEnvironmentIdentity({ dataDir, installationStateDir: join(root, "installation") });
  const Database = await loadConfiguredSqliteDatabaseConstructor();
  const db = new Database(join(root, "access.sqlite"));
  applyAccessMigrations(db);
  cleanup.push(() => db.close());
  const exposure = publicBaseUrl
    ? createExposurePolicy({ host: "127.0.0.1", port: 47187, mode: "tailscale", publicBaseUrl })
    : createExposurePolicy({ host: "127.0.0.1", port: 47187 });
  const access = createEnvironmentAccess({ database: db, identity, exposure });
  cleanup.push(() => access.dispose());
  const channel = await startLocalPairingChannel({ dataDir, publicBaseUrl: exposure.publicBaseUrl, createGrant: (input) => access.createLocalGrant(input) });
  cleanup.push(() => channel.close());
  return { dataDir, identity, access, channel };
}

async function redeem(env: Awaited<ReturnType<typeof environment>>, pairingUrl: string, scopes: Scope[]) {
  const url = new URL(pairingUrl);
  const fields = new URLSearchParams(url.hash.slice(1));
  const challenge = await env.access.createChallenge();
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const input = {
    credential: { kind: "link", grantId: fields.get("grantId")!, secret: fields.get("secret")! },
    environmentId: env.identity.environmentId,
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    deviceName: "Laptop",
    deviceKind: "desktop",
    delivery: "bearer",
    requestedScopes: scopes,
    proofKey: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! },
  } as Omit<PairingExchange, "proof">;
  const hash = createHash("sha256").update(canonicalPairingFields(input)).digest("hex");
  const proof = sign("sha256", Buffer.from(pairingProofMessage(input, hash)), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return env.access.exchange({ ...input, proof }, null);
}

function rawRequest(endpoint: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("end", () => resolve(data));
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
    socket.end(line);
  });
}

it("issues a ten-minute, full-scope link to the data directory owner that pairs once through the ordinary exchange", async () => {
  const env = await environment("data", "https://dev1.tailnet.ts.net");
  const result = await requestLocalPairingGrant(env.dataDir, { kind: "link" });
  expect(result.baseUrl).toBe("https://dev1.tailnet.ts.net");
  expect(result.loopbackOnly).toBe(false);
  expect(result.grant.pairingUrl).toMatch(/^https:\/\/dev1\.tailnet\.ts\.net\/pair#v=1&environmentId=/);
  const minutes = (Date.parse(result.grant.expiresAt) - Date.now()) / 60_000;
  expect(minutes).toBeGreaterThan(9.9);
  expect(minutes).toBeLessThanOrEqual(10);
  expect(result.grant.scopes).toContain("access:admin");
  const paired = await redeem(env, result.grant.pairingUrl!, ["session:read", "access:admin"]);
  expect(paired.environment.environmentId).toBe(env.identity.environmentId);
  await expect(redeem(env, result.grant.pairingUrl!, ["session:read"])).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
});

it("honours requested scopes, expiry and code kind, and reports a loopback-only address", async () => {
  const env = await environment();
  const result = await requestLocalPairingGrant(env.dataDir, { kind: "code", scopes: ["session:read"], expiresInSeconds: 1800, label: "Phone" });
  expect(result.loopbackOnly).toBe(true);
  expect(result.baseUrl).toBe("http://127.0.0.1:47187");
  expect(result.grant.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  expect(result.grant.scopes).toEqual(["session:read"]);
  expect(Math.round((Date.parse(result.grant.expiresAt) - Date.now()) / 60_000)).toBe(30);
  await expect(requestLocalPairingGrant(env.dataDir, { kind: "link", expiresInSeconds: 30 })).rejects.toThrow(/expir/i);
  await expect(requestLocalPairingGrant(env.dataDir, { kind: "link", expiresInSeconds: 7200 })).rejects.toThrow(/expir/i);
  await expect(requestLocalPairingGrant(env.dataDir, { kind: "link", scopes: ["root" as Scope] })).rejects.toThrow(/scope/i);
});

it("keeps the endpoint file owner-only and refuses a caller that does not hold its token", async () => {
  const env = await environment();
  const file = getLocalPairingEndpointPath(env.dataDir);
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  const { endpoint } = JSON.parse(await readFile(file, "utf8")) as { endpoint: string };
  if (process.platform !== "win32" && !endpoint.startsWith("\\\\")) expect((await stat(endpoint)).mode & 0o077).toBe(0);
  const wrong = JSON.parse(await rawRequest(endpoint, `${JSON.stringify({ v: 1, token: "x".repeat(43), request: { kind: "link" } })}\n`));
  expect(wrong).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
  const malformed = JSON.parse(await rawRequest(endpoint, "not json\n"));
  expect(malformed).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  const oversized = await rawRequest(endpoint, "x".repeat(20_000));
  expect(oversized === "" || JSON.parse(oversized).ok === false).toBe(true);
  // The channel still serves the owner afterwards.
  await expect(requestLocalPairingGrant(env.dataDir, { kind: "link" })).resolves.toMatchObject({ loopbackOnly: true });
});

it("removes its endpoint on close, and the CLI says plainly when no backend is running", async () => {
  const env = await environment();
  const file = getLocalPairingEndpointPath(env.dataDir);
  await env.channel.close();
  await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(requestLocalPairingGrant(env.dataDir, { kind: "link" })).rejects.toThrow(/No running Forge/);
  // A stale file from a crashed backend fails fast with the same message.
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ formatVersion: 1, endpoint: join(env.dataDir, "gone.sock"), token: "x".repeat(43), pid: 999999 }), { mode: 0o600 });
  await expect(requestLocalPairingGrant(env.dataDir, { kind: "link" })).rejects.toThrow(/No running Forge/);
  // The next backend start replaces it.
  const again = await startLocalPairingChannel({ dataDir: env.dataDir, publicBaseUrl: "http://127.0.0.1:47187", createGrant: (input) => env.access.createLocalGrant(input) });
  cleanup.push(() => again.close());
  await expect(requestLocalPairingGrant(env.dataDir, { kind: "link" })).resolves.toMatchObject({ loopbackOnly: true });
});

it("serves a data directory whose path is too long for a Unix socket", async () => {
  const env = await environment(`data-${"x".repeat(120)}`);
  await expect(requestLocalPairingGrant(env.dataDir, { kind: "link" })).resolves.toMatchObject({ loopbackOnly: true });
});
