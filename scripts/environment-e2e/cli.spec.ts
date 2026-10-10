// Batch 8: paired CLI behavior against owned backends. Each case has a 15s cap;
// wire evidence contains method names/IDs and counts, never credentials or messages.
import { expect } from '@playwright/test';
import { test } from './fixtures/test.js';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from './fixtures/ws.js';
import { readManifest, controlEnvironment, type FleetManifest, type BootstrapSession } from './launch.js';
import { seedUiEnvironment } from './fixtures/ui-fleet.js';
import { fixtureRpcOnce, openFixtureRpc, until } from './fixtures/rpc-client.js';
import { ForgeClient } from '../../packages/cli/src/forge-client.js';
import { runCli } from '../../packages/cli/src/commands/index.js';
import { pairEnvironment, type CliEnvironmentCredential } from '../../packages/cli/src/commands/pair.js';

test.use({ environmentSuite: 'cli' });
test.describe.configure({ mode: 'serial', timeout: 15_000 });
let manifest: FleetManifest;
let admin: BootstrapSession;
let credential: CliEnvironmentCredential;
let client: ForgeClient;
let projectId: string;
let sessionId: string;
let credentialFile: string;
const methods: string[] = [];
const endpoints: string[] = [];
const evidence: Record<string, unknown> = {};
class RecordingSocket extends WebSocket {
  constructor(url: any, protocols: any) { super(url, protocols); endpoints.push(new URL(String(url)).pathname); }
  override send(data: any, ...args: any[]): void {
    const frame = JSON.parse(String(data));
    methods.push(frame.method ?? frame.type);
    super.send(data, ...args);
  }
}
test.beforeAll(async () => {
  manifest = await readManifest(process.env.FORGE_E2E_MANIFEST!);
  const environment = manifest.environments[1]!;
  admin = await controlEnvironment<BootstrapSession>(manifest, environment.name, 'bootstrap');
  projectId = (await seedUiEnvironment(environment, admin)).sessionId;
  const grant = await fixtureRpcOnce(environment.baseUrl, admin, 'access.grant.create', { kind: 'code', label: 'CLI acceptance', scopes: ['session:read','session:operate','workspace:read','workspace:write'], expiresInSeconds: 300, reachableBaseUrl: environment.baseUrl });
  await pairEnvironment({ target: environment.baseUrl, code: grant.code, scopes: ['session:read','session:operate','workspace:read','workspace:write'], credentialStore: { store: async value => { credential = value; } } });
  credentialFile = join(environment.installationStateDir, 'cli-credential.json');
  await writeFile(credentialFile, JSON.stringify(credential), { mode: 0o600 });
  client = new ForgeClient({ credential, WebSocketImpl: RecordingSocket } as any);
});
test.afterAll(async () => {
  expect(endpoints.every(path => path === '/api/v2/rpc')).toBe(true);
  expect(methods.every(method => !method.startsWith('legacy.') && !method.startsWith('cli_') && method !== 'subscribe_headless')).toBe(true);
  await writeFile(join(manifest.artifactRoot, 'cli-acceptance.json'), JSON.stringify({ ...evidence, environmentId: credential?.environmentId, methods, endpoints, zeroLegacyFrames: true }, null, 2));
});
test('selects the paired credential and preserves exact JSON and human read output', async () => {
  let stdout = ''; let stderr = '';
  const io = { stdout: { write: (text: string) => { stdout += text; } }, stderr: { write: (text: string) => { stderr += text; } } };
  const args = ['--credential-file', credentialFile, '--environment-id', credential.environmentId];
  expect(await runCli(['sessions','show',projectId,'--json',...args], { cwd: manifest.environments[1]!.checkout, env: {}, io })).toBe(0);
  expect(JSON.parse(stdout)).toEqual(await client.showSession(projectId)); expect(stderr).toBe('');
  stdout = '';
  expect(await runCli(['profiles','list',...args], { cwd: manifest.environments[1]!.checkout, env: {}, io })).toBe(0);
  expect(stdout).toContain('Shared fixture'); expect(stdout).not.toContain(credential.bearerToken);
});
test('native create/send/run/wait retains CLI invocation and never marks read', async () => {
  const created = await client.createSession({ profileId: projectId, label: 'CLI native', invocationCwd: '/fixture/invocation' });
  sessionId = created.session.agentId;
  expect(created.session.cli).toMatchObject({ createdBy: 'forge-cli', command: 'sessions create', invocationCwd: '/fixture/invocation' });
  const result = await client.run({ command: 'run', target: { kind: 'session', agentId: sessionId }, text: 'CLI fixture response', timeoutMs: 10_000 });
  expect(result).toMatchObject({ status: 'success', sessionAgentId: sessionId, timedOut: false, blocked: null });
  expect(result.finalMessage).toBeTruthy();
  const shell = await openFixtureRpc(credential.baseUrl, admin);
  async function unread(): Promise<number> {
    await shell.call('shell.subscribe', {});
    const snapshot = await until(() => shell.frames.filter(frame => frame.item?.kind === 'snapshot').at(-1)?.item.snapshot, Boolean);
    return snapshot.sessions.find((row: any) => row.sessionId === sessionId).unread;
  }
  const unreadBefore = await unread();
  const before = methods.length;
  expect(await client.waitForSession(sessionId, { timeoutMs: 3000 })).toMatchObject({ status: 'success' });
  expect(methods.slice(before)).toContain('session.subscribe');
  expect(methods.slice(before)).not.toContain('session.readState.set');
  expect(await unread()).toBe(unreadBefore); shell.close();
  evidence.run = result.status;
});
test('native stop/resume/fork/clear retains output shapes and survives restart', async () => {
  expect(await client.stopSession(sessionId)).toMatchObject({ agentId: sessionId });
  expect(await client.resumeSession(sessionId)).toMatchObject({ agentId: sessionId });
  const fork = await client.forkSession(sessionId, { label: 'CLI fork' }) as any;
  expect(fork).toMatchObject({ sourceAgentId: sessionId, session: { profileId: projectId, displayName: 'CLI fork' } });
  expect(await client.clearSession(fork.session.agentId)).toMatchObject({ agentId: fork.session.agentId });
  await controlEnvironment(manifest, manifest.environments[1]!.name, 'stop');
  await controlEnvironment(manifest, manifest.environments[1]!.name, 'start');
  expect((await client.showSession(fork.session.agentId)).session).toMatchObject({ agentId: fork.session.agentId, displayName: 'CLI fork' });
  await client.deleteSession(fork.session.agentId);
  await expect(client.showSession(fork.session.agentId)).rejects.toMatchObject({ code: 'not_found' });
  evidence.lifecycleRestart = true;
});
test('resolves Project Agent in selected environment and preserves timeout exit code', async () => {
  await fixtureRpcOnce(credential.baseUrl, admin, 'projectAgent.set', { commandId: randomUUID(), sessionId, projectAgent: { handle: 'cli-agent', whenToUse: 'CLI acceptance' } });
  const launched = await client.sendProjectAgentMessage(projectId, 'cli-agent', { text: 'CLI target response' });
  expect(launched).toMatchObject({ profileId: projectId, sessionAgentId: sessionId });
  await until(() => client.showSession(sessionId), response => response.session.status === 'idle');
  const result = await client.run({ command: 'run', target: { kind: 'project_agent', profileId: projectId, handle: 'cli-agent' }, text: 'CLI timeout', timeoutMs: 1, stopOnTimeout: true });
  expect(result).toMatchObject({ status: 'timeout', projectAgentHandle: 'cli-agent', timedOut: true });
  expect((await client.showSession(sessionId)).session.status).toBe('stopped');
  evidence.projectAgent = true;
});
test('revoked device fails closed without legacy fallback', async () => {
  await fixtureRpcOnce(credential.baseUrl, admin, 'access.devices.revoke', { deviceSessionId: credential.deviceSessionId });
  await expect(client.sendSessionMessage(sessionId, { text: 'denied' })).rejects.toMatchObject({ exitCode: 21 });
  evidence.revocation = true;
});
