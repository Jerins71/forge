import { createServer } from "node:http";
import { once } from "node:events";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfiguredSqliteDatabaseConstructor } from "../../sqlite-database-loader.js";
import { createEnvironmentAccess, AccessError, canonicalPairingFields, pairingProofMessage } from "./access-service.js";
import { applyAccessMigrations } from "./access-migrations.js";
import { loadEnvironmentIdentity } from "../identity.js";
import { createExposurePolicy } from "../exposure-policy.js";
import { createEnvironmentHttpPolicy, createRouteInventory, type EnvironmentHttpRoute } from "./http-policy.js";
import type { PairingExchange, Scope } from "@forge/protocol/environment-v2";
import type { Principal } from "../control/control-types.js";

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const all: Scope[] = [
  "session:read",
  "session:operate",
  "workspace:read",
  "workspace:write",
  "terminal:operate",
  "settings:admin",
  "access:admin",
];

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "forge-access-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const identity = await loadEnvironmentIdentity({ dataDir: join(dir, "data"), installationStateDir: join(dir, "installation") });
  const Database = await loadConfiguredSqliteDatabaseConstructor();
  let db = new Database(join(dir, "access.sqlite"));
  applyAccessMigrations(db);
  cleanup.push(() => db.close());
  let now = Date.now();
  const exposure = createExposurePolicy({ host: "127.0.0.1", port: 0, allowedClientOrigins: ["https://client.test"] });
  let access = createEnvironmentAccess({ database: db, identity, exposure, clock: () => now });
  cleanup.push(() => access.dispose());
  const extraRoutes: EnvironmentHttpRoute[] = [];
  const integrationAuthenticators: Record<string, (req: import("node:http").IncomingMessage) => Promise<void>> = {};
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const routes = [...access.routes, ...extraRoutes];
    const inventory = createRouteInventory(routes);
    const policy = createEnvironmentHttpPolicy({ access, exposure, inventory, integrationAuthenticators });
    if ((await policy(req, res, url)).handled) return;
    const route = routes.find((r) => r.matches(url.pathname));
    if (route) await route.handle(req, res, url);
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => {
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  exposure.setLoopbackPort((server.address() as { port: number }).port);
  return {
    dir,
    get db() {
      return db;
    },
    identity,
    exposure,
    server,
    base,
    extraRoutes,
    integrationAuthenticators,
    get access() {
      return access;
    },
    advance(ms: number) {
      now += ms;
    },
    restart() {
      access.dispose();
      db.close();
      db = new Database(join(dir, "access.sqlite"));
      applyAccessMigrations(db);
      access = createEnvironmentAccess({ database: db, identity, exposure, clock: () => now });
    },
  };
}

async function transcript(
  h: Awaited<ReturnType<typeof harness>>,
  grant: Awaited<ReturnType<typeof h.access.createBootstrapGrant>>,
  scopes: Scope[] = all,
  delivery: "cookie" | "bearer" = "bearer",
) {
  const challenge = await (
    await fetch(`${h.base}/api/v2/access/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  ).json();
  const url = new URL(grant.pairingUrl!);
  const secret = new URLSearchParams(url.hash.slice(1)).get("secret")!;
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const input = {
    credential: { kind: "link", grantId: grant.grantId, secret },
    environmentId: h.identity.environmentId,
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    deviceName: "acceptance device",
    deviceKind: "browser",
    delivery,
    requestedScopes: scopes,
    proofKey: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! },
  } as Omit<PairingExchange, "proof">;
  const hash = createHash("sha256").update(canonicalPairingFields(input)).digest("hex");
  return {
    ...input,
    proof: sign("sha256", Buffer.from(pairingProofMessage(input, hash)), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString(
      "base64url",
    ),
  };
}
async function exchange(h: Awaited<ReturnType<typeof harness>>, input: PairingExchange, origin?: string) {
  return fetch(`${h.base}/api/v2/access/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(input),
  });
}
async function paired(h: Awaited<ReturnType<typeof harness>>, scopes: Scope[] = all, delivery: "cookie" | "bearer" = "bearer") {
  const grant = await h.access.createBootstrapGrant({ reachableBaseUrl: h.base });
  const result = await exchange(h, await transcript(h, grant, scopes, delivery), delivery === "cookie" ? h.base : undefined);
  expect(result.status).toBe(200);
  return { payload: await result.json(), cookie: result.headers.get("set-cookie")?.split(";")[0] };
}

it("one exchange wins a real HTTP race; scopes narrow, secrets never enter DB/read model, and auth survives restart", async () => {
  const h = await harness();
  const grant = await h.access.createBootstrapGrant({ reachableBaseUrl: h.base });
  const input = await transcript(h, grant, ["session:read"]);
  const responses = await Promise.all([exchange(h, input), exchange(h, input)]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
  const payload = await responses.find((r) => r.status === 200)!.json();
  expect(payload.deviceSession.scopes).toEqual(["session:read"]);
  const persisted = JSON.stringify(h.db.prepare("SELECT * FROM device_sessions").all());
  expect(persisted).not.toContain(payload.bearerToken);
  const headers = { Authorization: `Bearer ${payload.bearerToken}` };
  expect((await fetch(`${h.base}/api/v2/access/session`, { headers })).status).toBe(200);
  const ticket = await (
    await fetch(`${h.base}/api/v2/access/ws-ticket`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ audience: "rpc", protocolVersion: 2 }),
    })
  ).json();
  h.restart();
  expect((await fetch(`${h.base}/api/v2/access/session`, { headers })).status).toBe(200);
  await expect(
    h.access.consumeWsTicket({ ticket: ticket.ticket, audience: "rpc", origin: null, protocolVersion: 2 }),
  ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  const admin = await paired(h);
  const devices = await h.access.listDevices({ deviceSessionId: admin.payload.deviceSession.deviceSessionId, scopes: new Set(all) });
  expect(JSON.stringify(devices)).not.toContain(payload.bearerToken);
});

it("rejects expired/used grants and proof tampering, and prevents grant escalation", async () => {
  const h = await harness();
  const grant = await h.access.createBootstrapGrant({ reachableBaseUrl: h.base });
  const input = await transcript(h, grant);
  expect((await exchange(h, { ...input, deviceName: "tampered" })).status).toBe(401);
  h.advance(61_000);
  expect((await exchange(h, input)).status).toBe(401);
  const device = await paired(h, ["session:read"]);
  await expect(
    h.access.createGrant(
      { deviceSessionId: device.payload.deviceSession.deviceSessionId, scopes: new Set(["session:read"]) },
      { kind: "link", label: "bad", scopes: all, expiresInSeconds: 300, reachableBaseUrl: h.base },
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("cookie mutations enforce CSRF and exact Origin; public descriptor and unclassified paths leak no authority", async () => {
  const h = await harness();
  const { payload, cookie } = await paired(h, all, "cookie");
  expect(payload.bearerToken).toBeUndefined();
  expect(cookie).toContain(`forge_session_${h.identity.environmentId.replaceAll("-", "")}=`);
  const req = (extra: Record<string, string>) =>
    fetch(`${h.base}/api/v2/access/ws-ticket`, {
      method: "POST",
      headers: { Cookie: cookie!, "Content-Type": "application/json", ...extra },
      body: '{"audience":"rpc","protocolVersion":2}',
    });
  expect((await req({ Origin: h.base })).status).toBe(403);
  expect((await req({ Origin: "http://evil.test", "X-Forge-CSRF": payload.csrfToken })).status).toBe(403);
  const valid = await req({ Origin: h.base, "X-Forge-CSRF": payload.csrfToken });
  expect(valid.status).toBe(200);
  expect(
    (await fetch(`${h.base}/api/v2/access/session`, { headers: { Origin: "https://client.test", Cookie: cookie! } })).headers.get(
      "access-control-allow-origin",
    ),
  ).toBe("https://client.test");
  expect((await fetch(`${h.base}/unclassified`)).status).toBe(403);
  expect(await (await fetch(`${h.base}/api/v2/environment`)).json()).not.toHaveProperty("projects");
});

it("a ticket issued without an Origin opens from a phone socket naming its own address; browser tickets stay bound to their origin", async () => {
  // React Native's iOS and Android sockets always send Origin = the address they dial, which is neither
  // the backend's base URL nor an allowlisted browser origin. Their ticket request carries no Origin.
  const h = await harness();
  const first = await paired(h);
  const principal: Principal = { deviceSessionId: first.payload.deviceSession.deviceSessionId, scopes: new Set(all) };
  const phoneOrigin = "http://my-mac.tailnet.ts.net:47287";

  const native = await h.access.issueWsTicket(principal, { audience: "rpc", protocolVersion: 2 }, null);
  await expect(h.access.consumeWsTicket({ ticket: native.ticket, audience: "rpc", origin: phoneOrigin, protocolVersion: 2 }))
    .resolves.toMatchObject({ deviceSessionId: principal.deviceSessionId });

  const browser = await h.access.issueWsTicket(principal, { audience: "rpc", protocolVersion: 2 }, "https://client.test");
  await expect(h.access.consumeWsTicket({ ticket: browser.ticket, audience: "rpc", origin: phoneOrigin, protocolVersion: 2 }))
    .rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  const browserNull = await h.access.issueWsTicket(principal, { audience: "rpc", protocolVersion: 2 }, "https://client.test");
  await expect(h.access.consumeWsTicket({ ticket: browserNull.ticket, audience: "rpc", origin: null, protocolVersion: 2 }))
    .rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  await expect(h.access.issueWsTicket(principal, { audience: "rpc", protocolVersion: 2 }, "https://evil.test"))
    .rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("tickets use real sockets, replay fails, revocation commits then closes resources and other devices survive", async () => {
  const h = await harness();
  const first = await paired(h);
  const second = await paired(h);
  const principal: Principal = { deviceSessionId: first.payload.deviceSession.deviceSessionId, scopes: new Set(all) };
  const ticket = await h.access.issueWsTicket(principal, { audience: "rpc", protocolVersion: 2 }, null);
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has("forge.v2") ? "forge.v2" : false) });
  cleanup.push(() => wss.close());
  h.server.on("upgrade", async (req, socket, head) => {
    try {
      const value = req.headers["sec-websocket-protocol"]!.split(",")
        .map((s) => s.trim())
        .find((s) => s.startsWith("ticket."))!
        .slice(7);
      const authenticated = await h.access.consumeWsTicket({
        ticket: value,
        audience: "rpc",
        origin: req.headers.origin ?? null,
        protocolVersion: 2,
      });
      wss.handleUpgrade(req, socket, head, (ws) => {
        const unregister = h.access.registerResource(authenticated, () => ws.close(4401));
        ws.on("close", unregister);
      });
    } catch {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    }
  });
  const ws = new WebSocket(h.base.replace("http:", "ws:") + "/api/v2/rpc", ["forge.v2", `ticket.${ticket.ticket}`]);
  await once(ws, "open");
  await expect(
    h.access.consumeWsTicket({ ticket: ticket.ticket, audience: "rpc", origin: null, protocolVersion: 2 }),
  ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  const closed = once(ws, "close");
  await h.access.revokeDevice(
    { deviceSessionId: second.payload.deviceSession.deviceSessionId, scopes: new Set(all) },
    { deviceSessionId: principal.deviceSessionId },
  );
  expect((await closed)[0]).toBe(4401);
  expect(h.db.prepare("SELECT revoked_at FROM device_sessions WHERE device_session_id = ?").get(principal.deviceSessionId)).toMatchObject({
    revoked_at: expect.any(Number),
  });
  expect(
    (await fetch(`${h.base}/api/v2/access/session`, { headers: { Authorization: `Bearer ${first.payload.bearerToken}` } })).status,
  ).toBe(401);
  expect(
    (await fetch(`${h.base}/api/v2/access/session`, { headers: { Authorization: `Bearer ${second.payload.bearerToken}` } })).status,
  ).toBe(200);
});

it("rejects broader redemption scopes, limits malformed exchanges, and actively expires registered resources", async () => {
  const h = await harness();
  const admin = await paired(h);
  const principal: Principal = { deviceSessionId: admin.payload.deviceSession.deviceSessionId, scopes: new Set(all) };
  const grant = await h.access.createGrant(principal, {
    kind: "link",
    label: "read only",
    scopes: ["session:read"],
    expiresInSeconds: 60,
    reachableBaseUrl: h.base,
  });
  expect((await exchange(h, await transcript(h, grant, all))).status).toBe(403);
  const narrowed = await exchange(h, await transcript(h, grant, ["session:read"]));
  expect(narrowed.status).toBe(200);
  const device = await narrowed.json();
  const untouched = await h.access.createGrant(principal, {
    kind: "code",
    label: "pending",
    scopes: ["session:read"],
    expiresInSeconds: 300,
    reachableBaseUrl: h.base,
  });
  const other = await paired(h);
  await h.access.revokeDevice(
    { deviceSessionId: other.payload.deviceSession.deviceSessionId, scopes: new Set(all) },
    { deviceSessionId: principal.deviceSessionId },
  );
  expect(h.db.prepare("SELECT revoked_at FROM pairing_grants WHERE grant_id=?").get(untouched.grantId)).toMatchObject({
    revoked_at: expect.any(Number),
  });
  let closed = false;
  h.access.registerResource({ deviceSessionId: device.deviceSession.deviceSessionId, scopes: new Set(["session:read"]) }, () => {
    closed = true;
  });
  h.advance(30 * 24 * 60 * 60 * 1000 + 1);
  expect((await fetch(`${h.base}/api/v2/access/session`, { headers: { Authorization: `Bearer ${device.bearerToken}` } })).status).toBe(401);
  expect(closed).toBe(true);
  h.restart();
  for (let i = 0; i < 5; i++)
    expect(
      (await fetch(`${h.base}/api/v2/access/exchange`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))
        .status,
    ).toBe(400);
  expect(
    (await fetch(`${h.base}/api/v2/access/exchange`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))
      .status,
  ).toBe(429);
});

it("revocation aborts a real streaming HTTP asset response without disconnecting another device", async () => {
  const h = await harness();
  const device = await paired(h);
  const admin = await paired(h);
  let closed!: () => void;
  const assetClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  h.extraRoutes.push({
    methods: "GET",
    matches: (path) => path === "/acceptance/asset",
    access: { scopes: ["session:read"] },
    handle: async (request, response) => {
      const p = await h.access.authenticateHttp(request, "session:read", false);
      const unregister = h.access.registerResource(p, () => response.destroy());
      response.once("close", () => {
        unregister();
        closed();
      });
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write(Buffer.alloc(128, 7));
      await assetClosed;
    },
  });
  const asset = await fetch(`${h.base}/acceptance/asset`, { headers: { Authorization: `Bearer ${device.payload.bearerToken}` } });
  expect(asset.status).toBe(200);
  await h.access.revokeDevice(
    { deviceSessionId: admin.payload.deviceSession.deviceSessionId, scopes: new Set(all) },
    { deviceSessionId: device.payload.deviceSession.deviceSessionId },
  );
  await assetClosed;
  await expect(asset.arrayBuffer()).rejects.toThrow();
  expect(
    (await fetch(`${h.base}/api/v2/access/session`, { headers: { Authorization: `Bearer ${admin.payload.bearerToken}` } })).status,
  ).toBe(200);
});

it("integration credentials map to durable listed devices and neither revocation path can silently recreate authority", async () => {
  const h = await harness();
  const admin = await paired(h);
  let authenticated = 0;
  h.integrationAuthenticators.cli = async (req) => {
    if (req.headers.authorization !== "Bearer acceptance-cli-key")
      throw new AccessError("UNAUTHENTICATED", "Integration credential required");
    authenticated++;
  };
  h.extraRoutes.push({
    methods: "POST",
    matches: (path) => path === "/acceptance/cli",
    access: { integration: "cli" },
    handle: async (_request, response) => {
      try {
        const p = h.access.ensureIntegrationPrincipal({
          integration: "cli",
          credentialId: "fixture-key-id",
          label: "Acceptance CLI",
          scopes: ["session:read", "session:operate"],
        });
        h.access.authorize(p, ["session:operate"]);
        response.end(JSON.stringify({ deviceSessionId: p.deviceSessionId }));
      } catch (error) {
        response.statusCode = (error as AccessError).code === "UNAUTHENTICATED" ? 401 : 403;
        response.end();
      }
    },
  });
  const send = () => fetch(`${h.base}/acceptance/cli`, { method: "POST", headers: { Authorization: "Bearer acceptance-cli-key" } });
  expect((await fetch(`${h.base}/acceptance/cli`, { method: "POST" })).status).toBe(401);
  expect(authenticated).toBe(0);
  const first = await (await send()).json();
  h.restart();
  const second = await (await send()).json();
  expect(second).toEqual(first);
  const host = { deviceSessionId: admin.payload.deviceSession.deviceSessionId, scopes: new Set(all) };
  expect(await h.access.listDevices(host)).toContainEqual(
    expect.objectContaining({ deviceSessionId: first.deviceSessionId, kind: "cli", deviceName: "Acceptance CLI" }),
  );
  await h.access.revokeDevice(host, { deviceSessionId: first.deviceSessionId });
  expect((await send()).status).toBe(401);
  h.restart();
  expect((await send()).status).toBe(401);
  const deck = h.access.ensureIntegrationPrincipal({
    integration: "stream-deck",
    credentialId: "fixture-deck-id",
    label: "Device name",
    scopes: ["session:read", "session:operate"],
  });
  let closed = false;
  h.access.registerResource(deck, () => {
    closed = true;
  });
  h.access.revokeIntegrationPrincipal({ integration: "stream-deck", credentialId: "fixture-deck-id" });
  expect(closed).toBe(true);
  expect(() =>
    h.access.ensureIntegrationPrincipal({
      integration: "stream-deck",
      credentialId: "fixture-deck-id",
      label: "Device name",
      scopes: ["session:read"],
    }),
  ).toThrow();
});


it("mints CLI provenance from paired/integration identities and retains it through native tickets", async () => {
  const h = await harness();
  const grant = await h.access.createBootstrapGrant({ reachableBaseUrl: h.base });
  const input = await transcript(h, grant);
  input.deviceKind = "cli";
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  input.proofKey = { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! };
  const fields = { ...input, proof: undefined };
  const digest = createHash("sha256").update(canonicalPairingFields(fields)).digest("hex");
  input.proof = sign("sha256", Buffer.from(pairingProofMessage(fields, digest)), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const paired = await h.access.exchange(input, null);
  const host = { deviceSessionId: paired.deviceSession.deviceSessionId, scopes: new Set(paired.deviceSession.scopes) };
  const ticket = await h.access.issueWsTicket(host, { audience: "rpc", protocolVersion: 2 }, null);
  expect(await h.access.consumeWsTicket({ ticket: ticket.ticket, audience: "rpc", protocolVersion: 2, origin: null })).toMatchObject({ integration: "cli" });
  const deck = h.access.ensureIntegrationPrincipal({ integration: "stream-deck", credentialId: "source-deck", label: "Fixture", scopes: ["session:read"] });
  expect(deck).toMatchObject({ integration: "stream-deck" });
  h.restart();
  const after = await h.access.issueWsTicket(host, { audience: "rpc", protocolVersion: 2 }, null);
  expect(await h.access.consumeWsTicket({ ticket: after.ticket, audience: "rpc", protocolVersion: 2, origin: null })).toMatchObject({ integration: "cli" });
});
