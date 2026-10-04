import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { loadConfiguredSqliteDatabaseConstructor } from '../../sqlite-database-loader.js';
import { createEnvironmentAccess, canonicalPairingFields, pairingProofMessage } from './access-service.js';
import { applyAccessMigrations } from './access-migrations.js';
import { loadEnvironmentIdentity } from '../identity.js';
import { createExposurePolicy } from '../exposure-policy.js';
import { createEnvironmentHttpPolicy, createRouteInventory } from './http-policy.js';
import type { PairingExchange, Scope } from '@forge/protocol/environment-v2';
import type { Principal } from '../control/control-types.js';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const all: Scope[] = ['session:read', 'session:operate', 'workspace:read', 'workspace:write', 'terminal:operate', 'settings:admin', 'access:admin'];

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'forge-access-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const identity = await loadEnvironmentIdentity({ dataDir: join(dir, 'data'), installationStateDir: join(dir, 'installation') });
  const Database = await loadConfiguredSqliteDatabaseConstructor();
  const db = new Database(join(dir, 'access.sqlite'));
  applyAccessMigrations(db);
  cleanup.push(() => db.close());
  let now = Date.now();
  const exposure = createExposurePolicy({ host: '127.0.0.1', port: 0, allowedClientOrigins: ['https://client.test'] });
  let access = createEnvironmentAccess({ database: db, identity, exposure, clock: () => now });
  cleanup.push(() => access.dispose());
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    const inventory = createRouteInventory(access.routes);
    const policy = createEnvironmentHttpPolicy({ access, exposure, inventory });
    if ((await policy(req, res, url)).handled) return;
    const route = access.routes.find(r => r.matches(url.pathname));
    if (route) await route.handle(req, res, url);
    else { res.statusCode = 404; res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => { server.closeAllConnections(); return new Promise<void>(r => server.close(() => r())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  exposure.setLoopbackPort((server.address() as { port: number }).port);
  return { dir, db, identity, exposure, server, base, get access() { return access; }, advance(ms: number) { now += ms; }, restart() { access.dispose(); access = createEnvironmentAccess({ database: db, identity, exposure, clock: () => now }); } };
}

async function transcript(h: Awaited<ReturnType<typeof harness>>, grant: Awaited<ReturnType<typeof h.access.createBootstrapGrant>>, scopes: Scope[] = all, delivery: 'cookie' | 'bearer' = 'bearer') {
  const challenge = await (await fetch(`${h.base}/api/v2/access/challenge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const url = new URL(grant.pairingUrl!);
  const secret = new URLSearchParams(url.hash.slice(1)).get('secret')!;
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const input = { credential: { kind: 'link', grantId: grant.grantId, secret }, environmentId: h.identity.environmentId, challengeId: challenge.challengeId, nonce: challenge.nonce, deviceName: 'acceptance device', deviceKind: 'browser', delivery, requestedScopes: scopes, proofKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } } as Omit<PairingExchange, 'proof'>;
  const hash = createHash('sha256').update(canonicalPairingFields(input)).digest('hex');
  return { ...input, proof: sign('sha256', Buffer.from(pairingProofMessage(input, hash)), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
}
async function exchange(h: Awaited<ReturnType<typeof harness>>, input: PairingExchange, origin?: string) {
  return fetch(`${h.base}/api/v2/access/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(input) });
}
async function paired(h: Awaited<ReturnType<typeof harness>>, scopes: Scope[] = all, delivery: 'cookie' | 'bearer' = 'bearer') {
  const grant = await h.access.createBootstrapGrant({ reachableBaseUrl: h.base });
  const result = await exchange(h, await transcript(h, grant, scopes, delivery), delivery === 'cookie' ? h.base : undefined);
  expect(result.status).toBe(200);
  return { payload: await result.json(), cookie: result.headers.get('set-cookie')?.split(';')[0] };
}

it('one exchange wins a real HTTP race; scopes narrow, secrets never enter DB/read model, and auth survives restart', async () => {
  const h = await harness();
  const grant = await h.access.createBootstrapGrant({ reachableBaseUrl: h.base });
  const input = await transcript(h, grant, ['session:read']);
  const responses = await Promise.all([exchange(h, input), exchange(h, input)]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 401]);
  const payload = await responses.find(r => r.status === 200)!.json();
  expect(payload.deviceSession.scopes).toEqual(['session:read']);
  const persisted = JSON.stringify(h.db.prepare('SELECT * FROM device_sessions').all());
  expect(persisted).not.toContain(payload.bearerToken);
  const headers = { Authorization: `Bearer ${payload.bearerToken}` };
  expect((await fetch(`${h.base}/api/v2/access/session`, { headers })).status).toBe(200);
  const ticket = await (await fetch(`${h.base}/api/v2/access/ws-ticket`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ audience: 'rpc', protocolVersion: 1 }) })).json();
  h.restart();
  expect((await fetch(`${h.base}/api/v2/access/session`, { headers })).status).toBe(200);
  await expect(h.access.consumeWsTicket({ ticket: ticket.ticket, audience: 'rpc', origin: null, protocolVersion: 1 })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  const admin = await paired(h);
  const devices = await h.access.listDevices({ deviceSessionId: admin.payload.deviceSession.deviceSessionId, scopes: new Set(all) });
  expect(JSON.stringify(devices)).not.toContain(payload.bearerToken);
});

it('rejects expired/used grants and proof tampering, and prevents grant escalation', async () => {
  const h = await harness();
  const grant = await h.access.createBootstrapGrant({ reachableBaseUrl: h.base });
  const input = await transcript(h, grant);
  expect((await exchange(h, { ...input, deviceName: 'tampered' })).status).toBe(401);
  h.advance(61_000);
  expect((await exchange(h, input)).status).toBe(401);
  const device = await paired(h, ['session:read']);
  await expect(h.access.createGrant({ deviceSessionId: device.payload.deviceSession.deviceSessionId, scopes: new Set(['session:read']) }, { kind: 'link', label: 'bad', scopes: all, expiresInSeconds: 300, reachableBaseUrl: h.base })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

it('cookie mutations enforce CSRF and exact Origin; public descriptor and unclassified paths leak no authority', async () => {
  const h = await harness();
  const { payload, cookie } = await paired(h, all, 'cookie');
  expect(payload.bearerToken).toBeUndefined();
  expect(cookie).toContain(`forge_session_${h.identity.environmentId.replaceAll('-', '')}=`);
  const req = (extra: Record<string, string>) => fetch(`${h.base}/api/v2/access/ws-ticket`, { method: 'POST', headers: { Cookie: cookie!, 'Content-Type': 'application/json', ...extra }, body: '{"audience":"rpc","protocolVersion":1}' });
  expect((await req({ Origin: h.base })).status).toBe(403);
  expect((await req({ Origin: 'http://evil.test', 'X-Forge-CSRF': payload.csrfToken })).status).toBe(403);
  const valid = await req({ Origin: h.base, 'X-Forge-CSRF': payload.csrfToken });
  expect(valid.status).toBe(200);
  expect((await fetch(`${h.base}/api/v2/access/session`, { headers: { Origin: 'https://client.test', Cookie: cookie! } })).headers.get('access-control-allow-origin')).toBe('https://client.test');
  expect((await fetch(`${h.base}/unclassified`)).status).toBe(403);
  expect(await (await fetch(`${h.base}/api/v2/environment`)).json()).not.toHaveProperty('projects');
});

it('tickets use real sockets, replay fails, revocation commits then closes resources and other devices survive', async () => {
  const h = await harness();
  const first = await paired(h);
  const second = await paired(h);
  const principal: Principal = { deviceSessionId: first.payload.deviceSession.deviceSessionId, scopes: new Set(all) };
  const ticket = await h.access.issueWsTicket(principal, { audience: 'rpc', protocolVersion: 1 }, null);
  const wss = new WebSocketServer({ noServer: true, handleProtocols: protocols => protocols.has('forge.v2') ? 'forge.v2' : false });
  cleanup.push(() => wss.close());
  h.server.on('upgrade', async (req, socket, head) => {
    try {
      const value = req.headers['sec-websocket-protocol']!.split(',').map(s => s.trim()).find(s => s.startsWith('ticket.'))!.slice(7);
      const authenticated = await h.access.consumeWsTicket({ ticket: value, audience: 'rpc', origin: req.headers.origin ?? null, protocolVersion: 1 });
      wss.handleUpgrade(req, socket, head, ws => { const unregister = h.access.registerResource(authenticated, () => ws.close(4401)); ws.on('close', unregister); });
    } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); }
  });
  const ws = new WebSocket(h.base.replace('http:', 'ws:') + '/api/v2/rpc', ['forge.v2', `ticket.${ticket.ticket}`]);
  await once(ws, 'open');
  await expect(h.access.consumeWsTicket({ ticket: ticket.ticket, audience: 'rpc', origin: null, protocolVersion: 1 })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  const closed = once(ws, 'close');
  await h.access.revokeDevice({ deviceSessionId: second.payload.deviceSession.deviceSessionId, scopes: new Set(all) }, { deviceSessionId: principal.deviceSessionId });
  expect((await closed)[0]).toBe(4401);
  expect(h.db.prepare('SELECT revoked_at FROM device_sessions WHERE device_session_id = ?').get(principal.deviceSessionId)).toMatchObject({ revoked_at: expect.any(Number) });
  expect((await fetch(`${h.base}/api/v2/access/session`, { headers: { Authorization: `Bearer ${first.payload.bearerToken}` } })).status).toBe(401);
  expect((await fetch(`${h.base}/api/v2/access/session`, { headers: { Authorization: `Bearer ${second.payload.bearerToken}` } })).status).toBe(200);
});
