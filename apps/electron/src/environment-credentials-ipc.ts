import { randomUUID, generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PairingExchange, EnvironmentDescriptor, DeviceSession, Scope, ArtifactRef } from '@forge/protocol/environment-v2';

export const ENVIRONMENT_PERSISTENCE_CHANNEL = 'forge:environment-persistence';
export const ENVIRONMENT_CREDENTIALS_CHANNEL = 'forge:environment-credentials';
export const ENVIRONMENT_ARTIFACT_SCHEME = 'forge-artifact';
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface EnvironmentCredentialError { code: 'INVALID_INPUT' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'IDENTITY_MISMATCH' | 'UNAVAILABLE' | 'INTERNAL'; message: string; retryable: boolean }
export type EnvironmentCredentialResult<T> = { ok: true; value: T } | { ok: false; error: EnvironmentCredentialError };
export interface DesktopEnvironmentTarget { environmentId: string; baseUrl: string; label: string; primary: boolean; deviceSessionId:string; deviceName:string; scopes:Scope[]; pairedAt:string; expiresAt:string }
export interface EnvironmentPairInput { baseUrl: string; environmentId: string; credential: PairingExchange['credential']; deviceName: string; requestedScopes: Scope[] }
export interface EnvironmentHttpInput { environmentId: string; path: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; headers?: Record<string, string>; body?: string }
export interface EnvironmentBinaryHttpInput extends Omit<EnvironmentHttpInput, 'body'> { body?: Uint8Array; maxBytes: number }
export interface EnvironmentArtifactInput { environmentId: string; artifactId: string; range?: string }
export interface EnvironmentUploadInput { environmentId: string; projectId: string; uploadId: string; fileName: string; mimeType: string; bytes: Uint8Array }
export interface EnvironmentCredentialsBridge {
  primary(): Promise<EnvironmentCredentialResult<DesktopEnvironmentTarget | null>>;
  list(): Promise<EnvironmentCredentialResult<DesktopEnvironmentTarget[]>>;
  pair(input: EnvironmentPairInput): Promise<EnvironmentCredentialResult<{ environment: EnvironmentDescriptor; deviceSession: DeviceSession }>>;
  session(environmentId: string): Promise<EnvironmentCredentialResult<{ deviceSession: DeviceSession }>>;
  wsTicket(environmentId: string, audience: 'rpc' | 'legacy', protocolVersion: number): Promise<EnvironmentCredentialResult<{ ticket: string; expiresAt: string }>>;
  request(input: EnvironmentHttpInput): Promise<EnvironmentCredentialResult<{ status: number; headers: Record<string, string>; body: string }>>;
  requestBinary(input: EnvironmentBinaryHttpInput): Promise<EnvironmentCredentialResult<{ status: number; headers: Record<string, string>; bytes: Uint8Array }>>;
  uploadArtifact(input: EnvironmentUploadInput): Promise<EnvironmentCredentialResult<ArtifactRef>>;
  artifact(input: EnvironmentArtifactInput): Promise<EnvironmentCredentialResult<{ bytes: Uint8Array; mimeType: string; fileName: string }>>;
  remove(environmentId: string): Promise<EnvironmentCredentialResult<{ removed: boolean }>>;
}
export interface EnvironmentSafeStorage {
  isEncryptionAvailable?(): boolean;
  isAsyncEncryptionAvailable?(): Promise<boolean>;
  getSelectedStorageBackend?(): string;
  encryptString?(plainText: string): Buffer;
  decryptString?(encrypted: Buffer): string;
  encryptStringAsync?(plainText: string): Promise<Buffer>;
  decryptStringAsync?(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}
export interface EnvironmentPersistenceInput { environmentId: string; deviceSessionId?: string; key: 'shell' | 'pending' }
export interface EnvironmentPersistenceBridge {
  load(input: EnvironmentPersistenceInput): Promise<EnvironmentCredentialResult<string | null>>;
  save(input: EnvironmentPersistenceInput & {value: string}): Promise<EnvironmentCredentialResult<void>>;
  clear(input: {environmentId: string}): Promise<EnvironmentCredentialResult<void>>;
}
interface StoredTarget extends DesktopEnvironmentTarget { bearerToken: string }
class CredentialFailure extends Error {
  constructor(readonly code: EnvironmentCredentialError['code'], message: string, readonly retryable = false) { super(message); }
}
const fail = (code: EnvironmentCredentialError['code'], message: string): never => { throw new CredentialFailure(code, message); };
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`; return JSON.stringify(value); }
function targetUrl(value: string): string {
  let url: URL; try { url = new URL(value); } catch { return fail('INVALID_INPUT', 'Invalid environment URL'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail('INVALID_INPUT', 'Environment URL must be an HTTPS origin or direct loopback HTTP');
  return url.origin;
}
async function boundedBytes(response: Response, maximum = MAX_ARTIFACT_BYTES): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length') ?? 0) > maximum) { await response.body?.cancel(); return fail('INVALID_INPUT', 'Environment response exceeds its byte limit'); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > maximum) { await reader.cancel(); return fail('INVALID_INPUT', 'Environment response exceeds its byte limit'); } parts.push(chunk.value); } }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(bytes); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result;
}
function publicTarget(value: StoredTarget): DesktopEnvironmentTarget { return { environmentId: value.environmentId, baseUrl: value.baseUrl, label: value.label, primary: value.primary, deviceSessionId:value.deviceSessionId,deviceName:value.deviceName,scopes:[...value.scopes],pairedAt:value.pairedAt,expiresAt:value.expiresAt }; }
export function createEnvironmentCredentialService(options: { storePath: string; safeStorage: EnvironmentSafeStorage; fetch?: typeof fetch }) {
  const fetcher = options.fetch ?? fetch;
  let targets: StoredTarget[] | null = null;
  let writes = Promise.resolve();
  let mutations = Promise.resolve();
  let runtimeWrites = Promise.resolve();
  let runtime: Record<string, string> | null = null;
  let loading: Promise<StoredTarget[]> | null = null;
  const runtimePath = options.storePath + '.runtime';
  function mutate<T>(fn: () => Promise<T>): Promise<T> { const result = mutations.then(fn); mutations = result.then(() => undefined, () => undefined); return result; }
  function runtimeMutation<T>(fn: () => Promise<T>): Promise<T> { const result = runtimeWrites.then(fn); runtimeWrites = result.then(() => undefined, () => undefined); return result; }
  async function checkStorage() { const s = options.safeStorage; const available = s.isAsyncEncryptionAvailable ? await s.isAsyncEncryptionAvailable() : s.isEncryptionAvailable?.(); if (!available || s.getSelectedStorageBackend?.() === 'basic_text') fail('UNAVAILABLE', 'Encrypted OS credential storage is unavailable'); }
  async function load(): Promise<StoredTarget[]> {
    await checkStorage(); if (targets) return targets;
    if (loading) return loading;
    loading = (async () => {
    try {
      const data = JSON.parse(await readFile(options.storePath, 'utf8')) as { formatVersion: number; ciphertext: string };
      if (data.formatVersion !== 1 || typeof data.ciphertext !== 'string') fail('UNAVAILABLE', 'Environment credential storage is invalid');
      const encrypted = Buffer.from(data.ciphertext, 'base64');
      const s = options.safeStorage;
      const plain = s.decryptStringAsync ? (await s.decryptStringAsync(encrypted)).result : s.decryptString?.(encrypted);
      const decoded = JSON.parse(plain ?? '') as StoredTarget[];
      if (!Array.isArray(decoded) || decoded.some(t => !UUID.test(t.environmentId) || typeof t.label!=='string' || t.label.length<1 || t.label.length>80 || !UUID.test(t.deviceSessionId) || !Array.isArray(t.scopes) || t.scopes.length<1 || t.scopes.length>7 || typeof t.deviceName!=='string' || t.deviceName.length>80 || !Number.isFinite(Date.parse(t.pairedAt)) || !Number.isFinite(Date.parse(t.expiresAt)) || !/^[A-Za-z0-9_-]{43}$/.test(t.bearerToken) || targetUrl(t.baseUrl) !== t.baseUrl)) fail('UNAVAILABLE', 'Environment credential storage is invalid');
      targets = decoded;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') targets = []; else if (error instanceof CredentialFailure) throw error; else fail('UNAVAILABLE', 'Environment credentials could not be decrypted'); }
    return targets!;
    })();
    try { return await loading; } finally { loading = null; }
  }
  async function save() {
    const snapshot = JSON.stringify(targets);
    const write = writes.then(async () => {
      await checkStorage();
      const s = options.safeStorage;
      const encrypted = s.encryptStringAsync ? await s.encryptStringAsync(snapshot) : s.encryptString?.(snapshot);
      if (!encrypted?.length) return fail('UNAVAILABLE', 'Environment credentials could not be encrypted');
      await mkdir(dirname(options.storePath), { recursive: true, mode: 0o700 });
      const temp = `${options.storePath}.${randomUUID()}.tmp`; const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ formatVersion: 1, ciphertext: encrypted.toString('base64') }) + '\n'); await file.sync(); } finally { await file.close(); }
      try { await rename(temp, options.storePath); } finally { await rm(temp, { force: true }); }
    });
    writes = write.catch(() => undefined); return write;
  }
  async function target(id: string): Promise<StoredTarget> { if (!UUID.test(id)) return fail('INVALID_INPUT', 'Invalid environment identity'); const t = (await load()).find(t => t.environmentId === id); if (!t) return fail('UNAUTHENTICATED', 'Environment needs pairing'); return t; }
  async function http(t: StoredTarget, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${t.bearerToken}`); headers.set('Origin', 'app://forge');
    try { const response = await fetcher(t.baseUrl + path, { ...init, headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30_000) }); if (response.status === 401) await clearRuntime(t.environmentId); return response; } catch { return fail('UNAVAILABLE', 'Environment request could not connect'); }
  }
  async function checkedJson(response: Response): Promise<unknown> {
    if (response.status === 401) fail('UNAUTHENTICATED', 'Environment needs pairing');
    if (response.status === 403) fail('FORBIDDEN', 'Environment access was denied');
    if (!response.ok) fail('UNAVAILABLE', 'Environment request was rejected');
    try { return JSON.parse(new TextDecoder().decode(await boundedBytes(response, 1_048_576))); } catch (e) { if (e instanceof CredentialFailure) throw e; return fail('UNAVAILABLE', 'Invalid environment response'); }
  }
  async function pinned(t: Pick<StoredTarget,'environmentId'|'baseUrl'>) {
    const response = await fetcher(t.baseUrl + '/api/v2/environment', { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const environment = await checkedJson(response) as EnvironmentDescriptor;
    if (environment.environmentId !== t.environmentId) { await clearRuntime(t.environmentId); fail('IDENTITY_MISMATCH', 'Environment identity changed; explicitly pair the replacement'); }
    if (environment.protocolVersion !== 1) fail('UNAVAILABLE', 'Environment protocol version does not match');
    return environment;
  }
  async function envelope<T>(fn: () => Promise<T>): Promise<EnvironmentCredentialResult<T>> {
    try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error: error instanceof CredentialFailure ? { code: error.code, message: error.message, retryable: error.retryable } : { code: 'INTERNAL', message: 'Environment credential operation failed', retryable: false } }; }
  }
  async function checkedRequest(input: Omit<EnvironmentHttpInput, 'body'>) {
    if (!input || typeof input.path !== 'string' || !input.path.startsWith('/api/') || input.path.includes('\\') || input.path.includes('#') || /[\x00-\x1f]/.test(input.path) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method)) fail('INVALID_INPUT', 'Invalid environment HTTP request');
    const t = await target(input.environmentId); const url = new URL(input.path, t.baseUrl);
    if (url.origin !== t.baseUrl || !url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/v2/access/')) fail('FORBIDDEN', 'Use the dedicated access methods');
    const headers = new Headers(); for (const [name, value] of Object.entries(input.headers ?? {})) { if (!['content-type', 'x-forge-environment-protocol'].includes(name.toLowerCase())) fail('FORBIDDEN', 'Request header is not permitted'); headers.set(name, value); }
    await pinned(t);
    return { t, path: url.pathname + url.search, headers };
  }
  async function pairInternal(input: EnvironmentPairInput, primary = false) {
    if (!input || typeof input.baseUrl !== 'string') return fail('INVALID_INPUT','Invalid pairing input');
    const baseUrl = targetUrl(input.baseUrl); await load();
    if (!UUID.test(input.environmentId) || typeof input.deviceName !== 'string' || input.deviceName.length < 1 || input.deviceName.length > 80 || !Array.isArray(input.requestedScopes)) fail('INVALID_INPUT', 'Invalid pairing input');
    const temporary: StoredTarget = { environmentId: input.environmentId, baseUrl, label: '', primary, bearerToken: '', deviceSessionId: '',deviceName:input.deviceName,scopes:input.requestedScopes,pairedAt:'',expiresAt:'' };
    await pinned(temporary);
    const post = async (path: string, value: unknown) => checkedJson(await fetcher(baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'app://forge' }, body: JSON.stringify(value), redirect: 'error', signal: AbortSignal.timeout(10_000) }));
    const challenge = await post('/api/v2/access/challenge', {}) as { challengeId: string; nonce: string };
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); const jwk = publicKey.export({ format: 'jwk' });
    const fields: Omit<PairingExchange, 'proof'> = { credential: input.credential, environmentId: input.environmentId, challengeId: challenge.challengeId, nonce: challenge.nonce, deviceName: input.deviceName, deviceKind: 'desktop', delivery: 'bearer', requestedScopes: input.requestedScopes, proofKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } };
    const digest = createHash('sha256').update(canonical(fields)).digest('hex');
    const proof = sign('sha256', Buffer.from(`forge-pair-v1\n${fields.environmentId}\n${fields.challengeId}\n${fields.nonce}\n${digest}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const result = await post('/api/v2/access/exchange', { ...fields, proof }) as { environment: EnvironmentDescriptor; deviceSession: DeviceSession; bearerToken: string };
    if (result.environment.environmentId !== input.environmentId || typeof result.environment.label!=='string' || result.environment.label.length<1 || result.environment.label.length>80 || !Array.isArray(result.deviceSession.scopes) || result.deviceSession.scopes.length<1 || result.deviceSession.scopes.length>7 || typeof result.deviceSession.deviceName!=='string' || result.deviceSession.deviceName.length>80 || !Number.isFinite(Date.parse(result.deviceSession.createdAt)) || !Number.isFinite(Date.parse(result.deviceSession.expiresAt)) || !UUID.test(result.deviceSession.deviceSessionId) || !/^[A-Za-z0-9_-]{43}$/.test(result.bearerToken)) fail('IDENTITY_MISMATCH', 'Pairing returned a different environment');
    const previous = targets!;
    targets = previous.filter(t => t.environmentId !== input.environmentId).map(t => primary ? { ...t, primary: false } : t);
    targets.push({ ...temporary, label: result.environment.label, bearerToken: result.bearerToken, deviceSessionId: result.deviceSession.deviceSessionId,deviceName:result.deviceSession.deviceName,scopes:result.deviceSession.scopes,pairedAt:result.deviceSession.createdAt,expiresAt:result.deviceSession.expiresAt, primary: primary || previous.some(t => t.environmentId === input.environmentId && t.primary) });
    try { await save(); await clearRuntime(input.environmentId); } catch (e) { targets = previous; throw e; }
    return { environment: result.environment, deviceSession: result.deviceSession };
  }
  async function artifactResponse(input: EnvironmentArtifactInput): Promise<Response> {
    if (!UUID.test(input.artifactId) || input.range && !/^bytes=\d+-\d*$/.test(input.range)) return fail('INVALID_INPUT', 'Invalid artifact reference or range');
    const t = await target(input.environmentId); await pinned(t);
    const response = await http(t, `/api/v2/artifacts/${input.artifactId}`, { headers: input.range ? { Range: input.range } : {} });
    if (response.status === 401) return fail('UNAUTHENTICATED', 'Environment needs pairing');
    if (!response.ok) return fail('FORBIDDEN', 'Artifact access was denied');
    return response;
  }
  async function encryptFile(path: string, value: unknown) {
    await checkStorage(); const text = JSON.stringify(value); const safe = options.safeStorage;
    const encrypted = safe.encryptStringAsync ? await safe.encryptStringAsync(text) : safe.encryptString?.(text);
    if (!encrypted?.length) return fail('UNAVAILABLE', 'Runtime persistence could not be encrypted');
    await mkdir(dirname(path), {recursive:true,mode:0o700}); const temp = `${path}.${randomUUID()}.tmp`; const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({formatVersion:1,ciphertext:encrypted.toString('base64')})+'\n'); await file.sync(); } finally { await file.close(); }
    try { await rename(temp,path); } finally { await rm(temp,{force:true}); }
  }
  async function loadRuntime() {
    if (runtime) return runtime; await checkStorage();
    try {
      const data = JSON.parse(await readFile(runtimePath, 'utf8')) as {formatVersion:number;ciphertext:string};
      if (data.formatVersion !== 1 || typeof data.ciphertext !== 'string') return fail('UNAVAILABLE', 'Runtime persistence is invalid');
      const encrypted = Buffer.from(data.ciphertext, 'base64'); const safe = options.safeStorage;
      const text = safe.decryptStringAsync ? (await safe.decryptStringAsync(encrypted)).result : safe.decryptString?.(encrypted);
      const parsed = JSON.parse(text ?? ''); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('UNAVAILABLE', 'Runtime persistence is invalid'); runtime = parsed as Record<string,string>;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') runtime = {}; else return fail('UNAVAILABLE', 'Runtime persistence could not be decrypted'); }
    return runtime!;
  }
  async function clearRuntime(environmentId: string) { return runtimeMutation(async () => { const data = await loadRuntime(); for (const key of Object.keys(data)) if (key.startsWith(environmentId + '/')) delete data[key]; await encryptFile(runtimePath,data); }); }
  async function persistenceKey(input: EnvironmentPersistenceInput) {
    if (!input || !['shell','pending'].includes(input.key) || input.deviceSessionId !== undefined && !UUID.test(input.deviceSessionId)) return fail('INVALID_INPUT', 'Invalid runtime persistence scope');
    const t = await target(input.environmentId); if (input.deviceSessionId !== undefined && t.deviceSessionId !== input.deviceSessionId) return fail('UNAUTHENTICATED', 'Runtime persistence belongs to another device session');
    return input.environmentId + '/' + t.deviceSessionId + '/' + input.key;
  }
  const persistence: EnvironmentPersistenceBridge = {
    load: input => envelope(() => runtimeMutation(async () => { const key = await persistenceKey(input); return (await loadRuntime())[key] ?? null; })),
    save: input => envelope(() => runtimeMutation(async () => {
      const key = await persistenceKey(input); const maximum = input.key === 'shell' ? 8*1024*1024 : 256*1024;
      if (typeof input.value !== 'string' || Buffer.byteLength(input.value) > maximum) return fail('INVALID_INPUT', 'Runtime persistence exceeds its byte limit');
      let decoded: unknown; try { decoded = JSON.parse(input.value); } catch { return fail('INVALID_INPUT', 'Runtime persistence must be JSON'); }
      const pending: unknown[] = [decoded]; const commands = new Set<string>();
      const tokens = (await load()).map(t => t.bearerToken);
      while (pending.length) {
        const value = pending.pop();
        if (typeof value === 'string' && tokens.some(token => value.includes(token))) return fail('INVALID_INPUT', 'Credentials cannot enter runtime persistence');
        if (value && typeof value === 'object') for (const [name, child] of Object.entries(value)) {
          if (['bearertoken','csrftoken','ticket','credential','secret','apikey','authorization'].includes(name.toLowerCase().replaceAll('_','').replaceAll('-',''))) return fail('INVALID_INPUT', 'Credentials cannot enter runtime persistence');
          if (name === 'commandId' && typeof child === 'string') commands.add(child); pending.push(child);
        }
      }
      if (input.key === 'pending' && commands.size > 100) return fail('INVALID_INPUT', 'Pending command count exceeds 100');
      const data = await loadRuntime(); const previous = data[key]; data[key] = input.value; try {await encryptFile(runtimePath,data);} catch(e) {if(previous===undefined)delete data[key];else data[key]=previous;throw e;}
    })),
    clear: input => envelope(async () => { if (!input || !UUID.test(input.environmentId)) return fail('INVALID_INPUT', 'Invalid environment identity'); await clearRuntime(input.environmentId); }),
  };
  const bridge: EnvironmentCredentialsBridge = {
    primary: () => envelope(async () => { const t = (await load()).find(t => t.primary); return t ? publicTarget(t) : null; }),
    list: () => envelope(async () => (await load()).map(publicTarget)),
    pair: input => envelope(() => mutate(() => pairInternal(input))),
    session: id => envelope(async () => { const t = await target(id); await pinned(t); const result = await checkedJson(await http(t, '/api/v2/access/session')) as { deviceSession: DeviceSession }; return { deviceSession: result.deviceSession }; }),
    wsTicket: (id, audience, protocolVersion) => envelope(async () => { if (!['rpc', 'legacy'].includes(audience) || protocolVersion !== 1) fail('INVALID_INPUT', 'Invalid socket ticket input'); const t = await target(id); await pinned(t); return await checkedJson(await http(t, '/api/v2/access/ws-ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audience, protocolVersion }) })) as { ticket: string; expiresAt: string }; }),
    request: input => envelope(async () => {
      if (!input || input.body !== undefined && (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 1_048_576)) fail('INVALID_INPUT', 'Invalid environment HTTP request');
      const { t, path, headers } = await checkedRequest(input);
      const response = await http(t, path, { method: input.method, headers, body: input.body });
      return { status: response.status, headers: safeHeaders(response), body: new TextDecoder().decode(await boundedBytes(response)) };
    }),
    requestBinary: input => envelope(async () => {
      if (!input || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > MAX_ARTIFACT_BYTES || input.body !== undefined && (!(input.body instanceof Uint8Array) || input.body.byteLength > MAX_ARTIFACT_BYTES)) fail('INVALID_INPUT', 'Invalid environment binary request');
      const { t, path, headers } = await checkedRequest(input);
      const response = await http(t, path, { method: input.method, headers, ...(input.body ? { body: Buffer.from(input.body) } : {}) });
      return { status: response.status, headers: safeHeaders(response), bytes: await boundedBytes(response, input.maxBytes) };
    }),
    uploadArtifact: input => envelope(async () => {
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > MAX_ARTIFACT_BYTES || !UUID.test(input.uploadId) || !input.projectId || input.projectId.length > 128 || !input.fileName || input.fileName.length > 256 || /[\r\n]/.test(input.mimeType) || input.mimeType.length > 256) fail('INVALID_INPUT', 'Invalid artifact upload');
      const t = await target(input.environmentId); await pinned(t);
      const response = await http(t, `/api/v2/artifacts?projectId=${encodeURIComponent(input.projectId)}&uploadId=${input.uploadId}`, { method: 'POST', headers: { 'Content-Type': input.mimeType, 'Content-Length': String(input.bytes.byteLength), 'X-Forge-File-Name': encodeURIComponent(input.fileName) }, body: Buffer.from(input.bytes) });
      return await checkedJson(response) as ArtifactRef;
    }),
    artifact: input => envelope(async () => { const response = await artifactResponse(input); return { bytes: await boundedBytes(response), mimeType: response.headers.get('content-type') ?? 'application/octet-stream', fileName: response.headers.get('content-disposition')?.match(/filename="([^"]*)"/)?.[1] ?? 'artifact' }; }),
    remove: id => envelope(() => mutate(async () => { await load(); const previous = targets!; targets = previous.filter(t => t.environmentId !== id); try { await save(); await clearRuntime(id); } catch (e) { targets = previous; throw e; } return { removed: targets.length !== previous.length }; })),
  };
  return { ...bridge, persistence, rebindPrimary: (baseUrl: string) => envelope(async () => {
    const t = (await load()).find(t => t.primary); if (!t) return null;
    const rebound = { ...t, baseUrl: targetUrl(baseUrl) }; await pinned(rebound);
    if (t.baseUrl !== rebound.baseUrl) { t.baseUrl = rebound.baseUrl; await save(); }
    return publicTarget(rebound);
  }), pairPrimary: (input: EnvironmentPairInput) => envelope(() => mutate(() => pairInternal(input, true))), artifactProtocolResponse: async (url: string, range?: string) => {
    try {
      const parsed = new URL(url); const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)$/);
      if (parsed.protocol !== 'forge-artifact:' || parsed.hostname !== 'artifact' || !match || parsed.search || parsed.hash) return new Response(null, { status: 400 });
      const response = await artifactResponse({ environmentId: match[1]!, artifactId: match[2]!, range });
      const bytes = await boundedBytes(response); const headers = safeHeaders(response); headers['Cache-Control'] = 'no-store'; headers['X-Content-Type-Options']='nosniff'; if(!headers['content-security-policy'] && response.headers.get('content-type')?.includes('text/html'))headers['Content-Security-Policy']="sandbox; default-src 'none'";
      return new Response(Buffer.from(bytes), { status: response.status, headers });
    } catch { return new Response(null, { status: 403 }); }
  } };
}
function safeHeaders(response: Response): Record<string, string> { const headers: Record<string, string> = {}; for (const name of ['content-type', 'content-disposition', 'content-range', 'accept-ranges', 'content-security-policy', 'x-content-type-options', 'cache-control']) { const value = response.headers.get(name); if (value) headers[name] = value; } return headers; }
export type EnvironmentCredentialService = ReturnType<typeof createEnvironmentCredentialService>;
export function installEnvironmentCredentialsIpc(options: { ipcMain: { handle(channel: string, listener: (event: unknown, input: unknown) => unknown): void; removeHandler(channel: string): void }; service: EnvironmentCredentialService; isTrustedSender(event: unknown): boolean }): () => void {
  options.ipcMain.handle(ENVIRONMENT_CREDENTIALS_CHANNEL, async (event, input) => {
    if (!options.isTrustedSender(event)) return { ok: false, error: { code: 'FORBIDDEN', message: 'Environment credentials require the trusted main renderer', retryable: false } };
    const r = input as { operation?: string; input?: unknown; environmentId?: string; audience?: 'rpc' | 'legacy'; protocolVersion?: number };
    if (!r || typeof r.operation !== 'string') return { ok: false, error: { code: 'INVALID_INPUT', message: 'Invalid credential operation', retryable: false } };
    switch (r.operation) {
      case 'primary': return options.service.primary();
      case 'list': return options.service.list();
      case 'pair': return options.service.pair(r.input as EnvironmentPairInput);
      case 'session': return options.service.session(r.environmentId ?? '');
      case 'wsTicket': return options.service.wsTicket(r.environmentId ?? '', r.audience!, r.protocolVersion!);
      case 'request': return options.service.request(r.input as EnvironmentHttpInput);
      case 'requestBinary': return options.service.requestBinary(r.input as EnvironmentBinaryHttpInput);
      case 'uploadArtifact': return options.service.uploadArtifact(r.input as EnvironmentUploadInput);
      case 'artifact': return options.service.artifact(r.input as EnvironmentArtifactInput);
      case 'remove': return options.service.remove(r.environmentId ?? '');
      default: return { ok: false, error: { code: 'INVALID_INPUT', message: 'Unknown credential operation', retryable: false } };
    }
  });
  options.ipcMain.handle(ENVIRONMENT_PERSISTENCE_CHANNEL, (event, request) => {
    if (!options.isTrustedSender(event)) return {ok:false,error:{code:'FORBIDDEN',message:'Runtime persistence requires the trusted main renderer',retryable:false}};
    const r = request as {operation?:string;input?:unknown};
    if (r?.operation === 'load') return options.service.persistence.load(r.input as EnvironmentPersistenceInput);
    if (r?.operation === 'save') return options.service.persistence.save(r.input as EnvironmentPersistenceInput & {value:string});
    if (r?.operation === 'clear') return options.service.persistence.clear(r.input as {environmentId:string});
    return {ok:false,error:{code:'INVALID_INPUT',message:'Invalid persistence operation',retryable:false}};
  });
  return () => { options.ipcMain.removeHandler(ENVIRONMENT_CREDENTIALS_CHANNEL); options.ipcMain.removeHandler(ENVIRONMENT_PERSISTENCE_CHANNEL); };
}
/** Narrow preload facade: no method accepts a bearer token, host-admin bootstrap, or filesystem path. */
export function createEnvironmentCredentialsBridge(ipc: { invoke(channel: string, input: unknown): Promise<unknown> }): EnvironmentCredentialsBridge {
  const invoke = <T>(request: unknown) => ipc.invoke(ENVIRONMENT_CREDENTIALS_CHANNEL, request) as Promise<EnvironmentCredentialResult<T>>;
  return { primary: () => invoke({ operation: 'primary' }), list: () => invoke({ operation: 'list' }), pair: input => invoke({ operation: 'pair', input }), session: environmentId => invoke({ operation: 'session', environmentId }), wsTicket: (environmentId, audience, protocolVersion) => invoke({ operation: 'wsTicket', environmentId, audience, protocolVersion }), request: input => invoke({ operation: 'request', input }), requestBinary: input => invoke({ operation: 'requestBinary', input }), uploadArtifact: input => invoke({ operation: 'uploadArtifact', input }), artifact: input => invoke({ operation: 'artifact', input }), remove: environmentId => invoke({ operation: 'remove', environmentId }) };
}

export function createEnvironmentPersistenceBridge(ipc: {invoke(channel:string,input:unknown):Promise<unknown>}): EnvironmentPersistenceBridge {
  return {load:input=>ipc.invoke(ENVIRONMENT_PERSISTENCE_CHANNEL,{operation:'load',input}) as Promise<EnvironmentCredentialResult<string|null>>,save:input=>ipc.invoke(ENVIRONMENT_PERSISTENCE_CHANNEL,{operation:'save',input}) as Promise<EnvironmentCredentialResult<void>>,clear:input=>ipc.invoke(ENVIRONMENT_PERSISTENCE_CHANNEL,{operation:'clear',input}) as Promise<EnvironmentCredentialResult<void>>};
}

/** Normalized main-process activity state, obtained only through the paired primary transport. */
export interface EnvironmentActivity {activeSessions:number;activeWorkers:number;hasActivity:boolean}
export async function readPrimaryEnvironmentActivity(credentials: Pick<EnvironmentCredentialsBridge,'primary'|'request'>):Promise<EnvironmentActivity|null> {
  try {
    const primary=await credentials.primary();if(!primary.ok||!primary.value)return null;
    const response=await credentials.request({environmentId:primary.value.environmentId,path:'/api/activity',method:'GET'});
    if(!response.ok||response.value.status!==200)return null;
    const body=JSON.parse(response.value.body) as Record<string,unknown>;
    const activeSessions=body.activeSessions,activeWorkers=body.activeWorkers;
    if(typeof activeSessions!=='number'||!Number.isSafeInteger(activeSessions)||activeSessions<0||typeof activeWorkers!=='number'||!Number.isSafeInteger(activeWorkers)||activeWorkers<0||typeof body.hasActiveSessions!=='boolean'||typeof body.hasActiveWorkers!=='boolean')return null;
    return {activeSessions,activeWorkers,hasActivity:body.hasActiveSessions||body.hasActiveWorkers||activeSessions>0||activeWorkers>0};
  } catch {return null;}
}
