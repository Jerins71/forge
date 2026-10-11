import type { RpcOutput } from '@forge/protocol/environment-v2';
// Batch 8: paired CLI behavior against owned backends. Each case has a 15s cap;
// wire evidence contains method names/IDs and counts, never credentials or messages.
import { expect } from '@playwright/test';
import { test } from './fixtures/test.js';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { getSessionFilePath } from '../../apps/backend/src/swarm/storage/data-paths.js';
import { join } from 'node:path';
import { WebSocket } from './fixtures/ws.js';
import { readManifest, controlEnvironment, type FleetManifest, type BootstrapSession } from './launch.js';
import { seedUiEnvironment } from './fixtures/ui-fleet.js';
import { fixtureRpcOnce, openFixtureRpc, until } from './fixtures/rpc-client.js';
import { ForgeClient } from '../../packages/cli/src/forge-client.js';
import { runCli } from '../../packages/cli/src/commands/index.js';
import { startFaultProxy } from './fault-proxy.js';
import { pairEnvironment, type CliEnvironmentCredential } from '../../packages/cli/src/commands/pair.js';
import { createEnvironmentRegistry, createMemoryCredentialStore, createMemoryPersistence } from '../../packages/client-runtime/dist/index.js';


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
async function sessionProjection(id: string): Promise<any> {
  const shell = await openFixtureRpc(credential.baseUrl, admin);
  try {
    await shell.call('shell.subscribe', {});
    const snapshot = await until<any>(() => shell.frames.filter(frame => frame.item?.kind === 'snapshot').at(-1)?.item.snapshot, Boolean);
    return snapshot.sessions.find((row: any) => row.sessionId === id);
  } finally { shell.close(); }
}
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
  await until(() => client.showSession(projectId), response => response.session.status === 'idle');
});
test.afterAll(async () => {
  expect(endpoints.every(path => path === '/api/v2/rpc')).toBe(true);
  expect(methods.every(method => !method.startsWith('legacy.') && !method.startsWith('cli_') && method !== 'subscribe_headless')).toBe(true);
  await writeFile(join(manifest.artifactRoot, 'cli-acceptance.json'), JSON.stringify({ ...evidence, environmentId: credential?.environmentId, methods, endpoints, zeroLegacyFrames: true }, null, 2));
});
test('selects the paired credential and preserves exact JSON and human read output', async () => {
  let stdout = ''; let stderr = '';
  const io = { stdout: { write: (text: string) => { stdout += text; } }, stderr: { write: (text: string) => { stderr += text; } } } as never;
  const args = ['--credential-file', credentialFile, '--environment-id', credential.environmentId];
  expect(await runCli(['sessions','show',projectId,'--json',...args], { cwd: manifest.environments[1]!.checkout, env: {}, io })).toBe(0);
  expect(JSON.parse(stdout)).toEqual(await client.showSession(projectId)); expect(stderr).toBe('');
  stdout = '';
  expect(await runCli(['profiles','list',...args], { cwd: manifest.environments[1]!.checkout, env: {}, io })).toBe(0);
  expect(stdout).toContain('Shared fixture'); expect(stdout).not.toContain(credential.bearerToken);
});
test('macOS OS-vault selection reads the existing paired storage and cleans its synthetic entry', async () => {
  test.skip(process.platform !== 'darwin', 'OS vault verification is platform-specific');
  const grant = await fixtureRpcOnce(credential.baseUrl, admin, 'access.grant.create', { kind: 'code', label: 'CLI vault acceptance', scopes: ['session:read','session:operate','workspace:read','workspace:write'], expiresInSeconds: 300, reachableBaseUrl: credential.baseUrl });
  const paired = await pairEnvironment({ target: credential.baseUrl, code: grant.code, scopes: ['session:read','session:operate','workspace:read','workspace:write'] });
  try {
    let stdout = '';
    expect(await runCli(['sessions', 'show', projectId, '--environment-id', credential.environmentId, '--json'], { cwd: manifest.environments[1]!.checkout, env: {}, io: { stdout: { write: (text: string) => { stdout += text; } }, stderr: { write: () => {} } } as never })).toBe(0);
    expect(JSON.parse(stdout)).toEqual(await client.showSession(projectId));
    evidence.osVaultSelection = true;
  } finally { await promisify(execFile)('/usr/bin/security', ['delete-generic-password', '-s', `forge.environment.${credential.environmentId}`, '-a', paired.deviceSession.deviceSessionId], { cwd: manifest.environments[1]!.checkout }); }
});
test('native create/send/run/wait retains CLI invocation and never marks read', async () => {
  const created = await client.createSession({ profileId: projectId, label: 'CLI native', invocationCwd: '/fixture/invocation' });
  sessionId = created.session.agentId;
  expect(created.session.cli).toMatchObject({ createdBy: 'forge-cli', command: 'sessions create', invocationCwd: '/fixture/invocation' });
  const result = await client.run({ command: 'run', target: { kind: 'session', agentId: sessionId }, text: 'CLI fixture response', timeoutMs: 10_000 });
  expect(result).toMatchObject({ status: 'success', sessionAgentId: sessionId, timedOut: false, blocked: null });
  expect(result.finalMessage).toBeTruthy();
  async function unread(): Promise<number> {
    return (await sessionProjection(sessionId)).unread;
  }
  const unreadBefore = await unread();
  const before = methods.length;
  expect(await client.waitForSession(sessionId, { timeoutMs: 3000 })).toMatchObject({ status: 'success' });
  expect(methods.slice(before)).toContain('session.subscribe');
  expect(methods.slice(before)).not.toContain('session.readState.set');
  expect(await unread()).toBe(unreadBefore);
  evidence.run = result.status;
});
test('receipt loss reuses one native command ID and one reserved session', async () => {
  const proxy = await startFaultProxy({ upstream: credential.baseUrl });
  try {
    proxy.dropNextResponse({ transport: 'ws', method: 'session.launch', closeAfterDrop: true });
    const remote = new ForgeClient({ credential: { ...credential, baseUrl: proxy.url }, WebSocketImpl: RecordingSocket as never });
    const created = await remote.createSession({ profileId: projectId, label: 'Dropped CLI receipt' });
    expect(new Set(proxy.metrics().commandAttempts.map(attempt => attempt.commandId)).size).toBe(1);
    expect(created.session.agentId).toBe(`v2-${proxy.metrics().commandAttempts[0]!.commandId}`);
    evidence.receiptLoss = { commands: new Set(proxy.metrics().commandAttempts.map(attempt => attempt.commandId)).size, dropped: proxy.metrics().droppedResponses };
    await client.deleteSession(created.session.agentId);
  } finally { await proxy.stop(); }
});
test('choice answer/cancel and compaction use native controls with exact result shapes', async () => {
  const blocked = await client.run({ command: 'run', target: { kind: 'session', agentId: sessionId }, text: '[fixture:choice]', timeoutMs: 5000 });
  expect(blocked.status).toBe('blocked');
  const choice = blocked.blocked!.choices[0]!;
  expect(choice).toEqual((await client.showChoice(choice.choiceId, sessionId)).choice);
  expect(await client.answerChoice(choice.choiceId, [{ questionId: choice.questions![0]!.id, selectedOptionIds: [choice.questions![0]!.options![0]!.id] }])).toEqual({ choiceId: choice.choiceId, sessionAgentId: sessionId, status: 'answered' });
  expect(await client.waitForSession(sessionId, { timeoutMs: 5000 })).toMatchObject({ status: 'success' });
  expect(await client.compactSession(sessionId, { customInstructions: '   ' })).toMatchObject({ action: 'compact', sessionAgentId: sessionId, profileId: projectId, outcome: 'compacted', compacted: true, customInstructionsProvided: false });
  const again = await client.run({ command: 'run', target: { kind: 'session', agentId: sessionId }, text: '[fixture:choice]', timeoutMs: 5000 });
  const canceled = again.blocked!.choices[0]!;
  expect(await client.cancelChoice(canceled.choiceId)).toEqual({ choiceId: canceled.choiceId, sessionAgentId: sessionId, status: 'cancelled' });
  await client.stopSession(sessionId); await client.resumeSession(sessionId);
  evidence.choicesAndCompaction = true;
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
  const result = await client.run({ command: 'run', target: { kind: 'project_agent', profileId: projectId, handle: 'cli-agent' }, text: '[fixture:hold]', timeoutMs: 1, stopOnTimeout: true });
  expect(result).toMatchObject({ status: 'timeout', projectAgentHandle: 'cli-agent', timedOut: true });
  expect((await sessionProjection(sessionId)).status).toBe('stopped');
  expect((await client.showSession(sessionId)).session.status).toBe('stopped');
  const resumed = await client.run({ command: 'run', target: { kind: 'project_agent', profileId: projectId, handle: 'cli-agent' }, text: 'Resume after timeout', timeoutMs: 5000 });
  expect(resumed).toMatchObject({ status: 'success', sessionAgentId: sessionId, timedOut: false });
  expect((await client.showSession(sessionId)).session.status).toBe('idle');
  expect((await sessionProjection(sessionId)).status).toBe('idle');
  evidence.projectAgent = { timeoutStopped: true, nextSendResumed: true };
});
test('rename/pin update the selected environment and fresh bootstrap only', async () => {
  expect(await client.renameSession(sessionId, 'Paired CLI renamed')).toEqual({ agentId: sessionId, label: 'Paired CLI renamed' });
  expect(await client.pinSession(sessionId, true)).toMatchObject({ agentId: sessionId, pinned: true, pinnedAt: expect.any(String) });
  await controlEnvironment(manifest, manifest.environments[1]!.name, 'stop');
  await controlEnvironment(manifest, manifest.environments[1]!.name, 'start');
  expect((await client.showSession(sessionId)).session).toMatchObject({ sessionLabel: 'Paired CLI renamed', pinnedAt: expect.any(String) });
  expect((await sessionProjection(sessionId)).title).toBe('Paired CLI renamed');
  let printed = '';
  expect(await runCli(['sessions', 'list', '--profile', projectId, '--credential-file', credentialFile], { cwd: manifest.environments[1]!.checkout, env: {}, io: { stdout: { write: (text: string) => { printed += text; } }, stderr: { write: () => {} } } as never })).toBe(0);
  expect(printed.split('\n').find(line => line.includes(sessionId))).toContain('Paired CLI renamed');
  expect(await client.pinSession(sessionId, false)).toEqual({ agentId: sessionId, pinned: false, pinnedAt: null });
  const foreign = new ForgeClient({ credential: { ...credential, environmentId: manifest.environments[0]!.environment!.environmentId } });
  await expect(foreign.sendSessionMessage(sessionId, { text: 'identity mismatch' })).rejects.toMatchObject({ exitCode: 21 });
  evidence.organizationRestart = true;
});
async function uiConsumer(id: string) {
  const credentials = createMemoryCredentialStore();
  await credentials.store(credential.environmentId, credential);
  const registry = createEnvironmentRegistry({ persistence: createMemoryPersistence(), credentials, fetch, webSocket: (url, protocols) => new WebSocket(url, protocols), random: () => 0.01 });
  await registry.register({ environmentId: credential.environmentId, baseUrl: credential.baseUrl, primary: true, enabled: true, credentialRef: credential.deviceSessionId, labelOverride: null });
  await registry.start();
  const environment = registry.get(credential.environmentId);
  await until(() => environment.connection.getSnapshot().phase, phase => phase === 'online');
  const calls: { method: string; input: any; receipt: any }[] = [];
  const requests: { method: string; input: any }[] = [];
  const request = environment.request.bind(environment);
  environment.request = (async (method: any, input: any, options: any) => {
    if ('commandId' in input) requests.push({ method, input });
    const receipt = await request(method, input, options);
    if ('commandId' in input) calls.push({ method, input, receipt });
    return receipt;
  }) as typeof environment.request;
  const uiModulePath = '../../apps/ui/src/lib/ws-client.js';
  const { ManagerWsClient } = await import(uiModulePath);
  const facade = new ManagerWsClient('', id, { environmentClient: environment });
  await until(() => facade.getState().conversationBootstrap.phase, phase => phase === 'ready');
  return { facade, calls, requests, dispose: async () => { facade.destroy(); await registry.dispose(); } };
}
async function replayLifecycle(calls: { method: string; input: any; receipt: any }[]) {
  await controlEnvironment(manifest, manifest.environments[1]!.name, 'stop');
  await controlEnvironment(manifest, manifest.environments[1]!.name, 'start');
  const paired = { ...admin, bearer: credential.bearerToken, deviceSessionId: credential.deviceSessionId };
  for (const { method, input, receipt } of calls) {
    expect(method.startsWith('legacy.')).toBe(false);
    const before = await fixtureRpcOnce(credential.baseUrl, paired, 'command.get', { commandId: input.commandId });
    expect(before.state).toBe('succeeded');
    expect(await fixtureRpcOnce(credential.baseUrl, paired, method, input)).toEqual(before);
    expect(before.commandId).toBe(receipt.commandId);
  }
}
test('UI resume/fork/clear/archive/restore/delete consumers replay their receipts after restart', async () => {
  const owner = await client.createSession({ profileId: projectId, label: 'UI lifecycle owner' });
  const id = owner.session.agentId;
  await client.run({ command: 'run', target: { kind: 'session', agentId: id }, text: 'Persist UI owner', timeoutMs: 5000 });
  const ui = await uiConsumer(id);
  try {
    await ui.facade.stopSession(id); await ui.facade.resumeSession(id);
    const fork = await ui.facade.forkSession(id, 'UI native fork');
    await ui.facade.clearSession(fork.newSessionAgent.agentId);
    await ui.facade.archiveSession(fork.newSessionAgent.agentId);
    await ui.facade.restoreSession(fork.newSessionAgent.agentId);
    await ui.facade.deleteSession(fork.newSessionAgent.agentId);
    await ui.dispose();
    await replayLifecycle(ui.calls);
    expect((await client.showSession(id)).session.displayName).toBe('UI lifecycle owner');
    evidence.uiLifecycleReplay = ui.calls.map(call => call.method);
  } finally { await ui.dispose(); }
});
test('UI worker stop/resume/Delete, choice cancel and stop-all preserve parent authority and replay', async () => {
  const owner = await client.createSession({ profileId: projectId, label: 'UI worker owner' });
  const id = owner.session.agentId;
  const ui = await uiConsumer(id);
  try {
    const blocked = await client.run({ command: 'run', target: { kind: 'session', agentId: id }, text: '[fixture:spawn-choice]', timeoutMs: 5000 });
    const choice = blocked.blocked!.choices[0]!;
    await until(() => ui.facade.getState().agents, agents => (agents as any[]).some((agent: any) => agent.agentId === choice.agentId));
    ui.facade.sendChoiceCancel(choice.agentId, choice.choiceId);
    await until(() => ui.calls, calls => calls.some(call => call.method === 'session.choice.cancel'));
    await ui.facade.stopSession(choice.agentId);
    expect((await client.showAgent(choice.agentId)).agent.status).toBe('idle');
    await ui.facade.resumeSession(choice.agentId);
    expect((await client.showAgent(choice.agentId)).agent.status).toBe('idle');
    await expect(fixtureRpcOnce(credential.baseUrl, admin, 'worker.kill', { commandId: randomUUID(), sessionId: projectId, workerId: choice.agentId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    ui.facade.deleteAgent(choice.agentId);
    await until(() => ui.calls, calls => calls.some(call => call.method === 'worker.delete'));
    await until(() => client.listAgents(projectId), reply => !reply.agents.some(agent => agent.agentId === choice.agentId));
    await expect(client.showAgent(choice.agentId)).rejects.toMatchObject({ code: 'not_found' });
    expect((await sessionProjection(id)).status).not.toBe('stopped');
    await client.run({ command: 'run', target: { kind: 'session', agentId: id }, text: '[fixture:spawn]', timeoutMs: 5000 });
    const retainedWorker = (await client.listAgents(projectId)).agents.find(agent => agent.role === 'worker' && agent.managerId === id && agent.agentId !== choice.agentId)!;
    await ui.facade.stopAllAgents(id);
    expect(ui.calls.some(call => call.method === 'session.stopAll')).toBe(true);
    expect((await client.showAgent(retainedWorker.agentId)).agent.status).toBe('idle');
    await until(() => sessionProjection(id), session => session.status === 'stopped');
    await ui.dispose();
    await replayLifecycle(ui.calls);
    expect((await sessionProjection(id)).status).toBe('stopped');
    evidence.uiWorkerReplay = ui.calls.map(call => call.method);
  } finally { await ui.dispose(); }
});
test('retained API-key HTTP reads and Stream Deck create/send/stop/resume remain functional', async () => {
  const response = await fetch(`${credential.baseUrl}/api/settings/cli-access/keys`, { method: 'POST', headers: { Authorization: `Bearer ${admin.bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Batch 8 integration acceptance' }) });
  if (response.status !== 201) throw new Error(`Fixture key creation rejected: ${response.status} ${(await response.json() as { error?: { message?: string } }).error?.message}`);
  const generated = await response.json() as { key: { id: string }; plaintextKey: string };
  const headers = { Authorization: `Bearer ${generated.plaintextKey}`, 'Content-Type': 'application/json' };
  const legacy = new ForgeClient({ url: credential.baseUrl, apiKey: generated.plaintextKey });
  expect((await legacy.showSession(sessionId)).session.sessionLabel).toBe('Paired CLI renamed');
  await expect(legacy.sendSessionMessage(sessionId, { text: 'upgrade required' })).rejects.toMatchObject({ code: 'pairing_required', exitCode: 23 });
  async function action(input: unknown): Promise<any> {
    const reply = await fetch(`${credential.baseUrl}/api/stream-deck/actions`, { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), ...input as object }) });
    expect(reply.status).toBe(200);
    return reply.json();
  }
  try {
    expect((await fetch(`${credential.baseUrl}/api/stream-deck/snapshot`, { headers })).status).toBe(200);
    const created = await action({ type: 'create_session', profileId: projectId, label: 'Deck native' });
    expect(created).toMatchObject({ ok: true, type: 'create_session' });
    const id = created.sessionAgentId;
    expect(await action({ type: 'send_prompt', sessionAgentId: id, text: 'Deck fixture prompt' })).toMatchObject({ ok: true });
    await until(() => client.showSession(id), result => result.session.status === 'idle');
    expect(await action({ type: 'stop_session', sessionAgentId: id })).toMatchObject({ ok: true });
    expect(await action({ type: 'resume_session', sessionAgentId: id })).toMatchObject({ ok: true });
    await client.deleteSession(id);
    evidence.retainedHttpIntegrations = true;
  } finally { await fetch(`${credential.baseUrl}/api/settings/cli-access/keys/${generated.key.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin.bearer}` } }); }
});



test('full paired URL selection refuses a different host before sending credentials', async () => {
  let stderr = '';
  const exit = await runCli(['sessions', 'show', projectId, '--json', '--credential-file', credentialFile, '--url', manifest.environments[0]!.baseUrl], { cwd: manifest.environments[1]!.checkout, env: {}, io: { stdout: { write: () => {} }, stderr: { write: (value: string) => { stderr += value; } } } as never });
  expect(exit).toBe(20);
  expect(JSON.parse(stderr)).toMatchObject({ error: { code: 'credential_url_mismatch' } });
  evidence.fullCredentialUrlPinned = true;
});

test('authenticated CLI provenance overrides client claims and survives backend restart', async () => {
  const created = await client.createSession({ profileId: projectId, label: 'Provenance review' });
  const id = created.session.agentId;
  const cliId = randomUUID(); const desktopId = randomUUID();
  const cliSession = { ...admin, bearer: credential.bearerToken, deviceSessionId: credential.deviceSessionId };
  await fixtureRpcOnce(credential.baseUrl, cliSession, 'session.send', { commandId: cliId, sessionId: id, message: { text: 'Paired CLI without a source claim', artifactIds: [] } });
  await fixtureRpcOnce(credential.baseUrl, admin, 'session.send', { commandId: desktopId, sessionId: id, message: { text: 'Desktop with a forged CLI source', artifactIds: [] }, source: { channel: 'cli', messageId: randomUUID() } });
  const environment = manifest.environments[1]!;
  const file = getSessionFilePath(environment.dataDir, projectId, id);
  async function provenance(): Promise<string[]> {
    const rows = (await readFile(file, 'utf8')).split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    return [cliId, desktopId].map(commandId => rows.find(row => row.data?.id === 'input-' + commandId)?.data.sourceContext?.channel);
  }
  await until(provenance, channels => channels[0] === 'cli' && channels[1] === 'web');
  await until(() => client.showSession(id), reply => reply.session.status === 'idle');
  await controlEnvironment(manifest, environment.name, 'stop'); await controlEnvironment(manifest, environment.name, 'start');
  expect(await provenance()).toEqual(['cli', 'web']);
  const transcript = await client.getSessionTranscript(id);
  expect(transcript.messages.filter(message => message.role === 'user')).toHaveLength(2);
  evidence.serverDerivedCliProvenance = { cli: 'cli', forgedDesktop: 'web', restart: true };
});

for (const status of ['stopped', 'error'] as const) test(`UI deletes a worker with its manager ${status} and replays the native receipt`, async () => {
  const owner = await client.createSession({ profileId: projectId, label: 'Worker Delete ' + status });
  const id = owner.session.agentId;
  const blocked = await client.run({ command: 'run', target: { kind: 'session', agentId: id }, text: '[fixture:spawn-choice]', timeoutMs: 5000 });
  const worker = blocked.blocked!.choices[0]!.agentId;
  const ui = await uiConsumer(id);
  try {
    await controlEnvironment(manifest, manifest.environments[1]!.name, 'fixture', { operation: 'manager-status', sessionId: id, status });
    ui.facade.deleteAgent(worker);
    await until(() => ui.calls, calls => calls.some(call => call.method === 'worker.delete'));
    await until(() => client.listAgents(projectId), reply => !reply.agents.some(agent => agent.agentId === worker));
    await ui.dispose(); await replayLifecycle(ui.calls);
    await expect(client.showAgent(worker)).rejects.toMatchObject({ code: 'not_found' });
    evidence['uiWorkerDelete_' + status] = { deleted: true, restartReplay: true };
  } finally { await ui.dispose(); }
});

test('UI worker Delete joins the worker stop lane while manager sends are queued', async () => {
  const owner = await client.createSession({ profileId: projectId, label: 'Worker Delete queued input' }); const id = owner.session.agentId;
  const blocked = await client.run({ command: 'run', target: { kind: 'session', agentId: id }, text: '[fixture:spawn-choice]', timeoutMs: 5000 });
  const worker = blocked.blocked!.choices[0]!.agentId;
  const heldId = randomUUID(); const queuedId = randomUUID(); const environment = manifest.environments[1]!;
  const ui = await uiConsumer(id);
  const rpc = await openFixtureRpc(credential.baseUrl, { ...admin, bearer: credential.bearerToken });
  try {
    await controlEnvironment(manifest, environment.name, 'fixture', { operation: 'hold-dispatch', commandId: heldId });
    await rpc.call('session.send', { commandId: heldId, sessionId: id, message: { text: 'Held manager send', artifactIds: [] } });
    await until(() => controlEnvironment<{ reached: boolean }>(manifest, environment.name, 'fixture', { operation: 'hold-state' }), state => state.reached);
    await rpc.call('session.send', { commandId: queuedId, sessionId: id, message: { text: 'Preserve queued manager send', artifactIds: [] } });
    ui.facade.deleteAgent(worker);
    await until(() => ui.requests, requests => requests.some(call => call.method === 'worker.delete'));
    const deletion = ui.requests.find(call => call.method === 'worker.delete')!;
    await until(() => rpc.call('command.get', { commandId: deletion.input.commandId }), receipt => receipt.state === 'running');
    expect(await rpc.call('command.get', { commandId: queuedId })).toMatchObject({ state: 'accepted', delivery: 'pending' });
    await controlEnvironment(manifest, environment.name, 'fixture', { operation: 'release-dispatch' });
    await until(() => rpc.call('command.get', { commandId: queuedId }), receipt => receipt.state === 'succeeded');
    await until(() => client.listAgents(projectId), reply => !reply.agents.some(agent => agent.agentId === worker));
    await until(() => ui.calls, calls => calls.some(call => call.method === 'worker.delete'));
    await ui.dispose(); await replayLifecycle(ui.calls);
    expect((await sessionProjection(id)).status).not.toBe('stopped');
    evidence.uiWorkerDeleteQueuedSend = { preservedManagerInput: true, restartReplay: true };
  } finally { await controlEnvironment(manifest, environment.name, 'fixture', { operation: 'release-dispatch' }); rpc.close(); await ui.dispose(); }
});

test('worker.delete preserves completed result transfers and manager history through restart', async () => {
  test.setTimeout(30_000);
  const owner = await client.createSession({ profileId: projectId, label: 'Keep worker result after Delete' }); const id = owner.session.agentId;
  await client.run({ command: 'run', target: { kind: 'session', agentId: id }, text: '[fixture:spawn]', timeoutMs: 5000 });
  const history = () => fixtureRpcOnce<RpcOutput<'session.history'>>(credential.baseUrl, admin, 'session.history', { sessionId: id, turns: 20 });
  const before = await until(history, reply => reply.items.some(item => item.kind === 'worker_result'));
  const results = before.items.filter(item => item.kind === 'worker_result');
  const workers = await fixtureRpcOnce(credential.baseUrl, admin, 'session.workers', { sessionId: id }); const workerId = workers.workers[0]!.agentId;
  const observer = await openFixtureRpc(credential.baseUrl, admin);
  const { subscriptionId } = await observer.call('session.subscribe', { sessionId: id });
  await until(() => observer.frames.some(frame => frame.subscriptionId === subscriptionId && frame.item?.kind === 'snapshot'), Boolean);
  const input = { commandId: randomUUID(), sessionId: id, workerId };
  expect(await fixtureRpcOnce(credential.baseUrl, admin, 'worker.delete', input)).toMatchObject({ state: 'succeeded' });
  await until(() => observer.frames.some(frame => frame.subscriptionId === subscriptionId && frame.item?.event?.type === 'worker.remove' && frame.item.event.agentId === workerId), Boolean);
  observer.close();
  expect((await history()).items.filter(item => item.kind === 'worker_result')).toEqual(results);
  await expect(fixtureRpcOnce(credential.baseUrl, admin, 'session.history', { sessionId: workerId, turns: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const environment = manifest.environments[1]!;
  await controlEnvironment(manifest, environment.name, 'stop'); await controlEnvironment(manifest, environment.name, 'start');
  expect((await fixtureRpcOnce(credential.baseUrl, admin, 'session.workers', { sessionId: id })).workers).toEqual([]);
  expect((await history()).items.filter(item => item.kind === 'worker_result')).toEqual(results);
  expect(await fixtureRpcOnce(credential.baseUrl, admin, 'worker.delete', input)).toMatchObject({ state: 'succeeded' });
  evidence.deletedWorkerResult = { workerId, resultIds: results.map(item => item.itemId), historyRetained: true, restart: true, receiptReplay: true };
});

test('revoked device fails closed without legacy fallback', async () => {
  await fixtureRpcOnce(credential.baseUrl, admin, 'access.devices.revoke', { deviceSessionId: credential.deviceSessionId });
  await expect(client.sendSessionMessage(sessionId, { text: 'denied' })).rejects.toMatchObject({ exitCode: 21 });
  evidence.revocation = true;
});
