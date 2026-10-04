import type { RpcOutput } from '@forge/protocol/environment-v2';
import type { BootstrapSession, EnvironmentFixture } from '../launch.js';
import { redeemFixtureGrant, fixtureScopes } from './pairing.js';

// Served code contains only bridge operations. Credentials stay in the Node closure below.
export const fixturePlatformScript = `(() => {
  const call = async (operation, input) => {
    const response = await fetch('/__forge_e2e_platform', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({operation,input})});
    return response.json();
  };
  window.__forgeE2EPlatform = {
    environmentCredentials: {
      primary: () => call('primary'), list: () => call('list'), pair: input => call('pair',input),
      session: environmentId => call('session',{environmentId}),
      wsTicket: (environmentId,audience,protocolVersion) => call('wsTicket',{environmentId,audience,protocolVersion}),
      request: input => call('request',input),
      uploadArtifact: input => call('uploadArtifact',{...input,bytes:Array.from(input.bytes)}),
      artifact: async input => {const result=await call('artifact',input); if(result.ok)result.value.bytes=new Uint8Array(result.value.bytes); return result;},
      remove: environmentId => call('remove',{environmentId})
    },
    environmentPersistence: {load:input=>call('load',input),save:input=>call('save',input),clear:input=>call('clear',input)}
  };
})();`;

export function createFixturePlatform(environments: EnvironmentFixture[], primary: { environmentId: string }, first: BootstrapSession, clientOrigin: () => string) {
  const sessions = new Map([[first.environmentId, first]]);
  const records = new Map<string, string>();
  const target = (id: string) => {
    const session = sessions.get(id);
    const environment = environments.find(environment => environment.environment?.environmentId === id);
    if (!session || !environment) throw new Error('Unknown paired fixture target');
    return { session, environment };
  };
  const metadata = (session: BootstrapSession) => {
    const { environment } = target(session.environmentId); const device = session.deviceSession!;
    return { environmentId: session.environmentId, baseUrl: environment.baseUrl, label: session.label!, primary: session.environmentId === primary.environmentId,
      deviceSessionId: device.deviceSessionId, deviceName: device.deviceName, scopes: device.scopes, pairedAt: device.createdAt, expiresAt: device.expiresAt };
  };
  return async (operation: string, value: unknown): Promise<unknown> => {
    const input = (value ?? {}) as Record<string, any>;
    if (operation === 'primary') return metadata(first);
    if (operation === 'list') return [...sessions.values()].map(metadata);
    if (operation === 'pair') {
      const environment = environments.find(environment => environment.baseUrl === input.baseUrl);
      if (input.expectedEnvironmentId && input.expectedEnvironmentId !== environment?.environment?.environmentId) throw new Error('Pairing target mismatch');
      if (!environment) throw new Error('Pairing target mismatch');
      const credential = input.credential;
      const grant: RpcOutput<'access.grant.create'> = { environmentId: environment.environment!.environmentId, grantId: credential.grantId ?? '00000000-0000-4000-8000-000000000000',
        expiresAt: new Date().toISOString(), scopes: fixtureScopes, code: credential.kind === 'code' ? credential.code : null,
        pairingUrl: credential.kind === 'link' ? `${environment.baseUrl}/pair#secret=${credential.secret}` : null };
      const session = await redeemFixtureGrant(environment, grant, credential.kind, input.requestedScopes);
      sessions.set(session.environmentId, session);
      return { environment: session.environment, deviceSession: session.deviceSession };
    }
    const { environment, session } = target(input.environmentId);
    if (operation === 'remove') { sessions.delete(input.environmentId); for (const key of records.keys()) if (key.startsWith(input.environmentId + ':')) records.delete(key); return { removed: true }; }
    if (operation === 'clear') { for (const key of records.keys()) if (key.startsWith(input.environmentId + ':')) records.delete(key); return; }
    if (operation === 'load' || operation === 'save') {
      if (input.deviceSessionId && input.deviceSessionId !== session.deviceSession?.deviceSessionId || !['shell', 'pending'].includes(input.key)) throw new Error('Persistence scope mismatch');
      const key = `${input.environmentId}:${session.deviceSession!.deviceSessionId}:${input.key}`;
      if (operation === 'load') return records.get(key) ?? null;
      if (typeof input.value !== 'string' || Buffer.byteLength(input.value) > (input.key === 'pending' ? 262144 : 8388608) || input.value.includes(session.bearer)) throw new Error('Persistence budget/credential violation');
      records.set(key, input.value); return;
    }
    const headers = { Authorization: `Bearer ${session.bearer}`, Origin: clientOrigin(), 'x-forge-environment-protocol': '1' };
    let response: Response;
    if (operation === 'session') response = await fetch(`${environment.baseUrl}/api/v2/access/session`, { headers });
    else if (operation === 'wsTicket') response = await fetch(`${environment.baseUrl}/api/v2/access/ws-ticket`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ audience: input.audience, protocolVersion: input.protocolVersion }) });
    else if (operation === 'request') {
      if (typeof input.path !== 'string' || !input.path.startsWith('/api/') || input.path.startsWith('/api/v2/access') || input.path.includes('://')) throw new Error('Invalid feature path');
      const supplied = { ...input.headers }; delete supplied.authorization; delete supplied.Authorization;
      response = await fetch(`${environment.baseUrl}${input.path}`, { method: input.method, headers: { ...supplied, ...headers }, body: input.body, redirect: 'error' });
      return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
    } else if (operation === 'uploadArtifact') {
      const bytes = new Uint8Array(input.bytes);
      if (bytes.byteLength > 26214400) throw new Error('Artifact too large');
      response = await fetch(`${environment.baseUrl}/api/v2/artifacts?projectId=${encodeURIComponent(input.projectId)}&uploadId=${encodeURIComponent(input.uploadId)}`, { method: 'POST', headers: { ...headers, 'Content-Type': input.mimeType, 'x-forge-file-name': encodeURIComponent(input.fileName) }, body: bytes });
    } else if (operation === 'artifact') {
      response = await fetch(`${environment.baseUrl}/api/v2/artifacts/${encodeURIComponent(input.artifactId)}`, { headers: { ...headers, ...(input.range ? { Range: input.range } : {}) } });
      if (!response.ok) throw new Error('Artifact unavailable');
      return { bytes: [...new Uint8Array(await response.arrayBuffer())], mimeType: response.headers.get('content-type') ?? 'application/octet-stream', fileName: 'fixture' };
    } else throw new Error('Unknown fixture bridge operation');
    if (!response.ok) throw new Error(`Fixture platform HTTP ${response.status}`);
    return response.json();
  };
}
