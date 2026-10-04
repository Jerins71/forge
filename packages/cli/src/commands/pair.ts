import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { PairingExchange, PairingExchangeResult, Scope } from '../../../protocol/src/environment-v2.js';
import type { CommandContext } from './types.js';
import { writeHuman } from '../output.js';

export interface CliEnvironmentCredential { environmentId: string; baseUrl: string; bearerToken: string; deviceSessionId: string }
export interface CliCredentialStore { store(credential: CliEnvironmentCredential): Promise<void> }
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function parsePairTarget(target: string): { baseUrl: string; environmentId?: string; credential?: PairingExchange['credential'] } {
  const url = new URL(target);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search) throw new Error('Pairing target must be an HTTP(S) URL without userinfo or query');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote pairing requires HTTPS');
  const fragment = new URLSearchParams(url.hash.slice(1));
  const credential = fragment.has('secret') ? { kind: 'link' as const, grantId: fragment.get('grantId') ?? '', secret: fragment.get('secret')! } : undefined;
  return { baseUrl: url.origin, environmentId: fragment.get('environmentId') ?? undefined, credential };
}
async function request(base: string, path: string, input?: unknown): Promise<unknown> {
  const result = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', ...(input === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }), signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!result.ok) throw new Error('Environment pairing request was rejected');
  return result.json();
}
export async function exchangePairing(options: { baseUrl: string; environmentId: string; credential: PairingExchange['credential']; deviceName: string; deviceKind: 'cli' | 'desktop'; scopes: Scope[] }): Promise<PairingExchangeResult> {
  const challenge = await request(options.baseUrl, '/api/v2/access/challenge', {}) as { challengeId: string; nonce: string };
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const fields: Omit<PairingExchange, 'proof'> = { credential: options.credential, environmentId: options.environmentId, challengeId: challenge.challengeId, nonce: challenge.nonce, deviceName: options.deviceName, deviceKind: options.deviceKind, delivery: 'bearer', requestedScopes: options.scopes, proofKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } };
  const digest = createHash('sha256').update(canonicalJson(fields)).digest('hex');
  const transcript = `forge-pair-v1\n${fields.environmentId}\n${fields.challengeId}\n${fields.nonce}\n${digest}`;
  const proof = sign('sha256', Buffer.from(transcript), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return request(options.baseUrl, '/api/v2/access/exchange', { ...fields, proof }) as Promise<PairingExchangeResult>;
}
async function storeOsCredential(credential: CliEnvironmentCredential): Promise<void> {
  if (process.platform === 'darwin') {
    // security's interactive mode accepts the secret through stdin, never argv.
    await runWithPrivateInput('/usr/bin/security', ['-i'], `add-generic-password -U -a ${credential.deviceSessionId} -s forge.environment.${credential.environmentId} -w ${credential.bearerToken}\n`);
    return;
  }
  if (process.platform === 'linux') {
    await runWithPrivateInput('secret-tool', ['store', '--label=Forge environment', 'application', 'Forge', 'environment', credential.environmentId], credential.bearerToken);
    return;
  }
  // Windows fallback is explicit rather than assuming a globally available vault implementation.
  throw new Error('OS credential storage is unavailable; explicitly supply --credential-file <absolute-file> for owner-only fallback storage');
}
async function runWithPrivateInput(command: string, args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => { const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }); child.on('error', () => reject(new Error('OS credential storage is unavailable; explicitly supply --credential-file <absolute-file>'))); child.on('exit', code => code === 0 ? resolve() : reject(new Error('OS credential storage failed; explicitly supply --credential-file <absolute-file>'))); child.stdin.end(input); });
}
export async function pairEnvironment(options: { target: string; code?: string; credentialFile?: string; credentialStore?: CliCredentialStore; expectedEnvironmentId?: string; deviceName?: string; scopes?: Scope[] }) {
  if (options.credentialFile && !isAbsolute(options.credentialFile)) throw new Error('Credential fallback file must be absolute');
  if (!options.credentialFile && !options.credentialStore && process.platform === 'win32') throw new Error('Explicit --credential-file fallback is required when OS credential storage is unavailable');
  const parsed = parsePairTarget(options.target);
  const credential = parsed.credential ?? (options.code ? { kind: 'code' as const, code: options.code } : undefined);
  if (!credential) throw new Error('A hidden pairing link or code is required');
  const environment = await request(parsed.baseUrl, '/api/v2/environment') as { environmentId: string; protocolVersion: number };
  const expected = options.expectedEnvironmentId ?? parsed.environmentId;
  if (expected && expected !== environment.environmentId) throw new Error('Environment identity mismatch; explicitly pair the new environment');
  if (environment.protocolVersion !== 1) throw new Error('Environment protocol version does not match');
  // Reserve fallback destination before consuming a one-use grant. Refuse symlinks/overwrite.
  const file = options.credentialFile ? await open(options.credentialFile, 'wx', 0o600) : null;
  try {
    const result = await exchangePairing({ baseUrl: parsed.baseUrl, environmentId: environment.environmentId, credential, deviceName: options.deviceName ?? 'Forge CLI', deviceKind: 'cli', scopes: options.scopes ?? ['session:read', 'session:operate', 'workspace:read', 'workspace:write', 'terminal:operate', 'settings:admin', 'access:admin'] });
    if (!result.bearerToken || !/^[A-Za-z0-9_-]{43}$/.test(result.bearerToken) || result.environment.environmentId !== environment.environmentId) throw new Error('Environment pairing returned an invalid session');
    const saved = { environmentId: environment.environmentId, baseUrl: parsed.baseUrl, bearerToken: result.bearerToken, deviceSessionId: result.deviceSession.deviceSessionId };
    if (file) { await file.writeFile(JSON.stringify(saved) + '\n'); await file.sync(); }
    else await (options.credentialStore?.store(saved) ?? storeOsCredential(saved));
    return { environment: result.environment, deviceSession: result.deviceSession };
  } finally { await file?.close(); }
}
export async function loadCliCredential(path: string): Promise<CliEnvironmentCredential> {
  if (!isAbsolute(path)) throw new Error('Credential file must be absolute');
  const info = await stat(path);
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Credential file must be owner-only');
  const value = JSON.parse(await readFile(path, 'utf8')) as CliEnvironmentCredential;
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value.bearerToken)) throw new Error('Invalid credential file');
  return value;
}
export async function readHiddenPairingInput(): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY || !process.stdin.setRawMode) throw new Error('Pairing secret requires an interactive terminal');
  process.stderr.write('Pairing link or code: ');
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let input = '';
    const finish = (error?: Error) => { process.stdin.off('data', onData); process.stdin.setRawMode(wasRaw); process.stdin.pause(); process.stderr.write('\n'); if (error) reject(error); else resolve(input); };
    const onData = (chunk: Buffer) => { for (const c of chunk.toString()) { if (c === '\u0003') { finish(new Error('Pairing cancelled')); return; } if (c === '\r' || c === '\n') { finish(); return; } if (c === '\u007f' || c === '\b') input = input.slice(0, -1); else if (input.length < 4096) input += c; } };
    process.stdin.on('data', onData);
  });
}
export async function handlePairCommand(context: CommandContext): Promise<number> {
  const target = context.args.positionals[1]; if (!target) throw new Error('Usage: forge pair <url-or-host> [--credential-file <absolute-file>]');
  const parsed = parsePairTarget(target.includes('://') ? target : `https://${target}`);
  const secret = parsed.credential ? target : await readHiddenPairingInput();
  const result = await pairEnvironment({ target: secret.includes('://') ? secret : parsed.baseUrl, code: secret.includes('://') ? undefined : secret, expectedEnvironmentId: context.args.options.environmentId ?? parsed.environmentId, credentialFile: context.args.options.credentialFile, deviceName: context.args.options.name, scopes: context.args.options.scopes?.split(',') as Scope[] | undefined });
  writeHuman(context.io, context.args.options, `Paired with ${result.environment.label} (${result.environment.environmentId}).`); return 0;
}
