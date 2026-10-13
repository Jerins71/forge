import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PairingExchange, Scope } from '@forge/protocol/environment-v2';
import { afterEach } from 'vitest';
import { loadConfiguredSqliteDatabaseConstructor } from '../sqlite-database-loader.js';
import { loadEnvironmentIdentity } from '../environment/identity.js';
import { createExposurePolicy } from '../environment/exposure-policy.js';
import { applyAccessMigrations } from '../environment/access/access-migrations.js';
import { canonicalPairingFields, createEnvironmentAccess, pairingProofMessage } from '../environment/access/access-service.js';
import { createEnvironmentService } from '../environment/environment-service.js';
import { UnreadTracker } from '../swarm/session/unread-tracker.js';
import type { SwarmManager } from '../swarm/swarm-manager.js';

export const environmentTestScopes: Scope[] = ['session:read', 'session:operate', 'workspace:read', 'workspace:write', 'terminal:operate', 'settings:admin', 'access:admin'];
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

export async function pairTestAccess(access: ReturnType<typeof createEnvironmentAccess>, baseUrl: string) {
  const grant = await access.createBootstrapGrant({ reachableBaseUrl: baseUrl });
  const challenge = await access.createChallenge('test');
  const fragment = new URLSearchParams(new URL(grant.pairingUrl!).hash.slice(1));
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const input = { environmentId: grant.environmentId, challengeId: challenge.challengeId, nonce: challenge.nonce,
    credential: { kind: 'link', grantId: grant.grantId, secret: fragment.get('secret')! },
    deviceKind: 'cli', delivery: 'bearer', deviceName: 'paired test device', requestedScopes: environmentTestScopes,
    proofKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } } as Omit<PairingExchange, 'proof'>;
  const digest = createHash('sha256').update(canonicalPairingFields(input)).digest('hex');
  const result = await access.exchange({ ...input, proof: sign('sha256', Buffer.from(pairingProofMessage(input, digest)), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }, null);
  const principal = { deviceSessionId: result.deviceSession.deviceSessionId, scopes: new Set(result.deviceSession.scopes) };
  return { principal, headers: { Authorization: `Bearer ${result.bearerToken!}` },
    protocols: async (audience: 'rpc' = 'rpc') => ['forge.v2', `ticket.${(await access.issueWsTicket(principal, { audience, protocolVersion: 2 }, null)).ticket}`],
  };
}
/** Pair through the public exchange after a private parent-owned bootstrap grant. */
export async function pairTestServer(server: import('../server.js').StartedServer) {
  const baseUrl = `http://${server.host}:${server.port}`;
  const grant = await server.createBootstrapGrant();
  const challenge = await (await fetch(`${baseUrl}/api/v2/access/challenge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json() as { challengeId: string; nonce: string };
  const fragment = new URLSearchParams(new URL(grant.pairingUrl!).hash.slice(1));
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const input = { environmentId: grant.environmentId, challengeId: challenge.challengeId, nonce: challenge.nonce,
    credential: { kind: 'link', grantId: grant.grantId, secret: fragment.get('secret')! },
    deviceKind: 'cli', delivery: 'bearer', deviceName: 'paired server fixture', requestedScopes: environmentTestScopes,
    proofKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } } as Omit<PairingExchange, 'proof'>;
  const digest = createHash('sha256').update(canonicalPairingFields(input)).digest('hex');
  const exchanged = await fetch(`${baseUrl}/api/v2/access/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, proof: sign('sha256', Buffer.from(pairingProofMessage(input, digest)), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }) });
  if (!exchanged.ok) throw new Error('Server fixture pairing denied');
  const result = await exchanged.json() as import('@forge/protocol/environment-v2').PairingExchangeResult;
  const headers = { Authorization: `Bearer ${result.bearerToken!}` };
  return { headers, protocols: async (audience: 'rpc' = 'rpc') => {
    const response = await fetch(`${baseUrl}/api/v2/access/ws-ticket`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ audience, protocolVersion: 2 }) });
    if (!response.ok) throw new Error('Server fixture ticket denied');
    return ['forge.v2', `ticket.${(await response.json() as { ticket: string }).ticket}`];
  } };
}
export async function createPairedTestAccess() {
  const root = await mkdtemp(join(tmpdir(), 'forge-paired-test-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const identity = await loadEnvironmentIdentity({ dataDir: join(root, 'data'), installationStateDir: join(root, 'installation') });
  const Constructor = await loadConfiguredSqliteDatabaseConstructor();
  const database = new Constructor(':memory:');
  applyAccessMigrations(database);
  const exposure = createExposurePolicy({ host: '127.0.0.1', port: 0, allowedClientOrigins: ['http://127.0.0.1'] });
  const access = createEnvironmentAccess({ database, identity, exposure });
  cleanup.push(() => { access.dispose(); database.close(); });
  return { access, ...await pairTestAccess(access, exposure.publicBaseUrl) };
}
export async function createTestEnvironment(manager: SwarmManager, options: { boot?: boolean } = {}): Promise<{ environment: import('../environment/environment-service.js').EnvironmentService; unreadTracker: UnreadTracker; paired: Awaited<ReturnType<typeof pairTestAccess>> }> {
  const config = manager.getConfig();
  const unreadTracker = new UnreadTracker({ dataDir: config.paths.dataDir,
    getProfileIds: () => manager.listProfiles().map(profile => profile.profileId),
    getSessionAgentIds: projectId => manager.listAgents().filter(agent => agent.role === 'manager' && (agent.profileId ?? agent.agentId) === projectId).map(agent => agent.agentId) });
  const exposure = createExposurePolicy({ host: config.host, port: config.port });
  const environment = await createEnvironmentService({ config, swarmManager: manager, unreadTracker, exposure,
    identityOptions: { installationStateDir: join(config.paths.dataDir, '.test-installation'), label: `test-${randomUUID()}` } });
  cleanup.push(() => environment.stop());
  // Restart fixtures hydrate through the installed descriptor owner, like server.ts.
  if (options.boot) await manager.boot();
  await environment.initialize();
  const paired = await pairTestAccess(environment.access, exposure.publicBaseUrl);
  return { environment, unreadTracker, paired };
}

/** Real access boundary for transport fixtures whose feature owner is deliberately fake. */
export async function createAuthOnlyTestEnvironment(host: string, port: number): Promise<{ environment: import('../environment/environment-service.js').EnvironmentService; paired: Awaited<ReturnType<typeof pairTestAccess>> }> {
  const root = await mkdtemp(join(tmpdir(), 'forge-http-auth-test-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const identity = await loadEnvironmentIdentity({ dataDir: join(root, 'data'), installationStateDir: join(root, 'installation') });
  const Constructor = await loadConfiguredSqliteDatabaseConstructor();
  const database = new Constructor(':memory:');
  const { migrateControlDatabase } = await import('../environment/control/migrations.js');
  const { createEventSink } = await import('../environment/control/event-sink.js');
  const { createShellStream } = await import('../environment/streams/shell-stream.js');
  const { createDetailStream } = await import('../environment/streams/detail-stream.js');
  const { createEnvironmentRpcServer } = await import('../ws/rpc/rpc-server.js');
  migrateControlDatabase(database, { environmentId: identity.environmentId, streamEpoch: identity.file.streamEpoch });
  applyAccessMigrations(database);
  const exposure = createExposurePolicy({ host, port });
  const access = createEnvironmentAccess({ database, identity, exposure });
  const eventSink = createEventSink(database, Date.now, randomUUID);
  const unavailable = () => { throw new Error('This feature fixture does not execute control effects'); };
  const control = { submitInput: async () => unavailable(), record: () => unavailable(), execute: async () => unavailable(), getReceipt: async () => unavailable(), admitLifecycle: async <T>(_principal: unknown, _input: unknown, operation: () => Promise<T>) => operation(), close: async () => {} };
  let rpc: ReturnType<typeof createEnvironmentRpcServer> | undefined;
  const environment: import('../environment/environment-service.js').EnvironmentService = {
    database, access, control, exposure, descriptor: identity.descriptor, routes: access.routes,
    initialize: async () => {}, start: () => {},
    composeTransport(sessionFeatures) {
      sessionFeatures.setEnvironmentControl({ access, control });
      const deps = { database, subscribeCommitted: eventSink.subscribe, getDescriptor: identity.descriptor };
      const terminalTransport = { issueTicket: unavailable, attach: unavailable, input: async () => unavailable(), resize: async () => unavailable(), closeDevice: async () => {} };
      rpc = createEnvironmentRpcServer({ access, control, shellStream: createShellStream(deps), detailStream: createDetailStream(deps),
        terminalTransport });
      return { rpc, terminalTransport };
    },
    async stop() { await rpc?.stop(); access.dispose(); eventSink.close(); if (database.open) database.close(); },
  };
  cleanup.push(() => environment.stop());
  return { environment, paired: await pairTestAccess(access, exposure.publicBaseUrl) };
}
