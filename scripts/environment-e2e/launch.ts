import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, request as controlRequest } from 'node:http';
import { chmod } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { legacySmoke } from './fixtures/legacy-smoke.js';
import { writeInfrastructureArtifacts } from './assert-artifacts.js';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const markerName = '.forge-environment-e2e-root.json';
const origin = 'https://fixture.invalid/forge/environment-e2e.git';
const backendRequire = createRequire(join(repositoryRoot, 'apps/backend/package.json'));
export interface EnvironmentFixture {
  name: string; instanceId: string; checkout: string; dataDir: string;
  installationStateDir: string; pid: number; port: number; baseUrl: string;
  bootstrap: 'pending';
}
export interface FleetManifest {
  formatVersion: 1; runId: string; root: string; repositoryRoot: string;
  artifactRoot: string; controlSocket: string; createdAt: string; status: 'running' | 'stopped' | 'failed';
  provider: 'fixture'; teardown?: { ownedChildrenExited: number; rootRemoved: boolean }; environments: EnvironmentFixture[];
}
// Fill this port once A's named private IPC and normal exchange land. Sessions
// stay in memory; neither grants nor bearer/ticket values enter the manifest.
export interface BootstrapSession { environmentId: string; bearer: string; label?: string; }
export interface PairingHooks {
  bootstrap(child: ChildProcess, environment: EnvironmentFixture): Promise<BootstrapSession>;
  pair(environment: EnvironmentFixture, mode: 'link' | 'code'): Promise<BootstrapSession>;
}
export const pendingPairingHooks: PairingHooks = {
  bootstrap: async () => { throw new Error('V2 private bootstrap/exchange integration is pending stream A'); },
  pair: async () => { throw new Error('V2 pairing integration is pending stream A'); },
};

/** An allowlist removes provider/vault keys, FORGE/MIDDLEMAN settings, CA,
 * NODE_OPTIONS, Electron/native binding overrides, proxy and dotenv state. */
export function sanitizedEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG',
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)']);
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toUpperCase()) || /^LC_[A-Z_]+$/.test(key)));
}
async function command(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    // Never retain remote/config error payloads. This fixture has no credentials.
    child.stderr.resume();
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveCommand(stdout.trim()) : reject(new Error(`Fixture git ${args[0]} failed (${code})`)));
  });
}
async function saveManifest(path: string, manifest: FleetManifest) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}
export async function readManifest(path: string): Promise<FleetManifest> {
  const value = JSON.parse(await readFile(path, 'utf8')) as FleetManifest;
  assert.equal(value.formatVersion, 1);
  assert(Array.isArray(value.environments) && value.environments.length > 0);
  assert(isAbsolute(value.root) && isAbsolute(value.artifactRoot));
  return value;
}
export async function verifyFleetHealth(manifest: FleetManifest): Promise<void> {
  assert.equal(new Set(manifest.environments.map(env => env.pid)).size, manifest.environments.length);
  assert.equal(new Set(manifest.environments.map(env => env.port)).size, manifest.environments.length);
  assert.equal(new Set(manifest.environments.map(env => env.dataDir)).size, manifest.environments.length);
  const marker = JSON.parse(await readFile(join(manifest.root, markerName), 'utf8'));
  assert.equal(marker.runId, manifest.runId);
  assert.equal(marker.root, await realpath(manifest.root));
  for (const environment of manifest.environments) {
    const health = await fetch(`${environment.baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { ok?: boolean }).ok, true);
    const fixture = JSON.parse(await readFile(join(environment.checkout, '.fixture-environment.json'), 'utf8'));
    assert.equal(fixture.instanceId, environment.instanceId);
    assert.equal(await readFile(join(environment.checkout, 'environment-marker.txt'), 'utf8'), `${environment.name}\n`);
    const remote = await command(['remote', 'get-url', 'origin'], environment.checkout, sanitizedEnvironment());
    assert.equal(remote, origin);
  }
}

export async function launchFleet(options: { environments?: number; out?: string; artifactRoot?: string; pairingHooks?: PairingHooks } = {}) {
  const count = options.environments ?? 3;
  if (!Number.isInteger(count) || count < 1 || count > 26) throw new Error('Expected 1..26 environments');
  if (process.platform === 'win32') throw new Error('Fixture executable launcher on Windows is pending; do not use a shell shim for CODEX_BIN');
  const runId = randomUUID();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-v2-e2e-')));
  const out = resolve(options.out ?? join(repositoryRoot, '.internal/forge-v2-remote/e2e-manifest.json'));
  const artifactRoot = resolve(options.artifactRoot ?? join(repositoryRoot, '.internal/forge-v2-remote/e2e', runId));
  const manifest: FleetManifest = { formatVersion: 1, runId, root, repositoryRoot, artifactRoot,
    controlSocket: join(root, 'fleet-control.sock'), createdAt: new Date().toISOString(), status: 'running', provider: 'fixture', environments: [] };
  const children: ChildProcess[] = [];
  const paused = new Set<string>();
  const pairing = options.pairingHooks ?? pendingPairingHooks;
  let controlServer: ReturnType<typeof createServer> | undefined;
  let lifecycle: Promise<unknown> = Promise.resolve();
  const startFunctions = new Map<string, () => Promise<EnvironmentFixture>>();
  let stopping = false;
  let failed = false;
  let failureListener: ((error: Error) => void) | undefined;
  let stopPromise: Promise<void> | undefined;
  const logs: ReturnType<typeof createWriteStream>[] = [];
  await writeFile(join(root, markerName), `${JSON.stringify({ formatVersion: 1, runId, root })}\n`, { mode: 0o600 });
  await mkdir(artifactRoot, { recursive: true });
  const emptyGitConfig = join(root, 'empty-git-config');
  await writeFile(emptyGitConfig, '');
  const env = { ...sanitizedEnvironment(), NODE_ENV: 'test', FORGE_TELEMETRY: 'false', OTEL_SDK_DISABLED: 'true',
    GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_SYSTEM: emptyGitConfig, GIT_TERMINAL_PROMPT: '0' };
  const stop = (preserveFailure = false): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    failed ||= preserveFailure;
    stopPromise = (async () => {
      await lifecycle.catch(() => undefined);
      const results = await Promise.allSettled(children.map(stopChild));
      if (controlServer) await new Promise<void>(resolveControl => controlServer!.close(() => resolveControl()));
      if (results.some(result => result.status === 'rejected')) failed = true;
      for (const log of logs) await new Promise<void>(resolveLog => log.end(resolveLog));
      manifest.status = failed ? 'failed' : 'stopped';
      if (!failed) {
        const marker = JSON.parse(await readFile(join(root, markerName), 'utf8'));
        if (marker.runId !== runId || marker.root !== await realpath(root)) throw new Error('Refusing to remove unmarked harness root');
        await rm(root, { recursive: true });
      }
      manifest.teardown = { ownedChildrenExited: children.filter(child => child.exitCode !== null || child.signalCode !== null).length, rootRemoved: !failed };
      await saveManifest(out, manifest);
      if (results.some(result => result.status === 'rejected')) throw new Error('Harness child teardown failed; artifacts/root preserved');
    })();
    return stopPromise;
  };
  try {
    const seed = join(root, 'seed');
    await mkdir(seed);
    await command(['init', '--initial-branch=main', seed], root, env);
    await writeFile(join(seed, 'README.md'), '# Synthetic Forge environment fixture\n');
    await writeFile(join(seed, '.gitignore'), '.fixture-codex/\nfixture-provider-marker.txt\n');
    await command(['add', '.'], seed, env);
    await command(['-c', 'user.name=Forge Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic fixture'], seed, env);
    const bare = join(root, 'fixture.git');
    await command(['clone', '--bare', seed, bare], root, env);
    for (let index = 0; index < count; index++) {
      const name = `env-${String.fromCharCode(97 + index)}`;
      const base = join(root, name);
      const checkout = join(base, 'checkout');
      const dataDir = join(base, 'data');
      const installationStateDir = join(base, 'installation-state');
      await mkdir(base);
      await mkdir(dataDir);
      await mkdir(installationStateDir);
      await command(['clone', bare, checkout], base, env);
      await command(['remote', 'set-url', 'origin', origin], checkout, env);
      await writeFile(join(checkout, 'environment-marker.txt'), `${name}\n`);
      await writeFile(join(checkout, '.fixture-environment.json'), JSON.stringify({ formatVersion: 1, instanceId: name }));
      await command(['add', '.'], checkout, env);
      await command(['-c', 'user.name=Forge Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', `Mark ${name}`], checkout, env);
      const childEnv = { ...env, FORGE_DATA_DIR: dataDir, FORGE_HOST: '127.0.0.1', FORGE_PORT: '0',
        FORGE_E2E_CHECKOUT: checkout, CODEX_BIN: join(repositoryRoot, 'scripts/environment-e2e/fake-codex.mjs') };
      const entry = join(repositoryRoot, 'scripts/environment-e2e/fixtures/backend-process.ts');
      const args = entry.endsWith('.ts') ? ['--import', backendRequire.resolve('tsx'), entry] : [entry];
      const startEnvironment = async (): Promise<EnvironmentFixture> => {
        const existing = manifest.environments.find(environment => environment.name === name);
        const active = children[index];
        if (active && active.exitCode === null && active.signalCode === null) throw new Error('Environment is already running');
        const log = createWriteStream(join(artifactRoot, `${name}.log`), { mode: 0o600, flags: 'a' });
        logs.push(log);
        const child = spawn(process.execPath, args, { cwd: checkout,
          env: { ...childEnv, FORGE_PORT: existing ? String(existing.port) : '0' },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
        children[index] = child;
        child.stdout!.pipe(log, { end: false });
        child.stderr!.pipe(log, { end: false });
        child.on('exit', () => { if (!stopping && !paused.has(name)) { failed = true; failureListener?.(new Error('Owned backend exited unexpectedly')); } });
        const ready = await waitForReady(child, dataDir);
        if (existing && existing.port !== ready.port) throw new Error('Restart changed the owned environment port');
        const environment: EnvironmentFixture = { name, instanceId: name, checkout, dataDir, installationStateDir,
          pid: child.pid!, port: ready.port, baseUrl: `http://127.0.0.1:${ready.port}`, bootstrap: 'pending' };
        if (existing) Object.assign(existing, environment);
        else manifest.environments.push(environment);
        paused.delete(name);
        return environment;
      };
      startFunctions.set(name, startEnvironment);
      await startEnvironment();
    }
    await verifyFleetHealth(manifest);
    await saveManifest(out, manifest);
    // Private test-process lifecycle channel. It is never a backend endpoint.
    controlServer = createServer((req, res) => {
      const match = /^\/environment\/(env-[a-z])\/(stop|start|bootstrap)$/.exec(req.url ?? '');
      if (req.method !== 'POST' || !match || req.headers['content-length'] && req.headers['content-length'] !== '0') { res.writeHead(404).end(); return; }
      const environment = manifest.environments.find(value => value.name === match[1]);
      if (!environment || stopping) { res.writeHead(409).end(); return; }
      const work = lifecycle.then(async () => {
        if (match[2] === 'bootstrap') return pairing.bootstrap(children[manifest.environments.indexOf(environment)]!, environment);
        if (match[2] === 'stop') { paused.add(environment.name); await stopChild(children[manifest.environments.indexOf(environment)]!); }
        else await startFunctions.get(environment.name)!();
        await saveManifest(out, manifest);
        return environment;
      });
      lifecycle = work.catch(() => undefined);
      void work.then(value => { res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(value)); },
        () => { res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Fixture lifecycle/bootstrap integration unavailable' })); });
    });
    await new Promise<void>((resolveControl, reject) => {
      controlServer!.once('error', reject);
      controlServer!.listen(manifest.controlSocket, () => { controlServer!.off('error', reject); resolveControl(); });
    });
    await chmod(manifest.controlSocket, 0o600);
    return { manifest, manifestPath: out, children, stop, pairing, paused,
      waitForFailure: () => new Promise<never>((_resolve, reject) => { if (failed) reject(new Error('Owned backend exited unexpectedly')); else failureListener = reject; }),
    };
  } catch (error) {
    await stop(true);
    throw new Error(`Harness launch failed; artifacts preserved in ${artifactRoot}`, { cause: error });
  }
}
export async function controlEnvironment<T>(manifest: FleetManifest, name: string, action: 'stop' | 'start' | 'bootstrap'): Promise<T> {
  if (!isWithin(manifest.root, manifest.controlSocket)) throw new Error('Control socket outside marked root');
  const marker = JSON.parse(await readFile(join(manifest.root, markerName), 'utf8'));
  if (marker.runId !== manifest.runId || marker.root !== await realpath(manifest.root)) throw new Error('Unmarked fleet control root');
  return new Promise<T>((resolveControl, reject) => {
    const req = controlRequest({ socketPath: manifest.controlSocket, path: `/environment/${name}/${action}`, method: 'POST', timeout: 30_000 }, res => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); if (body.length > 65536) req.destroy(new Error('Oversized private control response')); });
      res.on('end', () => { if (res.statusCode !== 200) reject(new Error('V2 private bootstrap/lifecycle integration is pending or unavailable')); else { try { resolveControl(JSON.parse(body) as T); } catch { reject(new Error('Invalid private control response')); } } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Private fleet control timeout'))); req.end();
  });
}
function waitForReady(child: ChildProcess, dataDir: string): Promise<{ port: number }> {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => finish(new Error('Backend ready IPC timed out')), 30_000);
    const exit = () => finish(new Error('Backend exited before ready IPC'));
    const message = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const ready = value as { type?: string; port?: number; dataDir?: string };
      if (ready.type !== 'ready') return;
      if (!Number.isInteger(ready.port) || ready.port! < 1 || ready.dataDir !== dataDir) { finish(new Error('Backend ready IPC failed isolation check')); return; }
      finish(undefined, ready.port);
    };
    const finish = (error?: Error, port?: number) => {
      clearTimeout(timer); child.off('message', message); child.off('exit', exit); child.off('error', finish);
      if (error) reject(error); else resolveReady({ port: port! });
    };
    child.on('message', message); child.once('exit', exit); child.once('error', finish);
  });
}
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 10_000);
    const hardLimit = setTimeout(() => { cleanup(); reject(new Error('Owned backend did not exit')); }, 15_000);
    function cleanup() { clearTimeout(timer); clearTimeout(hardLimit); child.off('exit', exited); }
    function exited(code: number | null) { cleanup(); if (code === 0) resolveStop(); else reject(new Error('Owned backend required forced or unsuccessful teardown')); }
    child.once('exit', exited);
    if (child.connected) child.send({ type: 'shutdown' }, error => { if (error) child.kill('SIGTERM'); });
    else child.kill('SIGTERM');
  });
}
export function isWithin(root: string, path: string): boolean {
  const local = relative(root, path);
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}
async function main() {
  const args = process.argv.slice(2);
  const readOption = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  if (readOption('--provider') && readOption('--provider') !== 'fixture') throw new Error('Only the fixture provider is supported');
  const fleet = await launchFleet({ environments: Number(readOption('--environments') ?? 3), out: readOption('--out') });
  console.log(`Fleet ready: ${fleet.manifest.environments.length} isolated backends; manifest ${fleet.manifestPath}`);
  const onSignal = () => { void fleet.stop().then(() => process.exit(0), () => process.exit(1)); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    if (args.includes('--smoke') || args.includes('--legacy-smoke')) {
      const evidence = args.includes('--legacy-smoke') ? await legacySmoke(fleet.manifest.environments[0]!) : undefined;
      await fleet.stop();
      await writeInfrastructureArtifacts(fleet.manifest, fleet.manifestPath, evidence);
      console.log('Fleet health and owned-child teardown passed');
    } else {
      await fleet.waitForFailure();
    }
  } catch (error) { await fleet.stop(true); throw error; }
  finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error); process.exitCode = 1; });
}
