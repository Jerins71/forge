import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { getHostInstallationStateDir } from '../../backend/src/swarm/storage/data-paths.js';
import { dirname, join } from 'node:path';
import type { RpcOutput, Scope } from '@forge/protocol/environment-v2';
import type { EnvironmentCredentialService, DesktopEnvironmentTarget } from './environment-credentials-ipc.js';

export const ENVIRONMENT_BOOTSTRAP_REQUEST = 'forge:environment-bootstrap:request';
export const ENVIRONMENT_BOOTSTRAP_RESULT = 'forge:environment-bootstrap:result';
type BootstrapGrant = RpcOutput<'access.grant.create'>;
const scopes: Scope[] = ['session:read', 'session:operate', 'workspace:read', 'workspace:write', 'terminal:operate', 'settings:admin', 'access:admin'];
export async function requestEnvironmentBootstrap(child: Pick<ChildProcess, 'send' | 'on' | 'off'>, timeoutMs = 15_000): Promise<BootstrapGrant> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); child.off('disconnect', onExit); };
    const fail = (message: string) => { clean(); reject(new Error(message)); };
    const onExit = () => fail('Private environment bootstrap channel closed');
    const onMessage = (value: unknown) => {
      const m = value as { type?: string; requestId?: string; grant?: BootstrapGrant; error?: unknown };
      if (!m || m.type !== ENVIRONMENT_BOOTSTRAP_RESULT || m.requestId !== requestId) return;
      if (m.error || !m.grant?.pairingUrl || !m.grant.environmentId) { fail('Private environment bootstrap was rejected'); return; }
      clean(); resolve(m.grant);
    };
    const timer = setTimeout(() => fail('Private environment bootstrap timed out'), timeoutMs);
    child.on('message', onMessage); child.on('exit', onExit); child.on('disconnect', onExit);
    try { child.send?.({ type: ENVIRONMENT_BOOTSTRAP_REQUEST, requestId }, error => { if (error) fail('Private environment bootstrap channel failed'); }); } catch { fail('Private environment bootstrap channel failed'); }
  });
}
/** Physical parent only. A renderer has no route to this operation. */
export async function ensurePrimaryEnvironmentSession(options: { child: Pick<ChildProcess, 'send' | 'on' | 'off'>; baseUrl: string; credentials: EnvironmentCredentialService }): Promise<DesktopEnvironmentTarget> {
  const existing = await options.credentials.primary();
  if (!existing.ok) throw new Error(existing.error.message);
  if (existing.value) {
    const rebinding = await options.credentials.rebindPrimary(options.baseUrl);
    if (!rebinding.ok && rebinding.error.code === 'IDENTITY_MISMATCH') throw new Error(rebinding.error.message);
    if (rebinding.ok && rebinding.value) { const current = await options.credentials.session(rebinding.value.environmentId); if (current.ok) return rebinding.value; if (current.error.code !== 'UNAUTHENTICATED') throw new Error(current.error.message); }
  }
  const grant = await requestEnvironmentBootstrap(options.child);
  const link = new URL(grant.pairingUrl!); const fragment = new URLSearchParams(link.hash.slice(1));
  if (link.origin !== new URL(options.baseUrl).origin || fragment.get('environmentId') !== grant.environmentId || !/^[A-Za-z0-9_-]{43}$/.test(fragment.get('secret') ?? '')) throw new Error('Private environment bootstrap returned an invalid grant');
  const result = await options.credentials.pairPrimary({ baseUrl: options.baseUrl, environmentId: grant.environmentId, credential: { kind: 'link', grantId: fragment.get('grantId') ?? '', secret: fragment.get('secret')! }, deviceName: 'Forge Desktop', requestedScopes: scopes });
  if (!result.ok) throw new Error(result.error.message);
  const primary = await options.credentials.primary();
  if (!primary.ok || !primary.value) throw new Error('Primary environment session was not saved');
  return primary.value;
}
/** Install metadata contains executable locations only, outside all environment roots. */
export async function writeEnvironmentInstallationManifest(backendEntry: string): Promise<void> {
  const dir = getHostInstallationStateDir();
  const path = join(dir, 'manifest.json'); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`; const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify({ formatVersion: 1, backendEntry }) + '\n'); await file.sync(); } finally { await file.close(); }
  try { await rename(temp, path); } finally { await rm(temp, { force: true }); }
}
