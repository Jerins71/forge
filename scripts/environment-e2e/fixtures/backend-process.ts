import { installEnvironmentParentBootstrap } from '../../../apps/backend/src/environment/parent-bootstrap.js';
import { readFile, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createConfig } from '../../../apps/backend/src/config.js';
import { getWorkerPresetsPath, saveWorkerPresetSettings } from '../../../apps/backend/src/swarm/specialists/worker-presets.js';
import { startServer, type StartedServer } from '../../../apps/backend/src/server.js';
import { getNativeCodexHome, getSharedAuthFilePath } from '../../../apps/backend/src/swarm/storage/data-paths.js';
import { installHardeningHooks } from './hardening-hooks.js';

// Separate process per backend. Avoid index.ts's dotenv loading and Desktop-only
// ready gate; use the ordinary composition and its existing ready callback.
const lifecycle: { server?: StartedServer; shutdownRequested: boolean; stopping: boolean } = { shutdownRequested: false, stopping: false };
async function shutdown() {
  lifecycle.shutdownRequested = true;
  if (!lifecycle.server || lifecycle.stopping) return;
  lifecycle.stopping = true;
  try { await lifecycle.server.stop(); process.exit(0); } catch { process.exit(1); }
}
process.on('message', message => { if ((message as { type?: string })?.type === 'shutdown') void shutdown(); });
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('disconnect', () => void shutdown());
const checkout = resolve(process.env.FORGE_E2E_CHECKOUT!);
const fixture = JSON.parse(await readFile(resolve(checkout, '.fixture-environment.json'), 'utf8'));
if (fixture.formatVersion !== 1 || !process.env.FORGE_DATA_DIR || !/^\d+$/.test(process.env.FORGE_PORT ?? '')) throw new Error('Missing isolated fixture settings');
const authorizedPhysicalParent = process.env.FORGE_ENVIRONMENT_BOOTSTRAP_PARENT === '1' && Boolean(process.send);
delete process.env.FORGE_ENVIRONMENT_BOOTSTRAP_PARENT;
const config = createConfig();
const hardening = await installHardeningHooks(config.paths.dataDir, checkout);
process.on('message', message => {
  const request = message as { type?: string; requestId?: string; input?: { operation: string; commandId: string; boundary: Parameters<typeof hardening.arm>[0]['boundary'] } };
  if (request?.type !== 'forge:fixture:request') return;
  void (async () => {
    if (!request.input) throw new Error('Missing private fixture operation');
    const value = request.input.operation === 'arm-crash' ? hardening.arm(request.input) : await hardening.operate(request.input);
    process.send?.({ type: 'forge:fixture:result', requestId: request.requestId, value });
  })().catch(() => { process.send?.({ type: 'forge:fixture:result', requestId: request.requestId, error: 'Private fixture request rejected' }); });
});
config.paths.rootDir = checkout;
config.paths.resourcesDir = checkout;
config.paths.repoMemorySkillFile = resolve(checkout, '.swarm/skills/memory/SKILL.md');
config.defaultCwd = checkout;
config.cwdAllowlistRoots = [resolve(checkout, '..')];
const authFile = getSharedAuthFilePath(config.paths.dataDir);
await mkdir(dirname(authFile), { recursive: true });
await writeFile(authFile, JSON.stringify({ 'openai-codex': { type: 'api_key', key: 'forge-fixture-inert-not-a-provider-key' }, ...(process.env.FORGE_E2E_CLAUDE === '1' ? { anthropic: { type: 'api_key', key: 'sk-ant-fake-fixture' } } : {}) }), { mode: 0o600 });
// The native contract reader checks that rollout metadata is inside CODEX_HOME.
// Resolve that isolated home into the checkout so the fake writes only there.
const nativeHome = getNativeCodexHome(config.paths.dataDir);
const fixtureHome = resolve(checkout, '.fixture-codex/native-home');
await mkdir(fixtureHome, { recursive: true });
await mkdir(dirname(nativeHome), { recursive: true });
try { await symlink(fixtureHome, nativeHome, process.platform === 'win32' ? 'junction' : 'dir'); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await realpath(nativeHome) !== await realpath(fixtureHome)) throw error;
}
// Seeded once; a restart keeps the presets the environment has since (sync relies on that).
if (!existsSync(getWorkerPresetsPath(config.paths.dataDir))) await saveWorkerPresetSettings(config.paths.dataDir, { version: 2, presets: [
  { name: 'fixture-worker', provider: 'codex-native', modelId: 'gpt-6-sol', reasoningLevel: 'high', note: 'Synthetic E2E worker.' },
] }, () => true);
// FORGE_E2E_DEFAULT_LABEL names the one environment that keeps its default (hostname) label.
lifecycle.server = await startServer({ config, environmentIdentity: { ...(process.env.FORGE_E2E_DEFAULT_LABEL === fixture.instanceId ? {} : { label: fixture.instanceId }), ...(process.env.FORGE_E2E_LINEAGE === '1' && fixture.instanceId === 'env-c' ? { capabilities: { projectAgentMetadata: true, sessionState: true, shellResume: true, sessionDetail: true, durableCommands: true, newWorktree: true, artifactUpload: true, terminal: true, cliTransport: true, sessionLifecycle: true, projectPolicy: true, contextTransfers: false } } : {}) }, onReady: ({ port, environment }) => {
  if (process.connected) process.send?.({ type: 'ready', port, dataDir: config.paths.dataDir, environment }, () => {});
} });
installEnvironmentParentBootstrap({ authorizedPhysicalParent, createGrant: () => lifecycle.server!.createBootstrapGrant() });
if (lifecycle.shutdownRequested || !process.connected) await shutdown();
