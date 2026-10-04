import { randomUUID, createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { PairingExchange, PairingExchangeResult, RpcOutput, Scope } from '@forge/protocol/environment-v2';
import { canonicalPairingFields, pairingProofMessage } from '../../../apps/backend/src/environment/access/access-service.js';
import type { BootstrapSession, EnvironmentFixture } from '../launch.js';

export const fixtureScopes: Scope[] = ['session:read', 'session:operate', 'workspace:read', 'workspace:write', 'terminal:operate', 'settings:admin', 'access:admin'];
export async function redeemFixtureGrant(environment: EnvironmentFixture, grant: RpcOutput<'access.grant.create'>, mode: 'link' | 'code' = 'link', requestedScopes: Scope[] = fixtureScopes): Promise<BootstrapSession> {
  const descriptor = await (await fetch(`${environment.baseUrl}/api/v2/environment`)).json();
  const challenge = await (await fetch(`${environment.baseUrl}/api/v2/access/challenge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const fragment = new URLSearchParams(new URL(grant.pairingUrl ?? environment.baseUrl).hash.slice(1));
  const credential: PairingExchange['credential'] = mode === 'link' ? { kind: 'link', grantId: grant.grantId, secret: fragment.get('secret')! } : { kind: 'code', code: grant.code! };
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const input = { environmentId: descriptor.environmentId, challengeId: challenge.challengeId, nonce: challenge.nonce,
    credential, deviceKind: 'desktop', deviceName: `Fixture ${environment.name}`, delivery: 'bearer', requestedScopes,
    proofKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } } as Omit<PairingExchange, 'proof'>;
  const hash = createHash('sha256').update(canonicalPairingFields(input)).digest('hex');
  const response = await fetch(`${environment.baseUrl}/api/v2/access/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, proof: sign('sha256', Buffer.from(pairingProofMessage(input, hash)), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }) });
  if (!response.ok) throw Object.assign(new Error(`Fixture pairing failed (${response.status})`), { code: 'UNAUTHENTICATED' });
  const result = await response.json() as PairingExchangeResult;
  if (!result.bearerToken || result.environment.environmentId !== descriptor.environmentId) throw new Error('Fixture pairing identity mismatch');
  return { environmentId: result.environment.environmentId, label: result.environment.label, bearer: result.bearerToken, deviceSession: result.deviceSession, environment: result.environment };
}
export async function bootstrapFixtureChild(child: ChildProcess, environment: EnvironmentFixture): Promise<BootstrapSession> {
  const requestId = randomUUID();
  const grant = await new Promise<RpcOutput<'access.grant.create'>>((resolveGrant, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Private fixture bootstrap timed out')); }, 10_000);
    const handler = (message: unknown) => {
      const result = message as { type?: string; requestId?: string; grant?: RpcOutput<'access.grant.create'> };
      if (result?.type !== 'forge:environment-bootstrap:result' || result.requestId !== requestId) return;
      cleanup(); if (result.grant) resolveGrant(result.grant); else reject(new Error('Private fixture bootstrap unavailable'));
    };
    const cleanup = () => { clearTimeout(timeout); child.off('message', handler); };
    child.on('message', handler);
    child.send({ type: 'forge:environment-bootstrap:request', requestId }, error => { if (error) { cleanup(); reject(error); } });
  });
  return redeemFixtureGrant(environment, grant);
}
