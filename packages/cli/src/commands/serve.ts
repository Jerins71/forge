import { spawn, execFile } from 'node:child_process';
import { open, readFile, stat, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { getHostInstallationStateDir } from '../../../../apps/backend/src/swarm/storage/data-paths.js';
import { promisify } from 'node:util';
import { isAbsolute, join } from 'node:path';
import type { CommandContext } from './types.js';

export interface ServeOptions {
  backendEntry?: string; manifestPath?: string; cwd?: string; host?: string; port?: number; dataDir?: string;
  publicUrl?: string; tlsCert?: string; tlsKey?: string; tailscaleServe?: boolean;
  pair?: boolean; pairOutput?: string; interactive?: boolean; env?: NodeJS.ProcessEnv;
  recovery?: 'rekey' | 'adopt' | 'restore'; previousDataDir?: string;
}
export function validateServeOptions(options: ServeOptions): void {
  for (const value of [options.backendEntry, options.manifestPath, options.dataDir, options.tlsCert, options.tlsKey, options.pairOutput, options.previousDataDir]) if (value && !isAbsolute(value)) throw new Error('Explicit paths must be absolute');
  const host = options.host ?? '127.0.0.1';
  const loopback = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new Error('Port must be between 0 and 65535');
  if (Boolean(options.tlsCert) !== Boolean(options.tlsKey)) throw new Error('Supply both --tls-cert and --tls-key');
  if (options.tailscaleServe && !loopback) throw new Error('Tailscale serve requires loopback binding');
  if (!loopback && (!options.publicUrl || !options.tlsCert && !options.env?.FORGE_TRUSTED_PROXY_PEER)) throw new Error('Non-loopback binding requires --public-url and TLS certificate/key or configured trusted loopback reverse proxy');
  if (options.publicUrl) { const u = new URL(options.publicUrl); if (u.username || u.password || u.hash || u.search || u.pathname !== '/' || !['http:', 'https:'].includes(u.protocol) || (!loopback || options.tailscaleServe) && u.protocol !== 'https:') throw new Error('Public URL must be an explicit HTTPS origin for remote access'); }
  if (options.pair && !options.pairOutput && !(options.interactive ?? (process.stdin.isTTY && process.stderr.isTTY))) throw new Error('Noninteractive --pair requires --pair-output <absolute-file>; pairing credentials cannot go to ordinary stdout');
  if (options.pairOutput && !options.pair) throw new Error('--pair-output requires --pair');
}
export function installationManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FORGE_INSTALLATION_MANIFEST) return env.FORGE_INSTALLATION_MANIFEST;
  const dir = getHostInstallationStateDir(process.platform, env);
  return join(dir, 'manifest.json');
}
export async function resolveBackendEntry(options: Pick<ServeOptions, 'backendEntry' | 'manifestPath' | 'env'>): Promise<string> {
  let entry = options.backendEntry;
  if (!entry) {
    const manifestPath = options.manifestPath ?? installationManifestPath(options.env);
    if (!isAbsolute(manifestPath)) throw new Error('Installation manifest must be an absolute path');
    try { entry = (JSON.parse(await readFile(manifestPath, 'utf8')) as { backendEntry?: string }).backendEntry; } catch { /* Clear actionable missing-backend error below. */ }
  }
  if (!entry) throw new Error('Forge backend is not installed. Use --backend-entry <absolute-file> from a Forge installation; the standalone CLI does not include server assets.');
  if (!isAbsolute(entry)) throw new Error('Backend entry must be an absolute file path');
  if (!(await stat(entry).catch(() => null))?.isFile()) throw new Error('Forge backend entry does not exist. Build/install the backend or supply --backend-entry <absolute-file>.');
  return entry;
}
export async function protectCliOutput(path: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username;
  await promisify(execFile)('icacls', [path, '/inheritance:r', '/grant:r', `${user}:(F)`], {windowsHide:true});
}
export async function serveBackend(options: ServeOptions): Promise<number> {
  if (options.tailscaleServe && !options.publicUrl) {
    try { const status = JSON.parse((await promisify(execFile)('tailscale', ['status','--json'], {windowsHide:true})).stdout) as {Self?:{DNSName?:string}}; const host = status.Self?.DNSName?.replace(/\.$/,''); if (!host || !/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error(); options = {...options,publicUrl:`https://${host}`}; }
    catch { throw new Error('Tailscale must be installed and connected; supply --public-url <tailnet-https-origin> or configure Tailscale first'); }
  }
  validateServeOptions(options);
  const entry = await resolveBackendEntry(options);
  const pairFile = options.pairOutput ? await open(options.pairOutput, 'wx', 0o600) : null;
  if (options.pairOutput) { try { await protectCliOutput(options.pairOutput); } catch { await pairFile?.close(); await rm(options.pairOutput,{force:true}); throw new Error('Could not restrict pairing output to the current user'); } }
  let wrotePair = false;
  const env = { ...(options.env ?? process.env), FORGE_HOST: options.host ?? '127.0.0.1', FORGE_PORT: String(options.port ?? 47187), FORGE_ENVIRONMENT_BOOTSTRAP_PARENT: options.pair ? '1' : '0', ...(options.dataDir ? { FORGE_DATA_DIR: options.dataDir } : {}), ...(options.publicUrl ? { FORGE_PUBLIC_URL: options.publicUrl } : {}), ...(options.tlsCert ? { FORGE_TLS_CERT: options.tlsCert, FORGE_TLS_KEY: options.tlsKey } : {}), ...(options.tailscaleServe ? { FORGE_EXPOSURE_MODE: 'tailscale' } : {}), ...(options.recovery ? { FORGE_ENVIRONMENT_RECOVERY: options.recovery } : {}), ...(options.previousDataDir ? { FORGE_ENVIRONMENT_ADOPT_FROM: options.previousDataDir } : {}) };
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [entry], { env, cwd: options.cwd ?? process.cwd(), stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true });
      let requested = false; let bootstrapReceived = false; let settled = false; let pendingWrite: Promise<void> | null = null;
      const requestId = `serve-${process.pid}-${Date.now()}`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signals = ['SIGINT', 'SIGTERM'] as const;
      const forward = (signal: NodeJS.Signals) => { if (!child.killed) child.kill(signal); };
      const handlers = signals.map(signal => { const handler = () => forward(signal); process.on(signal, handler); return handler; });
      const clean = () => { if (timer) clearTimeout(timer); signals.forEach((signal, i) => process.off(signal, handlers[i]!)); };
      const fail = (error: Error) => { if (settled) return; settled = true; clean(); child.kill(); reject(error); };
      child.on('error', () => fail(new Error('Could not launch Forge backend')));
      child.on('message', (message: unknown) => {
        const m = message as { type?: string; requestId?: string; grant?: { pairingUrl?: string }; error?: unknown };
        if (m.type === 'ready' && options.pair && !requested) {
          requested = true;
          timer = setTimeout(() => fail(new Error('Private backend pairing bootstrap timed out')), 15_000);
          child.send?.({ type: 'forge:environment-bootstrap:request', requestId }, e => { if (e) fail(new Error('Private backend pairing channel failed')); });
        }
        if (m.type === 'forge:environment-bootstrap:result' && m.requestId === requestId) {
          if (!requested || bootstrapReceived || !options.pair) return;
          bootstrapReceived = true;
          if (timer) clearTimeout(timer);
          if (!m.grant?.pairingUrl || m.error) { fail(new Error('Private backend pairing bootstrap was rejected')); return; }
          pendingWrite = (async () => { if (pairFile) { await pairFile.writeFile(m.grant!.pairingUrl! + '\n'); await pairFile.sync(); } else process.stderr.write(`Pair with this environment (expires in 60 seconds):\n${m.grant!.pairingUrl}\n`); wrotePair = true; })();
          pendingWrite.catch(() => fail(new Error('Protected pairing output could not be written')));
        }
      });
      child.on('exit', async (code, signal) => {
        if (settled) return;
        if (pendingWrite) { try { await pendingWrite; } catch { return; } }
        if (options.pair && !wrotePair) { fail(new Error('Backend exited before private pairing bootstrap completed')); return; }
        settled = true; clean(); resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
      });
    });
  } finally { await pairFile?.close(); if (options.pairOutput && !wrotePair) await rm(options.pairOutput, { force: true }); }
}
export async function handleServeCommand(context: CommandContext): Promise<number> {
  const o = context.args.options;
  return serveBackend({ backendEntry: o.backendEntry, cwd: context.cwd, host: o.host ?? context.env.FORGE_HOST, port: o.port === undefined && context.env.FORGE_PORT === undefined ? undefined : Number(o.port ?? context.env.FORGE_PORT), dataDir: o.dataDir ?? context.env.FORGE_DATA_DIR, publicUrl: o.publicUrl ?? context.env.FORGE_PUBLIC_URL, tlsCert: o.tlsCert ?? context.env.FORGE_TLS_CERT, tlsKey: o.tlsKey ?? context.env.FORGE_TLS_KEY, tailscaleServe: o.tailscaleServe ?? context.env.FORGE_EXPOSURE_MODE === 'tailscale', pair: o.pair, pairOutput: o.pairOutput, env: context.env });
}
