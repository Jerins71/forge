import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fixtureRpcOnce, openFixtureRpc, until } from './rpc-client.js';
import { controlEnvironment, isWithin, readManifest, repositoryRoot, sanitizedEnvironment, type BootstrapSession, type EnvironmentFixture } from '../launch.js';
import * as dataPaths from '../../../apps/backend/src/swarm/storage/data-paths.js';
import { createFixturePlatform } from './ui-platform.js';
import { fixturePlatformScript } from './ui-platform.js';
import { WebSocket } from './ws.js';
import type { SqliteDatabaseConstructor } from '../../../apps/backend/src/swarm/types.js';
import type { RpcOutput } from '@forge/protocol/environment-v2';

export interface UiEnvironment { environmentId: string; label: string; baseUrl: string; projectTitle: string; sessionId: string; }
export interface LaunchEvidence { commands: number; worktrees: number; dispatches: number; markerChanged: boolean; }
export interface UiFleet {
  uiUrl: string; artifactRoot: string; a: UiEnvironment; b: UiEnvironment; c: UiEnvironment;
  mintGrant(environment: UiEnvironment, kind: 'link' | 'code'): Promise<{ pairingUrl: string | null; code: string | null }>;
  stop(environment: UiEnvironment): Promise<void>; start(environment: UiEnvironment): Promise<void>;
  launchEvidence(environment: UiEnvironment, sessionId: string): Promise<LaunchEvidence>;
  dispose(): Promise<void>;
}
export interface UiFleetIntegration {
  bootstrap(environment: EnvironmentFixture): Promise<BootstrapSession>;
  seed(environment: EnvironmentFixture, session: BootstrapSession): Promise<UiEnvironment>;
  // Platform credentials/tickets stay in the test process, never in a bearer-bearing script.
  platformScript(primary: UiEnvironment, session: BootstrapSession): Promise<string>;
}
/** Pair real owned backends through private parent bootstrap and the normal exchange. */
export async function openUiFleet(manifestPath: string, options: { integration?: UiFleetIntegration; uiRoot?: string } = {}): Promise<UiFleet> {
  const manifest = await readManifest(manifestPath);
  assert(manifest.environments.length >= 3, 'UI acceptance requires three real environments');
  const environments = manifest.environments.slice(0, 3);
  const integration: UiFleetIntegration = options.integration ?? {
    bootstrap: environment => controlEnvironment<BootstrapSession>(manifest, environment.name, 'bootstrap'),
    seed: seedUiEnvironment,
    platformScript: async () => fixturePlatformScript,
  };
  const sessions = new Map<string, BootstrapSession>();
  const publicEnvironments: UiEnvironment[] = [];
  for (const environment of environments) {
    const session = await integration.bootstrap(environment);
    sessions.set(session.environmentId, session);
    const seeded = await integration.seed(environment, session);
    assert.equal(seeded.environmentId, session.environmentId, 'seed identity must match authenticated environment');
    assert.equal(seeded.baseUrl, environment.baseUrl, 'seed URL must match owned environment');
    publicEnvironments.push(seeded);
  }
  assert.equal(new Set(publicEnvironments.map(environment => environment.environmentId)).size, 3, 'distinct environment identities');
  const [a, b, c] = publicEnvironments as [UiEnvironment, UiEnvironment, UiEnvironment];
  const script = await integration.platformScript(a, sessions.get(a.environmentId)!);
  for (const session of sessions.values()) assert(!script.includes(session.bearer), 'platform code cannot embed a bearer');
  const platform = options.integration ? undefined : createFixturePlatform(environments, a, sessions.get(a.environmentId)!, () => `http://127.0.0.1:${manifest.uiPort}`);
  const ui = await serveBuiltUi(options.uiRoot ?? join(repositoryRoot, 'apps/ui/.output/public'), script, { port: manifest.uiPort, platform });
  let disposed = false;
  const owned = (environment: UiEnvironment) => {
    if (disposed) throw new Error('UI fleet is disposed');
    const index = publicEnvironments.findIndex(value => value.environmentId === environment.environmentId);
    if (index < 0) throw new Error('Environment does not belong to this UI fleet');
    return environments[index]!;
  };
  return {
    uiUrl: ui.url, artifactRoot: manifest.artifactRoot, a, b, c,
    mintGrant: async (environment, kind) => {
      owned(environment);
      const session = sessions.get(environment.environmentId)!;
      const output = await authenticatedRpc<{ pairingUrl: string | null; code: string | null }>(environment.baseUrl, session, 'access.grant.create', {
        kind, label: `Fixture browser ${environment.label}`, scopes: ['session:read', 'session:operate', 'workspace:read', 'workspace:write', 'terminal:operate', 'settings:admin', 'access:admin'],
        expiresInSeconds: 300, reachableBaseUrl: environment.baseUrl,
      });
      return { pairingUrl: output.pairingUrl, code: output.code };
    },
    stop: async environment => { await controlEnvironment(manifest, owned(environment).name, 'stop'); },
    start: async environment => {
      const fixture = await controlEnvironment<EnvironmentFixture>(manifest, owned(environment).name, 'start');
      assert.equal(fixture.baseUrl, environment.baseUrl, 'restart must preserve paired URL');
    },
    launchEvidence: (environment, sessionId) => readLaunchEvidence(owned(environment), sessionId),
    dispose: async () => { if (disposed) return; disposed = true; sessions.clear(); await ui.stop(); },
  };
}
/** Serve the existing production build, with optional memory-only fixture code.
 * A Playwright worker owns this server and closes only its own listener. */
export async function serveBuiltUi(rootPath: string, bootstrapScript = '', options: { port?: number; platform?: (operation: string, input: unknown) => Promise<unknown> } = {}) {
  const root = await realpath(rootPath).catch(() => { throw new Error('Built UI unavailable; run pnpm --filter @forge/ui build'); });
  let shell: string | undefined;
  for (const candidate of ['index.html', '_shell.html']) {
    try { if ((await stat(join(root, candidate))).isFile()) { shell = join(root, candidate); break; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!shell) throw new Error('Built UI shell unavailable; run pnpm --filter @forge/ui build');
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'POST' && req.url === '/__forge_e2e_platform' && options.platform) {
        const ownOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        if (req.headers.origin !== ownOrigin || req.headers['content-type'] !== 'application/json') { res.writeHead(403).end(); return; }
        let bytes = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 36 * 1024 * 1024) throw new Error('Fixture platform payload limit'); chunks.push(chunk); }
        const { operation, input } = JSON.parse(Buffer.concat(chunks).toString()) as { operation: string; input: unknown };
        let result: unknown;
        try { result = { ok: true, value: await options.platform(operation, input) }; }
        catch (error) { const unauthenticated = (error as { code?: string }).code === 'UNAUTHENTICATED'; result = { ok: false, error: { code: unauthenticated ? 'UNAUTHENTICATED' : 'UNAVAILABLE', message: unauthenticated ? 'Pairing credential is invalid, expired, or already used' : 'Fixture platform operation failed', retryable: false } }; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result)); return;
      }
      if (req.method !== 'GET'  && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://fixture.invalid').pathname);
      if (path.startsWith('/api/')) { res.writeHead(404).end(); return; }
      if (path === '/__forge_e2e_platform.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : bootstrapScript); return;
      }
      const selected = path === '/' || !extname(path) ? shell! : resolve(root, `.${path}`);
      const file = await realpath(selected);
      if (!isWithin(root, file) || !(await stat(file)).isFile()) { res.writeHead(404).end(); return; }
      let content = await readFile(file);
      if (file === shell && bootstrapScript) content = Buffer.from(content.toString().replace('<head>', '<head><script src="/__forge_e2e_platform.js"></script>'));
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : content);
    })().catch(() => { if (!res.headersSent) res.writeHead(404); res.end(); });
  });
  server.listen(options.port ?? 0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}`, stop: async () => { server.closeAllConnections(); await new Promise<void>(resolveStop => server.close(() => resolveStop())); } };
}
export async function ticket(baseUrl: string, session: BootstrapSession, audience: 'rpc') {
  const response = await fetch(`${baseUrl}/api/v2/access/ws-ticket`, { method: 'POST',
    headers: { Authorization: `Bearer ${session.bearer}`, 'Content-Type': 'application/json', 'x-forge-environment-protocol': "2" },
    body: JSON.stringify({ audience, protocolVersion: 2 }), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Fixture authenticated ticket unavailable');
  return (await response.json() as { ticket: string }).ticket;
}
export async function authenticatedRpc<T>(baseUrl: string, session: BootstrapSession, method: string, input: unknown): Promise<T> {
  const ws = new WebSocket(`${baseUrl.replace('http:', 'ws:').replace('https:', 'wss:')}/api/v2/rpc`, ['forge.v2', `ticket.${await ticket(baseUrl, session, 'rpc')}`]);
  const requestId = 'fixture-grant';
  try {
    await once(ws, 'open');
    return await new Promise<T>((resolveReply, reject) => {
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('Fixture authenticated RPC timed out')); }, 5000);
      ws.on('message', data => {
        const frame = JSON.parse(data.toString()) as { requestId?: string; type?: string; output?: T };
        if (frame.requestId !== requestId) return;
        clearTimeout(timer);
        if (frame.type === 'result') resolveReply(frame.output!); else reject(new Error('Fixture authenticated RPC rejected'));
      });
      ws.once('error', () => { clearTimeout(timer); reject(new Error('Fixture authenticated socket failed')); });
      ws.send(JSON.stringify({ type: 'request', requestId, method, input }));
    });
  } finally { ws.terminate(); }
}
export async function seedUiEnvironment(environment: EnvironmentFixture, session: BootstrapSession): Promise<UiEnvironment> {
  // Seed through project control, with reserved project/default-session identities.
  if (environment.name === 'env-c') await promisify(execFile)('git', ['remote', 'set-url', 'origin', 'https://fixture.invalid/forge/independent-fixture.git'], { cwd: environment.checkout, env: sanitizedEnvironment() });
  const title = environment.name === 'env-c' ? 'Independent fixture' : 'Shared fixture';
  // Repeated fixture attachment keeps the same environment-qualified session IDs.
  const commandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sessionId = `project-${commandId}`;
  const rpc = await openFixtureRpc(environment.baseUrl, session);
  let exists = false;
  try { await rpc.call('shell.subscribe', {}); const snapshot = await until<RpcOutput<'shell.page'>['snapshot']>(() => rpc.frames.find(frame => frame.item?.kind === 'snapshot')?.item.snapshot, Boolean); exists = snapshot.projects.some(project => project.projectId === sessionId); }
  finally { rpc.close(); }
  if (exists) return { environmentId: session.environmentId, label: session.label ?? environment.name, baseUrl: environment.baseUrl, projectTitle: title, sessionId };
  const receipt = await fixtureRpcOnce(environment.baseUrl, session, 'project.create', { commandId, title, cwd: environment.checkout, model: { provider: 'codex-native', modelId: 'gpt-6-sol', thinkingLevel: 'high' }, secureSessionsEnabled: false });
  if (receipt.state !== 'succeeded' || !receipt.result?.sessionId) throw new Error('Authenticated project-control fixture seed rejected');
  return { environmentId: session.environmentId, label: session.label ?? environment.name, baseUrl: environment.baseUrl, projectTitle: title, sessionId: receipt.result.sessionId };
}

/** Only selected synthetic counts leave this reader. It never exports a DB,
 * transcript, upload, token or provider request payload. */
export async function readLaunchEvidence(environment: EnvironmentFixture, sessionId: string): Promise<LaunchEvidence> {
  const dbPath = dataPaths.getEnvironmentDbPath(environment.dataDir);
  assert(isWithin(environment.dataDir, dbPath));
  const require = createRequire(join(repositoryRoot, 'apps/backend/package.json'));
  const Database = require('better-sqlite3') as SqliteDatabaseConstructor;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let commands = 0;
  let workspace: string | undefined;
  let descriptor: import('../../../apps/backend/src/swarm/types.js').AgentDescriptor;
  try {
    const row = db.prepare('SELECT descriptor_json FROM control_sessions WHERE session_id=? AND deleted=0').get(sessionId) as { descriptor_json: string } | undefined;
    if (!row) throw new Error('Fixture session descriptor is missing');
    descriptor = JSON.parse(row.descriptor_json);
    assert(isWithin(resolve(environment.checkout, '..'), descriptor.cwd), 'session checkout must stay inside owned environment');
    commands = (db.prepare("SELECT count(*) AS count FROM commands WHERE session_id = ? AND method = 'session.launch'").get(sessionId) as { count: number }).count;
    const reservation = db.prepare("SELECT path FROM workspace_reservations WHERE session_id = ? AND kind = 'new_worktree' AND state = 'ready'").get(sessionId) as { path: string } | undefined;
    workspace = reservation?.path;
  } finally { db.close(); }
  const git = await promisify(execFile)('git', ['worktree', 'list', '--porcelain'], { cwd: environment.checkout, env: sanitizedEnvironment() });
  const worktrees = workspace ? git.stdout.split('\n').filter(line => line === `worktree ${workspace}`).length : 0;
  const marker = await readFile(join(descriptor.cwd, 'fixture-provider-marker.txt'), 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; });
  assert(isWithin(environment.dataDir, descriptor.sessionFile), 'session history must remain in owned data root');
  const entries = (await readFile(descriptor.sessionFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { type?: string; customType?: string; data?: { threadId?: string } });
  const threadIds = new Set(entries.filter(entry => entry.type === 'custom' && entry.customType === 'swarm_native_codex_state').map(entry => entry.data?.threadId));
  const counterRoot = join(environment.checkout, '.fixture-codex');
  const counterFiles = await readdir(counterRoot).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
  let dispatches = 0;
  for (const file of counterFiles.filter(file => /^process-\d+\.json$/.test(file))) {
    const counter = JSON.parse(await readFile(join(counterRoot, file), 'utf8')) as { threadId?: string; turnStarts: number };
    if (threadIds.has(counter.threadId)) dispatches += counter.turnStarts;
  }
  return { commands, worktrees, dispatches, markerChanged: marker.startsWith(`${environment.instanceId}:turns=`) };
}
