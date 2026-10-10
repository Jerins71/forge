import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { SecureSessionSnapshot } from '@forge/protocol';
import { createEnvironmentCredentialService } from '../../../../electron/src/environment-credentials-ipc.js';
import { createTestEnvironment, environmentTestScopes } from '../../test-support/environment-auth.js';
import { getAvailablePort } from '../../test-support/index.js';
import { WsServerTestSwarmManager, bootWsServerTestManager, makeWsServerTempConfig } from '../../test-support/ws-integration-harness.js';
import { SwarmWebSocketServer } from '../server.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each(['app://forge', 'http://127.0.0.1:47588'])('Desktop IPC lists, starts, grants and revokes with renderer %s', async (clientOrigin) => {
  vi.stubEnv('FORGE_DESKTOP', '1');
  const port = await getAvailablePort();
  const config = await makeWsServerTempConfig(port, true);
  const manager = new WsServerTestSwarmManager(config);
  await bootWsServerTestManager(manager, config);
  const { environment, unreadTracker, paired } = await createTestEnvironment(manager);
  // Desktop exposure explicitly includes app://forge; this feature fixture normally has no allowed clients.
  const allowsOrigin = environment.exposure.allowsOrigin;
  vi.spyOn(environment.exposure, 'allowsOrigin').mockImplementation(origin => origin === 'app://forge' || origin === clientOrigin || allowsOrigin(origin));
  const token = 'synthetic-desktop-control-capability'.padEnd(43, 'x');
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = new SwarmWebSocketServer({ environment, unreadTracker, swarmManager: manager, host: config.host, port, secureControlToken: token });
  const snapshot: SecureSessionSnapshot = { sessionAgentId: 'manager', profileId: 'manager', revision: 0, executionMode: 'normal', environmentStatus: 'stopped', leases: [], pendingRequests: [], updatedAt: new Date().toISOString() };
  vi.spyOn(manager, 'getSecureSessionSnapshot').mockResolvedValue(snapshot);
  const start = vi.spyOn(manager, 'startSecureSession').mockResolvedValue({ ...snapshot, revision: 1, executionMode: 'secure', environmentStatus: 'ready' });
  const grant = vi.spyOn(manager, 'grantSecureSessionLease').mockResolvedValue({ ...snapshot, revision: 2 });
  const revoke = vi.spyOn(manager, 'revokeSecureSessionLease').mockResolvedValue({ ...snapshot, revision: 3 });
  const credentials = createEnvironmentCredentialService({
    storePath: join(config.paths.dataDir, 'desktop-credentials.json'), clientOrigin,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).map(b => b ^ 0x55), decryptString: value => value.map(b => b ^ 0x55).toString() },
    desktopSecureControl: () => ({ baseUrl, loopbackUrl: baseUrl, token }),
  });
  await server.start();
  try {
    const bootstrap = await environment.access.createBootstrapGrant({ reachableBaseUrl: baseUrl });
    const fragment = new URLSearchParams(new URL(bootstrap.pairingUrl!).hash.slice(1));
    expect(await credentials.pairPrimary({ baseUrl, environmentId: bootstrap.environmentId, credential: { kind: 'link', grantId: bootstrap.grantId, secret: fragment.get('secret')! }, deviceName: 'isolated Desktop transport test', requestedScopes: environmentTestScopes })).toMatchObject({ ok: true });
    const request = (path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown) => credentials.request({ environmentId: bootstrap.environmentId, path, method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
    expect(await request('/api/secure-secrets/providers')).toMatchObject({ ok: true, value: { status: 200 } });
    expect(await request('/api/secure-sessions/manager')).toMatchObject({ ok: true, value: { status: 200 } });
    expect(await request('/api/secure-sessions/manager/start', 'POST', { baseRevision: 0 })).toMatchObject({ ok: true, value: { status: 200 } });
    expect(await request('/api/secure-sessions/manager/leases', 'POST', { baseRevision: 1, secretId: 'synthetic-secret', exposures: [{ deliveryKind: 'environment', targetName: 'SYNTHETIC_TOKEN' }], leaseKind: 'task' })).toMatchObject({ ok: true, value: { status: 200 } });
    expect(await request('/api/secure-sessions/manager/leases/synthetic-lease', 'DELETE', { baseRevision: 2 })).toMatchObject({ ok: true, value: { status: 200 } });
    expect(start).toHaveBeenCalledWith('manager', { baseRevision: 0 });
    expect(grant).toHaveBeenCalledWith('manager', expect.objectContaining({ secretId: 'synthetic-secret' }));
    expect(revoke).toHaveBeenCalledWith('manager', { baseRevision: 2, leaseId: 'synthetic-lease' });
    for (const headers of [ {}, { 'x-forge-secure-control': 'wrong-capability' } ]) {
      expect((await fetch(`${baseUrl}/api/secure-sessions/manager/start`, { method: 'POST', headers: { ...paired.headers, Origin: 'app://forge', 'Content-Type': 'application/json', ...headers }, body: '{}' })).status).toBe(403);
    }
    expect(start).toHaveBeenCalledTimes(1);
    const rawDev = await fetch(`${baseUrl}/api/secure-secrets/providers`, { headers: { ...paired.headers, Origin: 'http://127.0.0.1:47588' } });
    expect(rawDev.status).toBe(403);
  } finally { await server.stop(); }
});
