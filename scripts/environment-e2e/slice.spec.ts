import { expect } from '@playwright/test';
import { test } from './fixtures/test.js';
import { once } from 'node:events';
import { get as httpGet } from 'node:http';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readManifest, verifyFleetHealth, controlEnvironment, type BootstrapSession, type FleetManifest } from './launch.js';
import { redeemFixtureGrant, fixtureScopes } from './fixtures/pairing.js';
import { seedUiEnvironment, readLaunchEvidence, type UiEnvironment } from './fixtures/ui-fleet.js';
import { fixtureRpcOnce, openFixtureRpc, until } from './fixtures/rpc-client.js';
import { getEnvironmentDbPath, getSessionMetaPath, getSessionFilePath } from '../../apps/backend/src/swarm/storage/data-paths.js';
import { loadConfiguredSqliteDatabaseConstructor } from '../../apps/backend/src/sqlite-database-loader.js';
import { recoverEnvironmentIdentity } from '../../apps/backend/src/environment/identity.js';
import { spawnStandaloneBackend } from './fixtures/standalone-backend.js';
import { seedLoadEnvironment } from './fixtures/load-seed.js';
import { WebSocket } from './fixtures/ws.js';
import { proxySelfTest } from './fixtures/proxy-self-test.js';
import { startFaultProxy } from './fault-proxy.js';
import { crashBoundaries } from './fixtures/hardening-hooks.js';
import { loadV1Client } from './fixtures/v1-client.js';
import { pairEnvironment } from '../../packages/client-runtime/src/pairing.js';
import type { RuntimePorts } from '../../packages/client-runtime/src/ports.js';
import { loadState } from '../../apps/backend/src/environment/control/orchestration/store.js';
import { projectLifecycleStatus } from '../../apps/backend/src/environment/control/orchestration/lifecycle-projection.js';
import type { CoreState, LifecycleEvent } from '../../apps/backend/src/environment/control/orchestration/types.js';
import type { InternalInput } from '../../apps/backend/src/environment/control/command-service.js';

test.use({ environmentSuite: 'slice' });

let manifest: FleetManifest;
const sessions: BootstrapSession[] = [];
const projects: UiEnvironment[] = [];
const evidence: Record<string, unknown> = {};
let launchedSessionId = '';
let launchCommandId = '';
let attachmentId = '';
const exec = promisify(execFile);
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  manifest = await readManifest(process.env.FORGE_E2E_MANIFEST!);
  for (const environment of manifest.environments.slice(0, 3)) {
    const session = await controlEnvironment<BootstrapSession>(manifest, environment.name, 'bootstrap');
    sessions.push(session); projects.push(await seedUiEnvironment(environment, session));
  }
});
test.afterAll(async () => { if (manifest) { await writeFile(join(manifest.artifactRoot, 'slice-assertions.json'), JSON.stringify(evidence, null, 2)); await writeFile(join(manifest.artifactRoot, 'wire-metrics.json'), JSON.stringify({ launch: evidence.wire, resume: evidence.resume }, null, 2)); } });
const b = () => manifest.environments[1]!;
async function readDb<T>(read: (db: InstanceType<Awaited<ReturnType<typeof loadConfiguredSqliteDatabaseConstructor>>>) => T, index = 1): Promise<T> {
  const Constructor = await loadConfiguredSqliteDatabaseConstructor();
  const db = new Constructor(getEnvironmentDbPath(manifest.environments[index]!.dataDir), { readonly: true });
  try { return read(db); } finally { db.close(); }
}
type FixtureDatabase = Parameters<Parameters<typeof readDb>[0]>[0];
function recoveryEvents(db: FixtureDatabase) {
  return (db.prepare("SELECT sequence,event_json FROM lifecycle_events WHERE event_type IN ('recovery.required','recovery.resolved') ORDER BY sequence").all() as { sequence: number; event_json: string }[])
    .map(row => ({ sequence: row.sequence, event: JSON.parse(row.event_json) as Extract<LifecycleEvent, { recovery: unknown }> }));
}
function dispatchedRuns(state: CoreState, threadId: string) {
  return Object.values(state.runs).filter(run => run.threadId === threadId && Object.values(state.attempts).some(attempt => attempt.runId === run.runId && attempt.turn));
}
function workerReports(db: FixtureDatabase, threadId: string) {
  return (db.prepare(`SELECT t.transfer_id AS delivery_id,json_extract(t.state_json,'$.state') AS state,i.prepared_json
    FROM orchestration_transfers t JOIN orchestration_runs r ON r.run_id=json_extract(t.state_json,'$.targetRunId')
    JOIN orchestration_run_inputs i ON i.run_id=r.run_id
    WHERE t.target_thread_id=? AND t.kind='worker_result' AND json_extract(r.state_json,'$.entryId') IS NOT NULL
    ORDER BY t.transfer_id`).all(threadId) as { delivery_id: string; state: string; prepared_json: string }[])
    .map(({ prepared_json, ...row }) => ({ ...row, prepared: JSON.parse(prepared_json) as NonNullable<InternalInput['prepared']> }));
}
async function settled(commandId: string, index = 1) {
  return until(() => fixtureRpcOnce(manifest.environments[index]!.baseUrl, sessions[index]!, 'command.get', { commandId }), receipt => !['accepted', 'running'].includes(receipt.state));
}

test('fleet: distinct processes, ports, data roots and checkout markers are healthy', async () => {
  expect(manifest.environments.length).toBeGreaterThanOrEqual(3); await verifyFleetHealth(manifest);
});
test('fault proxy: HTTP and binary WS forwarding, lost result and selected close', proxySelfTest);
test('protocol-1 client blocks on a real protocol-2 server without retries or credential purges', async () => {
  test.setTimeout(15_000);
  const old = await loadV1Client(manifest.repositoryRoot, manifest.artifactRoot);
  const session = sessions[0]!, environment = manifest.environments[0]!;
  const credentials = old.createMemoryCredentialStore(), persistence = old.createMemoryPersistence();
  await credentials.store(session.environmentId, { bearerToken: session.bearer, deviceSessionId: session.deviceSession!.deviceSessionId });
  let requests = 0, sockets = 0;
  const registry = old.createEnvironmentRegistry({ credentials, persistence, fetch: (url: string, init: RequestInit) => { requests++; return fetch(url, init); }, webSocket: () => { sockets++; throw new Error('Old client must block before opening a socket'); }, random: () => 0.01 });
  try {
    await registry.register({ environmentId: session.environmentId, baseUrl: environment.baseUrl, primary: false, enabled: true, credentialRef: session.deviceSession!.deviceSessionId, labelOverride: null }); await registry.start();
    await until(() => registry.get(session.environmentId).connection.getSnapshot().phase, phase => phase === 'version-blocked');
    const blocked = registry.get(session.environmentId).connection.getSnapshot();
    expect(blocked).toMatchObject({ phase: 'version-blocked', nextRetryAt: null, transportHealthy: false });
    expect(old.describeOldEnvironmentStatus(blocked)).toMatchObject({ label: 'Update required', kind: 'update-required', blocksLaunch: true });
    const reads = requests; await new Promise(resolve => setTimeout(resolve, 600)); expect(requests).toBe(reads); expect(sockets).toBe(0);
    expect(await credentials.load(session.environmentId)).not.toBeNull();
    evidence.oldClientVersion = { clientCommit: '5d7129ba', serverProtocol: 2, phase: blocked.phase, renderedStatus: 'Update required', retries: 0, socketOpens: 0, credentialsRetained: true };
  } finally { await registry.dispose(); }
});
test('9.2.1 private primary bootstrap, link/code pairing, consumed grants and stable identity', async () => {
  expect(new Set(sessions.map(session => session.environmentId)).size).toBe(3);
  for (const [index, mode] of [[1, 'link'], [2, 'code']] as const) {
    const environment = manifest.environments[index]!;
    const grant = await fixtureRpcOnce(environment.baseUrl, sessions[index]!, 'access.grant.create', { kind: mode, label: 'slice paired device', scopes: fixtureScopes, expiresInSeconds: 300, reachableBaseUrl: environment.baseUrl });
    const paired = await redeemFixtureGrant(environment, grant, mode);
    expect(paired.environmentId).toBe(sessions[index]!.environmentId);
    await expect(redeemFixtureGrant(environment, grant, mode)).rejects.toThrow('Fixture pairing failed');
  }
  const identity = sessions[1]!.environmentId;
  await controlEnvironment(manifest, b().name, 'stop'); await controlEnvironment(manifest, b().name, 'start');
  expect((await (await fetch(`${b().baseUrl}/api/v2/environment`, { headers: { Connection: 'close' } })).json()).environmentId).toBe(identity);
  expect((await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'environment.get', {})).environmentId).toBe(identity);
  evidence.pairing = { distinct: 3, link: true, code: true, consumedReplayDenied: 2, restartIdentityStable: true, fragmentSentToHttp: false };
});
test('9.2.2 server repository identity and repeated session IDs are environment scoped', async () => {
  const snapshots = [];
  for (let i = 0; i < 3; i++) {
    const rpc = await openFixtureRpc(manifest.environments[i]!.baseUrl, sessions[i]!);
    try { await rpc.call('shell.subscribe', {}); const frame = await until(() => rpc.frames.find(frame => frame.type === 'stream' && frame.item?.kind === 'snapshot'), Boolean); snapshots.push(frame!.item.snapshot); }
    finally { rpc.close(); }
  }
  expect(snapshots[0].projects[0].repository.key).toBe(snapshots[1].projects[0].repository.key);
  expect(snapshots[2].projects[0].repository.key).not.toBe(snapshots[0].projects[0].repository.key);
  expect(projects[0]!.sessionId).toBe(projects[1]!.sessionId);
  expect(projects[0]!.environmentId).not.toBe(projects[1]!.environmentId);
  evidence.repository = { groupedAB: true, independentC: true, repeatedIdsIsolated: true, manualGrouping: 'not-yet' };
});
test('Batch 3 native state is isolated, deduplicated and reproduced by fresh shell/detail after restart', async () => {
  test.setTimeout(15_000);
  const target = projects[1]!.sessionId;
  const snapshot = async (index: number, method = 'shell.subscribe', input: unknown = {}) => {
    const rpc = await openFixtureRpc(manifest.environments[index]!.baseUrl, sessions[index]!);
    try { const { subscriptionId } = await rpc.call(method, input); return (await until(() => rpc.frames.find(f => f.type === 'stream' && f.subscriptionId === subscriptionId && f.item?.kind === 'snapshot'), Boolean))!.item.snapshot; }
    finally { rpc.close(); }
  };
  const beforeA = (await snapshot(0)).sessions.find((s: any) => s.sessionId === target);
  const beforeB = (await snapshot(1)).sessions.find((s: any) => s.sessionId === target);
  const proxy = await startFaultProxy({ upstream: b().baseUrl });
  const rpc = await openFixtureRpc(b().baseUrl, sessions[1]!, proxy.url);
  const input = { commandId: randomUUID(), sessionId: target, title: 'Batch 3 B only', pinned: true };
  try {
    await rpc.call('shell.subscribe', {});
    proxy.dropNextResponse({ transport: 'ws', rpcId: 'batch3-lost-ack' });
    await expect(rpc.call('session.update', input, 'batch3-lost-ack', 500)).rejects.toThrow('timed out');
    expect(await rpc.call('session.update', input)).toMatchObject({ state: 'succeeded' });
    await until(() => rpc.frames.find(f => f.item?.event?.session?.title === input.title), Boolean);
    await rpc.call('session.readState.set', { commandId: randomUUID(), sessionId: target, read: false });
    const live = (await snapshot(1)).sessions.find((s: any) => s.sessionId === target);
    expect(live).toMatchObject({ title: input.title, pinnedAt: expect.any(String), unread: 1 });
    // A new shell and a headless detail read leave the explicit unread count intact.
    await controlEnvironment(manifest, b().name, 'fixture', { operation: 'burst', sessionId: target, count: 1, status: 'idle' });
    await until(async () => (await snapshot(1)).sessions.find((s: any) => s.sessionId === target)?.unread, n => n >= 2);
    await rpc.call('session.readState.set', { commandId: randomUUID(), sessionId: target, read: false });
    const detail = await snapshot(1, 'session.subscribe', { sessionId: target });
    expect(detail.session.unread).toBe(1);
    const item = detail.items.find((i: any) => ['assistant', 'user'].includes(i.kind));
    expect(item).toBeTruthy();
    await rpc.call('session.message.pin', { commandId: randomUUID(), sessionId: target, itemId: item.itemId, pinned: true });
    expect((await snapshot(1, 'session.subscribe', { sessionId: target })).items.find((i: any) => i.itemId === item.itemId).pinned).toBe(true);
    rpc.close();
    await controlEnvironment(manifest, b().name, 'stop'); await controlEnvironment(manifest, b().name, 'start');
    const restarted = (await snapshot(1)).sessions.find((s: any) => s.sessionId === target);
    expect(restarted).toMatchObject({ title: live.title, pinnedAt: live.pinnedAt, sortKey: live.sortKey, unread: live.unread });
    expect((await snapshot(1, 'session.subscribe', { sessionId: target })).items.find((i: any) => i.itemId === item.itemId).pinned).toBe(true);
    await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'session.pins.clear', { commandId: randomUUID(), sessionId: target });
    expect((await snapshot(1, 'session.subscribe', { sessionId: target })).items.find((i: any) => i.itemId === item.itemId).pinned).toBe(false);
    expect((await snapshot(0)).sessions.find((s: any) => s.sessionId === target)).toEqual(beforeA);
    const [old] = await controlEnvironment<any[]>(manifest, b().name, 'fixture', { operation: 'attention', sessionId: target });
    await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'session.attention.dismiss', { commandId: randomUUID(), occurrenceIds: [old.attentionId] });
    const [next] = await controlEnvironment<any[]>(manifest, b().name, 'fixture', { operation: 'attention', sessionId: target });
    await expect(fixtureRpcOnce(b().baseUrl, sessions[1]!, 'session.attention.dismiss', { commandId: randomUUID(), occurrenceIds: [old.attentionId, next.attentionId] })).rejects.toThrow();
    expect(await controlEnvironment<any[]>(manifest, b().name, 'fixture', { operation: 'attention-state', sessionId: target })).toMatchObject([{ attentionId: next.attentionId }]);
    const counts = await readDb(db => db.prepare('SELECT COUNT(*) AS count FROM commands WHERE command_id=?').get(input.commandId));
    expect(counts).toEqual({ count: 1 });
    evidence.batch3 = { beforeA, beforeB, live, restarted, itemId: item.itemId, nativeCommands: true, lostAckChanges: 1, messagePinRestart: true, clearedPins: true, shellOnlyUnread: true, oldOccurrenceRejected: true };
    // Restore the shared slice seed so unrelated acceptance retains its names.
    await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'session.update', { commandId: randomUUID(), sessionId: target, title: beforeB.title, pinned: false });
    await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'project.readState.clear', { commandId: randomUUID(), projectId: live.projectId });
  } finally { rpc.close(); await proxy.stop(); }
});
test('9.2.3 B new worktree + attachment and post-COMMIT lost ack retry execute once', async () => {
  const providerMarker = (index: number) => readFile(join(manifest.environments[index]!.checkout, 'fixture-provider-marker.txt'), 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; });
  const untouched = await Promise.all([providerMarker(0), providerMarker(2)]);
  const upload = await fetch(`${b().baseUrl}/api/v2/artifacts?projectId=${projects[1]!.sessionId}&uploadId=${randomUUID()}`, { method: 'POST', headers: { Authorization: `Bearer ${sessions[1]!.bearer}`, 'Content-Type': 'text/plain', 'x-forge-environment-protocol': "2", 'x-forge-file-name': 'synthetic.txt' }, body: 'synthetic attachment' });
  expect(upload.status).toBe(200); attachmentId = (await upload.json()).artifactId;
  const proxy = await startFaultProxy({ upstream: b().baseUrl });
  const rpc = await openFixtureRpc(b().baseUrl, sessions[1]!, proxy.url);
  launchCommandId = randomUUID();
  const requestId = 'lost-launch-ack';
  const input = { commandId: launchCommandId, projectId: projects[1]!.sessionId, title: 'B worktree slice', workspaceStrategy: { kind: 'new_worktree', baseRef: 'main', branch: `slice/${launchCommandId}` }, initialMessage: { text: 'write B fixture marker', artifactIds: [attachmentId] } };
  try {
    proxy.dropNextResponse({ transport: 'ws', rpcId: requestId });
    await expect(rpc.call('session.launch', input, requestId, 500)).rejects.toThrow('timed out');
    const retried = await rpc.call('session.launch', input); launchedSessionId = retried.sessionId;
    const receipt = await settled(launchCommandId); expect(receipt.state).toBe('succeeded'); expect(receipt.delivery).toBe('dispatched');
    const counts = await until(() => readLaunchEvidence(b(), launchedSessionId), result => result.dispatches === 1 && result.markerChanged);
    expect(counts).toMatchObject({ commands: 1, worktrees: 1, dispatches: 1, markerChanged: true });
    const rows = await readDb(db => ({ inputs: (db.prepare('SELECT count(*) AS n FROM control_inputs WHERE command_id=?').get(launchCommandId) as { n: number }).n,
      reservations: (db.prepare('SELECT count(*) AS n FROM workspace_reservations WHERE command_id=?').get(launchCommandId) as { n: number }).n,
      pinned: (db.prepare('SELECT count(*) AS n FROM input_artifacts WHERE artifact_id=?').get(attachmentId) as { n: number }).n }));
    expect(rows).toEqual({ inputs: 1, reservations: 1, pinned: 1 });
    const meta = JSON.parse(await readFile(getSessionMetaPath(b().dataDir, projects[1]!.sessionId, launchedSessionId), 'utf8'));
    expect(meta.controlCommandId).toBe(launchCommandId);
    const canonical = await readFile(getSessionFilePath(b().dataDir, projects[1]!.sessionId, launchedSessionId), 'utf8');
    expect(canonical.split('\n').filter(line => line.includes('"controlCommandId":"' + launchCommandId + '"') && line.includes('"role":"user"')).length).toBe(1);
    const worktrees = (await exec('git', ['worktree', 'list', '--porcelain'], { cwd: b().checkout })).stdout;
    expect(worktrees.split('branch refs/heads/slice/' + launchCommandId).length - 1).toBe(1);
    for (const index of [0, 2]) expect(await readFile(join(manifest.environments[index]!.checkout, 'environment-marker.txt'), 'utf8')).toBe(`${manifest.environments[index]!.name}\n`);
    expect(await Promise.all([providerMarker(0), providerMarker(2)])).toEqual(untouched);
    evidence.launch = { ...counts, ...rows, descriptors: 1, canonicalUserInputs: 1, metaOwned: true, gitWorktrees: 1, otherProviderMarkersUnchanged: 2, lostResults: proxy.metrics().droppedResponses };
    evidence.wire = proxy.metrics();
  } finally { rpc.close(); await proxy.stop(); }
});
test('9.2.4 real manager choice, lost answer ack, conflict and native worker result', async () => {
  const rpc = await openFixtureRpc(b().baseUrl, sessions[1]!);
  const proxy = await startFaultProxy({ upstream: b().baseUrl });
  const answerRpc = await openFixtureRpc(b().baseUrl, sessions[1]!, proxy.url);
  try {
    await rpc.call('session.subscribe', { sessionId: launchedSessionId });
    await rpc.call('session.send', { commandId: randomUUID(), sessionId: launchedSessionId, message: { text: '[fixture:choice]', artifactIds: [] } });
    const choice = await until<any>(() => rpc.frames.map(frame => frame.item?.event).find(event => event?.type === 'choice.upsert' && event.choice.status === 'pending')?.choice, Boolean);
    const commandId = randomUUID();
    const input = { commandId, sessionId: launchedSessionId, choiceId: choice.choiceId, answers: choice.questions.map((question: any) => ({ questionId: question.id, selectedOptionIds: [question.options[0].id] })) };
    proxy.dropNextResponse({ transport: 'ws', rpcId: 'lost-choice-ack' });
    await expect(answerRpc.call('session.choose', input, 'lost-choice-ack', 500)).rejects.toThrow('timed out');
    expect((await answerRpc.call('session.choose', input)).commandId).toBe(commandId);
    expect((await settled(commandId)).state).toBe('succeeded');
    await expect(answerRpc.call('session.choose', { ...input, commandId: randomUUID() })).rejects.toMatchObject({ code: 'CONFLICT' });
    const spawn = await rpc.call('session.send', { commandId: randomUUID(), sessionId: launchedSessionId, message: { text: '[fixture:spawn]', artifactIds: [] } });
    expect((await settled(spawn.commandId)).delivery).toBe('dispatched');
    await until(() => rpc.frames.map(frame => frame.item?.event).find(event => event?.type === 'worker.upsert'), Boolean);
    await until(() => rpc.frames.map(frame => frame.item?.event).find(event => event?.type === 'item.upsert' && event.item.kind === 'worker_result'), Boolean, 25000);
    await rpc.call('session.send', { commandId: randomUUID(), sessionId: launchedSessionId, message: { text: '[fixture:spawn-choice]', artifactIds: [] } });
    const workerChoice = await until<any>(() => rpc.frames.map(frame => frame.item?.event).find(event => event?.type === 'choice.upsert' && event.choice.status === 'pending' && event.choice.agentId !== launchedSessionId)?.choice, Boolean);
    const answeredWorker = await rpc.call('session.choose', { commandId: randomUUID(), sessionId: launchedSessionId, choiceId: workerChoice.choiceId, answers: workerChoice.questions.map((question: any) => ({ questionId: question.id, selectedOptionIds: [question.options[0].id] })) });
    expect((await settled(answeredWorker.commandId)).state).toBe('succeeded');
    for (let index = 0; index < 24; index++) { const receipt = await rpc.call('session.send', { commandId: randomUUID(), sessionId: launchedSessionId, message: { text: `History fixture turn ${index}`, artifactIds: [] } }); await settled(receipt.commandId); }
    const history = await rpc.call('session.history', { sessionId: launchedSessionId, turns: 4 });
    expect(Array.isArray(history.items)).toBe(true);
    expect(history.nextCursor).toBeTruthy();
    const older = await rpc.call('session.history', { sessionId: launchedSessionId, turns: 4, before: history.nextCursor });
    expect(older.items.length).toBeGreaterThan(0); expect(new Set([...history.items, ...older.items].map((item: any) => item.itemId)).size).toBe(history.items.length + older.items.length);
    await rpc.call('session.send', { commandId: randomUUID(), sessionId: launchedSessionId, message: { text: '[fixture:long-tool]', artifactIds: [] } });
    const tool = await until<any>(() => rpc.frames.map(frame => frame.item?.event).find(event => event?.type === 'item.upsert' && event.item.kind === 'tool' && event.item.contentRef)?.item, Boolean);
    expect(tool.text.length).toBeLessThanOrEqual(8192);
    let offset = 0; let content = ''; let pages = 0;
    do { const chunk = await rpc.call('session.content', { sessionId: launchedSessionId, contentRef: tool.contentRef, offset, maxBytes: 4096 }); content += chunk.text; pages++; offset = chunk.nextOffset; } while (offset !== null);
    expect(content.length).toBeGreaterThan(8192); expect(content).toContain('synthetic-output');
    evidence.choiceWorker = { managerChoice: true, lostChoiceAckRetry: true, distinctAnswerConflicts: true, nativeWorker: true, resultMirrored: true, historyAuthenticated: true, historyPages: [history.items.length, older.items.length], truncatedToolContent: { previewCharacters: tool.text.length, contentCharacters: content.length, authenticatedPages: pages }, workerChoice: true };
  } finally { rpc.close(); answerRpc.close(); await proxy.stop(); }
});
test('9.2.5 authenticated B feature queries and B/C multiplexed terminal CWD routing', async () => {
  const headers = { Authorization: `Bearer ${sessions[1]!.bearer}` };
  const target = encodeURIComponent(launchedSessionId);
  const files = await fetch(`${b().baseUrl}/api/files/content?agentId=${target}&path=environment-marker.txt`, { headers });
  expect(files.status).toBe(200); expect(JSON.stringify(await files.json())).toContain('env-b');
  for (const path of [`/api/git/status?agentId=${target}`, `/api/sessions/${target}/audit`, '/api/settings/manager-selection-catalog']) expect((await fetch(b().baseUrl + path, { headers })).status).toBe(200);
  const routed = [];
  for (const index of [1, 2]) {
    const environment = manifest.environments[index]!; const sessionId = index === 1 ? launchedSessionId : projects[index]!.sessionId;
    const auth = { Authorization: `Bearer ${sessions[index]!.bearer}`, 'Content-Type': 'application/json' };
    const created = await fetch(`${environment.baseUrl}/api/terminals`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionAgentId: sessionId, shell: '/bin/sh', shellArgs: [], cols: 80, rows: 24 }) });
    expect(created.status).toBe(201); const terminal = (await created.json()).terminal;
    const rpc = await openFixtureRpc(environment.baseUrl, sessions[index]!);
    try {
      const ticket = await (await fetch(`${environment.baseUrl}/api/terminals/${terminal.terminalId}/ticket`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionAgentId: sessionId, requesterAgentId: sessionId }) })).json();
      const attached = await rpc.call('terminal.attach', { sessionId, terminalId: terminal.terminalId, ticket: ticket.ticket });
      await rpc.call('terminal.input', { subscriptionId: attached.subscriptionId, inputId: randomUUID(), data: 'pwd\n' });
      await until(() => rpc.frames.filter(frame => frame.subscriptionId === attached.subscriptionId).map(frame => frame.item?.data ?? '').join(''), output => output.includes(terminal.cwd));
      if (index === 1) expect(terminal.cwd).toBe(await readDb(db => (db.prepare('SELECT path FROM workspace_reservations WHERE session_id=?').get(sessionId) as { path: string }).path));
      else expect(terminal.cwd).toBe(environment.checkout);
      routed.push({ environment: environment.name, cwdMatches: true, multiplexed: true });
    } finally { rpc.close(); await fetch(`${environment.baseUrl}/api/terminals/${terminal.terminalId}?sessionAgentId=${sessionId}`, { method: 'DELETE', headers: auth }); }
  }
  evidence.features = { files: true, git: true, audit: true, modelCatalog: true, terminals: routed, mountedUiAndSimultaneousStreams: 'not-yet' };
});
test('9.2.6 small-gap shell/detail resume and restart preserve epoch', async () => {
  const rpc = await openFixtureRpc(b().baseUrl, sessions[1]!);
  await rpc.call('shell.subscribe', {}); await rpc.call('session.subscribe', { sessionId: launchedSessionId });
  await until(() => rpc.frames.filter(frame => frame.item?.kind === 'synchronized').length, n => n === 2);
  const cursor = rpc.frames.find(frame => frame.item?.kind === 'synchronized')!.item;
  const detailCursor = rpc.frames.filter(frame => frame.item?.kind === 'synchronized')[1]!.item;
  rpc.close();
  const sent = await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'session.send', { commandId: randomUUID(), sessionId: launchedSessionId, message: { text: 'small reconnect gap', artifactIds: [] } });
  await settled(sent.commandId);
  await until(() => readDb(db => db.prepare("SELECT json_extract(state_json,'$.state') state FROM orchestration_runs WHERE run_id=?").get(`run-${sent.commandId}`)), row => (row as { state: string }).state === 'terminal');
  await controlEnvironment(manifest, b().name, 'stop'); await controlEnvironment(manifest, b().name, 'start');
  const resumed = await openFixtureRpc(b().baseUrl, sessions[1]!);
  try {
    await resumed.call('shell.subscribe', { cursor: { streamEpoch: cursor.streamEpoch, afterSequence: cursor.sequence } });
    await resumed.call('session.subscribe', { sessionId: launchedSessionId, cursor: { streamEpoch: detailCursor.streamEpoch, afterSequence: detailCursor.sequence } });
    await until(() => resumed.frames.filter(frame => frame.item?.kind === 'synchronized').length, n => n === 2);
    expect(resumed.frames.some(frame => frame.item?.kind === 'snapshot')).toBe(false);
    expect(resumed.frames.some(frame => ['agents_snapshot', 'profiles_snapshot'].includes(frame.type))).toBe(false);
    evidence.resume = { snapshots: 0, frames: resumed.frames.length, bytes: Buffer.byteLength(JSON.stringify(resumed.frames)), epochStable: true, browserReloadCache: 'not-yet' };
  } finally { resumed.close(); }
});
test('9.2.8 stop, controlled resume and fork mirrored to shell', async () => {
  const rpc = await openFixtureRpc(b().baseUrl, sessions[1]!);
  try {
    await rpc.call('shell.subscribe', {}); await rpc.call('session.subscribe', { sessionId: launchedSessionId });
    const held = await rpc.call('session.send', { commandId: randomUUID(), sessionId: launchedSessionId, message: { text: '[fixture:hold]', artifactIds: [] } });
    expect((await settled(held.commandId)).delivery).toBe('dispatched');
    const stop = await rpc.call('session.stop', { commandId: randomUUID(), sessionId: launchedSessionId }); const stopped = await settled(stop.commandId); expect(stopped, JSON.stringify(stopped)).toMatchObject({ state: 'succeeded' });
    await controlEnvironment(manifest, b().name, 'stop'); await controlEnvironment(manifest, b().name, 'start');
    const next = await openFixtureRpc(b().baseUrl, sessions[1]!);
    try {
      const resumeInput = { sessionId: launchedSessionId, commandId: randomUUID() };
      const resumed = await next.call('session.resume', resumeInput); expect((await settled(resumed.commandId)).state).toBe('succeeded');
      expect((await next.call('session.resume', resumeInput)).commandId).toBe(resumed.commandId);
      await next.call('shell.subscribe', {});
      const forkInput = { sessionId: launchedSessionId, commandId: randomUUID(), title: 'Slice fork' };
      const fork = await next.call('session.fork', forkInput); expect((await settled(fork.commandId)).state).toBe('succeeded');
      expect((await next.call('session.fork', forkInput)).commandId).toBe(fork.commandId);
      await until(() => next.frames.find(frame => frame.item?.event?.type === 'session.upsert' && frame.item.event.session.title === 'Slice fork'), Boolean);
      expect((await readDb(db => db.prepare('SELECT desired_state FROM control_sessions WHERE session_id=?').get(launchedSessionId)) as { desired_state: string }).desired_state).toBe('running');
      await next.call('session.subscribe', { sessionId: launchedSessionId });
      const pending = await next.call('session.send', { commandId: randomUUID(), sessionId: launchedSessionId, message: { text: '[fixture:choice]', artifactIds: [] } });
      await settled(pending.commandId);
      const oldChoice = await until<any>(() => next.frames.map(frame => frame.item?.event).find(event => event?.type === 'choice.upsert' && event.choice.status === 'pending')?.choice, Boolean);
      await controlEnvironment(manifest, b().name, 'stop'); await controlEnvironment(manifest, b().name, 'start');
      expect((await readDb(db => db.prepare('SELECT state FROM control_choices WHERE choice_id=?').get(oldChoice.choiceId)) as { state: string }).state).toBe('expired');
      await expect(fixtureRpcOnce(b().baseUrl, sessions[1]!, 'session.choose', { commandId: randomUUID(), sessionId: launchedSessionId, choiceId: oldChoice.choiceId, answers: [{ questionId: oldChoice.questions[0].id, selectedOptionIds: [oldChoice.questions[0].options[0].id] }] })).rejects.toMatchObject({ code: 'CONFLICT' });
      evidence.stopResumeFork = { activeTurnStopped: true, restartStoppedState: true, controlledResume: true, forkShellMirrored: true, pendingChoiceRestart: true, writerExclusion: 'covered-control-acceptance' };
    } finally { next.close(); }
  } finally { rpc.close(); }
});
test('9.2.10 real HTTP/RPC negative auth, scope, ticket, payload and command-body checks', async () => {
  const environment = manifest.environments[0]!;
  const headers = { Authorization: `Bearer ${sessions[0]!.bearer}`, 'Content-Type': 'application/json' };
  expect((await fetch(`${environment.baseUrl}/api/v2/access/ws-ticket`, { method: 'POST', headers, body: JSON.stringify({ audience: 'rpc', protocolVersion: 1 }) })).status).toBe(409);
  const headerMismatch = await fetch(`${environment.baseUrl}/api/v2/access/ws-ticket`, { method: 'POST', headers: { ...headers, 'x-forge-environment-protocol': '1' }, body: JSON.stringify({ audience: 'rpc', protocolVersion: 1 }) });
  expect(headerMismatch.status).toBe(409);
  expect(await headerMismatch.json()).toMatchObject({ error: { code: 'PROTOCOL_MISMATCH', retryable: false } });
  expect((await fetch(`${environment.baseUrl}/api/not-classified`, { headers })).status).toBe(403);
  for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) expect((await fetch(`${environment.baseUrl}/api/not-classified`, { method, headers })).status).toBe(403);
  const routeInventory = await controlEnvironment<any[]>(manifest, environment.name, 'fixture', { operation: 'route-inventory' });
  expect(routeInventory.length).toBeGreaterThan(50);
  expect(routeInventory.every(route => route.methods && route.access && (route.access.scopes || route.access.authenticated || route.access.public || route.access.integration))).toBe(true);
  evidence.routeInventory = { allRegisteredRoutes: routeInventory, unclassifiedRegistered: 0, unknownApiVerbsRejected: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] };
  expect((await fetch(`${environment.baseUrl}/api/v2/access/session`)).status).toBe(401);
  expect((await fetch(`${environment.baseUrl}/api/v2/artifacts/unknown`, { method: 'POST', headers })).status).toBe(403);
  const forged = new WebSocket(`${environment.baseUrl.replace('http:', 'ws:')}/api/v2/rpc`, ['forge.v2', `ticket.${'A'.repeat(43)}`]);
  const rejected = new Promise<number>((resolve) => forged.once('unexpected-response', (_request, response) => { response.resume(); forged.terminate(); resolve(response.statusCode!); }));
  forged.on('error', () => {}); expect(await rejected).toBe(401);
  const rpc = await openFixtureRpc(b().baseUrl, sessions[1]!);
  try {
    await expect(rpc.call('not.a.method', {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(rpc.call('session.history', { sessionId: launchedSessionId, turns: 21 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(rpc.call('session.choose', { commandId: randomUUID(), sessionId: launchedSessionId, choiceId: randomUUID(), answers: [] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(rpc.call('session.launch', { commandId: launchCommandId, projectId: projects[1]!.sessionId, title: 'changed retry body', workspaceStrategy: { kind: 'current_checkout' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    for (const method of ['legacy.session.read', 'legacy.session.operate', 'legacy.session.subscribe']) await expect(rpc.call(method, {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    evidence.removedTransport = { removedMethodsRejected: 3, noLegacyRegistry: true };

  } finally { rpc.close(); }
  const grant = await fixtureRpcOnce(environment.baseUrl, sessions[0]!, 'access.grant.create', { kind: 'link', label: 'read only fixture', scopes: ['session:read'], expiresInSeconds: 300, reachableBaseUrl: environment.baseUrl });
  const readOnly = await redeemFixtureGrant(environment, grant, 'link', ['session:read']);
  const pinRequests: string[] = [];
  await expect(pairEnvironment({ fetch: async (url, init) => { pinRequests.push(new URL(String(url)).pathname); return fetch(url, init); } } as RuntimePorts,
    { baseUrl: environment.baseUrl, expectedEnvironmentId: sessions[1]!.environmentId, credential: { kind: 'code', code: 'AAAA-BBBB' }, deviceName: 'pin negative fixture', deviceKind: 'desktop', delivery: 'bearer', requestedScopes: ['session:read'] })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  expect(pinRequests).toEqual(['/api/v2/environment']);
  evidence.identityPin = { actualUrlEnvironment: sessions[0]!.environmentId, expectedEnvironment: sessions[1]!.environmentId, rejected: 'IDENTITY_MISMATCH', requests: pinRequests, noChallengeExchangeOrSocket: true };
  await expect(fixtureRpcOnce(environment.baseUrl, readOnly, 'session.send', { commandId: randomUUID(), sessionId: projects[0]!.sessionId, message: { text: 'denied', artifactIds: [] } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const narrowGrant = await fixtureRpcOnce(environment.baseUrl, sessions[0]!, 'access.grant.create', { kind: 'link', label: 'no escalation fixture', scopes: ['session:read'], expiresInSeconds: 300, reachableBaseUrl: environment.baseUrl });
  await expect(redeemFixtureGrant(environment, narrowGrant, 'link', ['session:operate'])).rejects.toThrow('Fixture pairing failed');
  const competing = spawnStandaloneBackend(b());
  try { await expect(competing.ready).rejects.toThrow('WRITER_LOCKED'); } finally { await competing.stop(); }
  expect((await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'environment.get', {})).environmentId).toBe(sessions[1]!.environmentId);
  evidence.writerFence = { secondProcessRejectedBeforeListen: true, ownerStillHealthy: true };
  const large = await openFixtureRpc(environment.baseUrl, sessions[0]!); const closed = once(large.socket, 'close');
  large.socket.send('x'.repeat(1048577)); expect((await closed)[0]).toBe(1009);
  evidence.negative = { wrongProtocol: true, unclassifiedApi: true, absentAuth: true, exactArtifactVerb: true, forgedTicket: true, unsupportedMethod: true, oversizedHistoryPage: true, invalidChoice: true, changedCommandBody: true, genericProxyForbidden: true, missingScope: true, oversizedFrame: true, copiedRootBarrierOverflow: 'not-yet-in-real-fleet' };
});
test('9.2.9 revocation closes C RPC and denies subsequent tickets/API while A/B remain healthy', async () => {
  const c = manifest.environments[2]!;
  const auth = { Authorization: `Bearer ${sessions[2]!.bearer}`, 'Content-Type': 'application/json' };
  const grant = await fixtureRpcOnce(c.baseUrl, sessions[2]!, 'access.grant.create', { kind: 'link', label: 'surviving C fixture', scopes: fixtureScopes, expiresInSeconds: 300, reachableBaseUrl: c.baseUrl });
  const survivor = await redeemFixtureGrant(c, grant);
  const priorDispatches = (await readLaunchEvidence(c, projects[2]!.sessionId)).dispatches;
  const dispatched = await fixtureRpcOnce(c.baseUrl, sessions[2]!, 'session.send', { commandId: randomUUID(), sessionId: projects[2]!.sessionId, message: { text: '[fixture:hold]', artifactIds: [] } });
  expect((await settled(dispatched.commandId, 2)).delivery).toBe('dispatched');
  const draft = await fixtureRpcOnce(c.baseUrl, survivor, 'session.launch', { commandId: randomUUID(), projectId: projects[2]!.sessionId, title: 'Revoked unsent input', workspaceStrategy: { kind: 'current_checkout' } });
  await until(() => fixtureRpcOnce(c.baseUrl, survivor, 'command.get', { commandId: draft.commandId }), receipt => receipt.state === 'succeeded');
  const pendingId = randomUUID();
  await controlEnvironment(manifest, c.name, 'fixture', { operation: 'hold-dispatch', commandId: pendingId });
  await fixtureRpcOnce(c.baseUrl, sessions[2]!, 'session.send', { commandId: pendingId, sessionId: draft.sessionId, message: { text: 'Must never reach provider after revoke', artifactIds: [] } });
  await until(() => controlEnvironment<any>(manifest, c.name, 'fixture', { operation: 'hold-state' }), state => state.reached);
  const created = await fetch(`${c.baseUrl}/api/terminals`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionAgentId: projects[2]!.sessionId, shell: '/bin/sh', shellArgs: [] }) });
  expect(created.status).toBe(201); const terminal = (await created.json()).terminal;
  const hostTerminal = (await controlEnvironment<any>(manifest, c.name, 'fixture', { operation: 'host-terminal-create', sessionId: projects[2]!.sessionId })).terminal;
  const rpc = await openFixtureRpc(c.baseUrl, sessions[2]!);
  const ticket = await (await fetch(`${c.baseUrl}/api/terminals/${terminal.terminalId}/ticket`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionAgentId: projects[2]!.sessionId, requesterAgentId: projects[2]!.sessionId }) })).json();
  await rpc.call('terminal.attach', { sessionId: projects[2]!.sessionId, terminalId: terminal.terminalId, ticket: ticket.ticket });
  const hostTicket = await (await fetch(`${c.baseUrl}/api/terminals/${hostTerminal.terminalId}/ticket`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionAgentId: projects[2]!.sessionId, requesterAgentId: projects[2]!.sessionId }) })).json();
  await rpc.call('terminal.attach', { sessionId: projects[2]!.sessionId, terminalId: hostTerminal.terminalId, ticket: hostTicket.ticket });
  const upload = await fetch(`${c.baseUrl}/api/v2/artifacts?projectId=${projects[2]!.sessionId}&uploadId=${randomUUID()}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/octet-stream', 'x-forge-environment-protocol': "2", 'x-forge-file-name': 'synthetic.bin' }, body: Buffer.alloc(25 * 1024 * 1024, 120) });
  expect(upload.status).toBe(200); const artifactId = (await upload.json()).artifactId;
  const download = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => { const request = httpGet(`${c.baseUrl}/api/v2/artifacts/${artifactId}`, { agent: false, headers: { Authorization: auth.Authorization, 'x-forge-environment-protocol': "2" } }, response => { response.pause(); response.on('error', () => {}); resolve(response); }); request.on('error', reject); });
  expect(download.statusCode).toBe(200); const downloadClosed = new Promise<void>(resolve => download.once('close', resolve));
  const closed = once(rpc.socket, 'close');
  const started = Date.now();
  await fixtureRpcOnce(c.baseUrl, sessions[2]!, 'access.devices.revoke', { deviceSessionId: sessions[2]!.deviceSession!.deviceSessionId }).catch(() => undefined);
  const [code] = await closed; expect(code).toBe(4401); expect(Date.now() - started).toBeLessThan(1000);
  const closeElapsedMs = Date.now() - started;
  await controlEnvironment(manifest, c.name, 'fixture', { operation: 'release-dispatch' });
  const interrupted = await until(() => readDb<any>(db => JSON.parse((db.prepare('SELECT receipt_json FROM command_receipts WHERE command_id=?').get(pendingId) as { receipt_json: string }).receipt_json), 2), receipt => ['interrupted', 'failed'].includes(receipt.state));
  expect(interrupted).toMatchObject({ state: 'interrupted', delivery: 'none' });
  expect((await readLaunchEvidence(c, draft.sessionId)).dispatches).toBe(0);
  expect((await readLaunchEvidence(c, projects[2]!.sessionId)).dispatches).toBe(priorDispatches + 1);
  const running = await readDb<any>(db => JSON.parse((db.prepare('SELECT summary_json FROM control_sessions WHERE session_id=?').get(projects[2]!.sessionId) as { summary_json: string }).summary_json), 2);
  expect(running.status).toBe('running');
  download.resume(); await downloadClosed; expect(download.complete).toBe(false);
  expect(terminal.pid).toBeGreaterThan(0);
  await until(async () => { try { process.kill(terminal.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }, Boolean, 1000);
  process.kill(hostTerminal.pid, 0);
  const survivorAuth = { Authorization: `Bearer ${survivor.bearer}`, 'Content-Type': 'application/json' };
  const survivorTicket = await (await fetch(`${c.baseUrl}/api/terminals/${hostTerminal.terminalId}/ticket`, { method: 'POST', headers: survivorAuth, body: JSON.stringify({ sessionAgentId: projects[2]!.sessionId, requesterAgentId: projects[2]!.sessionId }) })).json();
  const survivorRpc = await openFixtureRpc(c.baseUrl, survivor);
  try {
    const attached = await survivorRpc.call('terminal.attach', { sessionId: projects[2]!.sessionId, terminalId: hostTerminal.terminalId, ticket: survivorTicket.ticket });
    await survivorRpc.call('terminal.input', { subscriptionId: attached.subscriptionId, inputId: randomUUID(), data: 'printf host-owned-survives\\n\n' });
    await until(() => survivorRpc.frames.filter(frame => frame.subscriptionId === attached.subscriptionId).map(frame => frame.item?.data ?? '').join(''), output => output.includes('host-owned-survives'));
    await survivorRpc.call('session.stop', { commandId: randomUUID(), sessionId: projects[2]!.sessionId });
  } finally { survivorRpc.close(); }
  expect((await fetch(`${c.baseUrl}/api/terminals/${hostTerminal.terminalId}?sessionAgentId=${projects[2]!.sessionId}`, { method: 'DELETE', headers: survivorAuth })).status).toBe(204);
  expect((await fetch(`${c.baseUrl}/api/v2/artifacts?projectId=${projects[2]!.sessionId}&uploadId=${randomUUID()}`, { method: 'POST', headers: { ...auth, 'x-forge-environment-protocol': "2", 'x-forge-file-name': 'denied.txt' }, body: 'denied' })).status).toBe(401);
  expect((await fetch(`${c.baseUrl}/api/v2/access/session`, { headers: { Authorization: `Bearer ${sessions[2]!.bearer}` } })).status).toBe(401);
  expect((await fetch(`${c.baseUrl}/api/v2/access/ws-ticket`, { method: 'POST', headers: { Authorization: `Bearer ${sessions[2]!.bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ audience: 'rpc', protocolVersion: 2 }) })).status).toBe(401);
  for (const i of [0, 1]) expect((await fixtureRpcOnce(manifest.environments[i]!.baseUrl, sessions[i]!, 'environment.get', {})).environmentId).toBe(sessions[i]!.environmentId);
  evidence.revoke = { closeCode: code, closeElapsedMs, totalVerificationMs: Date.now() - started, futureAccessDenied: true, isolationAB: true, activeDownloadAborted: !download.complete, deviceCreatedPtyEnded: true, hostOwnedPtySurvivedAndReattached: true, acceptedUnsent: interrupted, unsentDispatches: 0, alreadyDispatchedContinued: true, futureUploadDenied: true };
});

test('9.2.7 controlled crash at all seven effect boundaries', async () => {
  test.setTimeout(180000);
  const observations: Record<string, unknown>[] = [];
  evidence.crashes = observations;
  for (const boundary of crashBoundaries) {
    const commandId = randomUUID(); const sessionId = `v2-${commandId}`;
    const input = { commandId, projectId: projects[1]!.sessionId, title: `Crash ${boundary}`, workspaceStrategy: { kind: 'new_worktree', baseRef: 'main', branch: `crash/${commandId}` }, initialMessage: { text: `crash matrix ${boundary}`, artifactIds: [] } };
    const armed = await controlEnvironment<{ armed: boolean; pid: number }>(manifest, b().name, 'fixture', { operation: 'arm-crash', commandId, boundary });
    expect(armed.armed).toBe(true);
    const rpc = await openFixtureRpc(b().baseUrl, sessions[1]!);
    let acknowledged = false;
    try { await rpc.call('session.launch', input); acknowledged = true; } catch { /* The two acceptance boundaries deliberately prevent the result. */ }
    const marker = await until(async () => {
      try { return JSON.parse(await readFile(join(b().checkout, '.fixture-crash.json'), 'utf8')); } catch { return null; }
    }, result => result?.commandId === commandId && result.boundary === boundary);
    expect(marker.pid).toBe(armed.pid);
    expect(marker.fired).toBe(true);
    await until(() => { try { process.kill(armed.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }, Boolean);
    rpc.close();
    const before = await readDb(db => ({
      commands: (db.prepare('SELECT count(*) n FROM commands WHERE command_id=?').get(commandId) as { n: number }).n,
      receipt: db.prepare('SELECT receipt_json FROM command_receipts WHERE command_id=?').get(commandId),
      input: db.prepare('SELECT append_state,delivery_state FROM control_inputs WHERE command_id=?').get(commandId),
      locators: (db.prepare('SELECT count(*) n FROM mirror_sources WHERE source_key=?').get(`input:input-${commandId}`) as { n: number }).n,
      reservation: db.prepare('SELECT state FROM workspace_reservations WHERE command_id=?').get(commandId),
    }));
    expect(before.commands).toBe(boundary === 'pre-commit' ? 0 : 1);
    if (boundary === 'pre-commit' || boundary === 'post-commit') expect(acknowledged).toBe(false);
    if (boundary === 'post-Git') expect(before.reservation).toEqual({ state: 'reserved' });
    if (boundary === 'post-JSONL') { expect(before.locators).toBe(0); expect(before.input).toEqual({ append_state: 'pending', delivery_state: 'pending' }); }
    if (boundary === 'post-dispatch-marker' || boundary === 'post-provider-accept') expect(before.input).toEqual({ append_state: 'recorded', delivery_state: 'dispatching' });
    await controlEnvironment(manifest, b().name, 'start');
    const descriptor = await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'environment.get', {});
    expect(descriptor.environmentId).toBe(sessions[1]!.environmentId);
    expect(descriptor.streamEpoch).toBe(sessions[1]!.environment!.streamEpoch);
    const retry = await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'session.launch', input);
    expect(retry.commandId).toBe(commandId); expect(retry.sessionId).toBe(sessionId);
    const receipt = await settled(commandId);
    const ambiguous = boundary === 'post-dispatch-marker' || boundary === 'post-provider-accept';
    expect(receipt).toMatchObject({ state: ambiguous ? 'interrupted' : 'succeeded', delivery: ambiguous ? 'unknown' : 'dispatched', inputId: `input-${commandId}` });
    if (before.receipt) expect(receipt.acceptedSequence).toBe(JSON.parse((before.receipt as { receipt_json: string }).receipt_json).acceptedSequence);
    const counts = await readLaunchEvidence(b(), sessionId);
    expect(counts.commands).toBe(1); expect(counts.worktrees).toBe(1); expect(counts.dispatches).toBeLessThanOrEqual(1);
    expect(counts.dispatches).toBe(boundary === 'post-dispatch-marker' ? 0 : 1);
    const canonical = await readFile(getSessionFilePath(b().dataDir, projects[1]!.sessionId, sessionId), 'utf8');
    const canonicalInputs = canonical.split('\n').filter(line => line.includes(`"controlCommandId":"${commandId}"`) && line.includes('"role":"user"')).length;
    expect(canonicalInputs).toBe(1);
    const meta = JSON.parse(await readFile(getSessionMetaPath(b().dataDir, projects[1]!.sessionId, sessionId), 'utf8')); expect(meta.controlCommandId).toBe(commandId);
    const gitWorktrees = (await exec('git', ['worktree', 'list', '--porcelain'], { cwd: b().checkout })).stdout.split(`branch refs/heads/crash/${commandId}`).length - 1; expect(gitWorktrees).toBe(1);
    observations.push({ boundary, marker, acknowledged, before, after: { ...counts, receipt, canonicalInputs, gitWorktrees, identityStable: true, metaOwned: true } });
  }
  evidence.crashes = observations;
});

test('Batch 7 DB recovery survives canonical/result dispatch/ack/stop deaths without JSON writes', async () => {
  test.setTimeout(180000);
  const observations: Record<string, unknown>[] = [];
  evidence.batch7Recovery = observations;
  for (const boundary of ['result-canonical', 'result-dispatch', 'result-ack', 'stop-runtime']) {
    const launchId = randomUUID();
    const launch = await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'session.launch', { commandId: launchId, projectId: projects[1]!.sessionId, title: `Batch7 ${boundary}`, workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: 'Synthetic recovery fixture', artifactIds: [] } });
    const sessionId = launch.sessionId!;
    await settled(launchId);
    const commandId = randomUUID();
    const armed = await controlEnvironment<{ pid: number }>(manifest, b().name, 'fixture', { operation: 'arm-recovery-crash', commandId, boundary });
    const rpc = await openFixtureRpc(b().baseUrl, sessions[1]!);
    try {
      if (boundary === 'stop-runtime') await rpc.call('session.stop', { commandId, sessionId });
      else await rpc.call('session.send', { commandId, sessionId, message: { text: '[fixture:spawn]', artifactIds: [] } });
    } catch { /* The owner is killed at its durable seam. */ }
    const marker = await until(async () => { try { return JSON.parse(await readFile(join(b().checkout, '.fixture-crash.json'), 'utf8')); } catch { return null; } }, value => value?.commandId === commandId && value.boundary === boundary);
    expect(marker.pid).toBe(armed.pid);
    expect(marker.fired).toBe(true);
    await until(() => { try { process.kill(armed.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }, Boolean);
    rpc.close();
    const query = () => readDb(db => ({
      deliveries: workerReports(db, sessionId),
      desired: loadState(db).threads[sessionId].desired,
      turns: (db.prepare('SELECT count(*) n FROM orchestration_runs WHERE thread_id=?').get(sessionId) as { n: number }).n,
      attempts: (db.prepare('SELECT count(*) n FROM orchestration_attempts WHERE thread_id=?').get(sessionId) as { n: number }).n,
    }));
    const before = await query();
    if (boundary === 'result-canonical') expect(before.deliveries).toHaveLength(0);
    else if (boundary !== 'stop-runtime') expect(before.deliveries).toMatchObject([{ state: 'dispatch_marked' }]);
    else expect(before.desired).toBe('stopped');
    await controlEnvironment(manifest, b().name, 'start');
    const repaired = await query();
    if (boundary === 'result-canonical') expect(repaired.deliveries).toMatchObject([{ state: 'pending' }]);
    if (boundary !== 'stop-runtime') {
      expect(repaired.deliveries).toHaveLength(1);
      expect(repaired.deliveries[0]!.prepared).toMatchObject({ runtimeMessage: { text: expect.stringContaining('[workerResult]') }, presentation: { source: 'worker_result', routeOrigin: 'worker_result' } });
      const snapshot = await controlEnvironment<any>(manifest, b().name, 'fixture', { operation: 'recovery-snapshot' });
      expect(snapshot.undeliveredReports.some((report: { deliveryId: string }) => report.deliveryId === repaired.deliveries[0]!.delivery_id)).toBe(true);
      await controlEnvironment(manifest, b().name, 'stop'); await controlEnvironment(manifest, b().name, 'start');
      expect((await controlEnvironment<any>(manifest, b().name, 'fixture', { operation: 'recovery-snapshot' })).recoveryId).toBe(snapshot.recoveryId);
      const reportAttempt = () => readDb(db => {
        const state = loadState(db), transfer = state.transfers[repaired.deliveries[0]!.delivery_id];
        if (transfer.kind !== 'worker_result' || !transfer.targetRunId) throw new Error('Missing canonical report run');
        const run = state.runs[transfer.targetRunId];
        return { attempt: state.attempts[run.activeAttemptId], attempts: Object.values(state.attempts).filter(attempt => attempt.runId === run.runId), resolutions: recoveryEvents(db).filter(row => row.event.type === 'recovery.resolved' && row.event.recovery.recoveryId === snapshot.recoveryId).length };
      });
      const original = await reportAttempt();
      if (boundary !== 'result-canonical') expect(original.attempt).toMatchObject({ state: 'unknown', delivery: 'unknown' });
      await controlEnvironment(manifest, b().name, 'fixture', { operation: 'recovery-resume' });
      const after = await query(), resumed = await reportAttempt();
      expect(after.deliveries.find(row => row.delivery_id === repaired.deliveries[0]!.delivery_id)?.state).toBe('consumed');
      expect(resumed.attempt.delivery).toBe('dispatched');
      expect(resumed.resolutions).toBe(1);
      if (boundary !== 'result-canonical') {
        expect(resumed.attempt.attemptId).not.toBe(original.attempt.attemptId);
        expect(resumed.attempts.find(attempt => attempt.attemptId === original.attempt.attemptId)).toMatchObject({ state: 'unknown', delivery: 'unknown' });
        expect(resumed.attempts.filter(attempt => !original.attempts.some(prior => prior.attemptId === attempt.attemptId))).toHaveLength(1);
      }
      await controlEnvironment(manifest, b().name, 'fixture', { operation: 'recovery-resume' });
      expect((await reportAttempt()).resolutions).toBe(1);
      expect((await query()).deliveries).toEqual(after.deliveries);
      expect((await query()).turns).toBe(after.turns);
      expect((await query()).attempts).toBe(after.attempts);
      observations.push({ boundary, marker, before: { deliveryRows: before.deliveries.length, states: before.deliveries.map(row => row.state), turnRows: before.turns }, repaired: { deliveryRows: repaired.deliveries.length, states: repaired.deliveries.map(row => row.state) }, after: { deliveryRows: after.deliveries.length, states: after.deliveries.map(row => row.state) }, originalAttemptId: original.attempt.attemptId, resumedAttemptId: resumed.attempt.attemptId, originalDelivery: original.attempt.delivery, resumedDelivery: resumed.attempt.delivery, resolutions: resumed.resolutions, stableOccurrence: true, repeatedDecisionNoDispatch: true });
    } else {
      const receipt = await settled(commandId); expect(receipt.state).toBe('succeeded');
      expect((await query()).desired).toBe('stopped');
      observations.push({ boundary, marker, stoppedIntentSurvives: true, receipt: receipt.state, turnRows: repaired.turns });
    }
    const metrics = await controlEnvironment<any>(manifest, b().name, 'fixture', { operation: 'metrics' });
    expect(metrics.agentsJsonControlWrites).toBe(0);
  }
  for (const environment of manifest.environments.slice(0, 3)) {
    const metrics = await controlEnvironment<any>(manifest, environment.name, 'fixture', { operation: 'metrics' });
    expect(metrics.agentsJsonControlWrites).toBe(0);
    await expect(readFile(join(environment.dataDir, 'swarm', 'agents.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  evidence.batch7DescriptorWrites = { instrumentedControlWrites: 0, fleetRoots: 3, sourceFilesCreated: 0 };
});

test('Batch 2 typed project policy survives lost acknowledgement, replay and restart', async () => {
  const proxy = await startFaultProxy({ upstream: b().baseUrl });
  const rpc = await openFixtureRpc(b().baseUrl, sessions[1]!, proxy.url);
  const model = { provider: 'codex-native', modelId: 'gpt-6-sol', thinkingLevel: 'high' };
  const create = { commandId: randomUUID(), title: 'Batch 2 project', cwd: b().checkout, model };
  const projectId = `project-${create.commandId}`;
  const commands: string[] = [];
  const command = async (method: string, input: Record<string, unknown>) => {
    const receipt = await rpc.call(method, { commandId: randomUUID(), ...input });
    expect(receipt.state).toBe('succeeded'); commands.push(method); return receipt;
  };
  try {
    expect((await rpc.call('environment.get', {})).capabilities.projectPolicy).toBe(true);
    const directories = await rpc.call('workspace.directories.list', { path: b().checkout });
    expect(directories.resolvedPath).toBe(b().checkout);
    expect((await rpc.call('workspace.directories.validate', { path: b().checkout })).valid).toBe(true);
    await command('workspace.directories.create', { parentPath: b().checkout, name: `batch2-${create.commandId}` });
    proxy.dropNextResponse({ transport: 'ws', rpcId: 'policy-lost-create' });
    await expect(rpc.call('project.create', create, 'policy-lost-create', 500)).rejects.toThrow('timed out');
    expect((await rpc.call('project.create', create)).result).toEqual({ projectId, sessionId: projectId });
    commands.push('project.create');
    await expect(rpc.call('project.update', { commandId: randomUUID(), projectId, patch: { title: 'Rejected', unsupported: true } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await command('project.update', { projectId, patch: { title: 'Policy restored', cwd: b().checkout, modelDefault: model, delegationDefaults: { managerPosture: 'hands_on' }, contextMode: 'fresh' } });
    await command('session.configure', { sessionId: projectId, model: { mode: 'override', ...model }, contextMode: 'summary', delegation: { managerPosture: { mode: 'override', value: 'hands_on' } } });
    await command('session.configure', { sessionId: projectId, model: { mode: 'inherit' }, contextMode: null, delegation: { managerPosture: { mode: 'inherit' } } });
    await command('project.reorder', { projectIds: [projectId, ...projects.filter((_, i) => i === 1).map(p => p.sessionId)] });
    await command('project.archive', { projectId });
    await command('project.restore', { projectId });
    await command('settings.recommendedDefaults.apply', {});
    const headers = { Authorization: `Bearer ${sessions[1]!.bearer}`, 'Content-Type': 'application/json' };
    expect((await fetch(`${b().baseUrl}/api/profiles/${projectId}/context-mode`, { method: 'PUT', headers, body: JSON.stringify({ mode: 'fresh', commandId: randomUUID() }) })).ok).toBe(true);
    const persisted = await readDb(db => ({ commands: (db.prepare('SELECT count(*) n FROM commands WHERE command_id=?').get(create.commandId) as { n: number }).n, profile: db.prepare('SELECT profile_json FROM control_projects WHERE project_id=?').get(projectId) }));
    expect(persisted.commands).toBe(1); expect(persisted.profile).toBeTruthy();
    rpc.close(); await controlEnvironment(manifest, b().name, 'stop'); await controlEnvironment(manifest, b().name, 'start');
    const restarted = await openFixtureRpc(b().baseUrl, sessions[1]!);
    try {
      const subscription = await restarted.call('shell.subscribe', {});
      const snapshot = await until<any>(() => restarted.frames.find(frame => frame.subscriptionId === subscription.subscriptionId && frame.item?.kind === 'snapshot')?.item.snapshot, Boolean);
      const profile = snapshot.projects.find((p: any) => p.projectId === projectId);
      expect(profile).toMatchObject({ title: 'Policy restored', cwd: b().checkout, contextMode: 'fresh', defaultModel: model, defaultSessionId: projectId });
      expect(snapshot.sessions.find((session: any) => session.sessionId === projectId)).toMatchObject({ model: { ...model, origin: 'profile_default' }, contextMode: { effective: 'fresh' } });
      expect((await restarted.call('command.get', { commandId: create.commandId })).state).toBe('succeeded');
      expect((await restarted.call('project.delete', { commandId: randomUUID(), projectId })).state).toBe('succeeded');
      commands.push('project.delete');
    } finally { restarted.close(); }
    evidence.batch2 = { commands, directoryReads: 2, lostCreateAcknowledgement: true, stableProjectIdentity: true, strictInputRejected: true, restartPolicyAndInheritance: true, httpControlOwned: true };
  } finally { rpc.close(); await proxy.stop(); }
});

test('Batch 5 typed detail features survive reconnect/restart and compact once', async () => {
  const proxy = await startFaultProxy({ upstream: b().baseUrl });
  const rpc = await openFixtureRpc(b().baseUrl, sessions[1]!, proxy.url);
  const launchId = randomUUID();
  const launched = await rpc.call('session.launch', { commandId: launchId, projectId: projects[1]!.sessionId,
    title: 'Batch 5 detail', workspaceStrategy: { kind: 'current_checkout' } });
  const sessionId = launched.sessionId;
  await settled(launchId);
  const detail = await rpc.call('session.subscribe', { sessionId });
  const features = await rpc.call('session.features.subscribe', { sessionId });
  try {
    const sendId = randomUUID();
    await rpc.call('session.send', { commandId: sendId, sessionId, message: { text: '[fixture:detail] Create the synthetic plan and explicitly requested goal.', artifactIds: [] } });
    await settled(sendId);
    await until(() => rpc.frames.filter(frame => frame.subscriptionId === detail.subscriptionId).find(frame => frame.item?.event?.type === 'plan.upsert' && frame.item.event.snapshot.plan.length), Boolean);
    await until(() => rpc.frames.filter(frame => frame.subscriptionId === detail.subscriptionId).find(frame => frame.item?.event?.type === 'goal.upsert' && frame.item.event.snapshot.goal), Boolean);
    await until(() => rpc.frames.filter(frame => frame.subscriptionId === features.subscriptionId).find(frame => frame.item?.event?.type === 'tool.activity' && frame.item.event.activity.toolCount > 0), Boolean);
    const pause = { commandId: randomUUID(), sessionId, action: 'pause' };
    proxy.dropNextResponse({ transport: 'ws', rpcId: 'goal-lost-ack' });
    await expect(rpc.call('session.goal.control', pause, 'goal-lost-ack', 500)).rejects.toThrow('timed out');
    const paused = await rpc.call('session.goal.control', pause); expect(paused.state).toBe('succeeded');
    await until(() => rpc.frames.filter(frame => frame.subscriptionId === detail.subscriptionId).find(frame => frame.item?.event?.type === 'goal.upsert' && frame.item.event.snapshot.goal?.status === 'paused'), Boolean);
    const compactLaunchId = randomUUID();
    const compactSession = await rpc.call('session.launch', { commandId: compactLaunchId, projectId: projects[1]!.sessionId, title: 'Batch 5 compact',
      workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: 'Synthetic compaction target', artifactIds: [] } });
    await settled(compactLaunchId);
    await until(() => readLaunchEvidence(b(), compactSession.sessionId), value => value.markerChanged);
    const compact = { commandId: randomUUID(), sessionId: compactSession.sessionId, mode: 'manual' };
    expect((await rpc.call('session.compact', compact)).state).toBe('succeeded');
    expect((await rpc.call('session.compact', compact)).state).toBe('succeeded');
    const counters = [];
    async function compactCount(path: string): Promise<number> {
      let count = 0;
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) count += await compactCount(join(path, entry.name));
        else if (/^process-\d+\.json$/.test(entry.name)) count += JSON.parse(await readFile(join(path, entry.name), 'utf8')).compactions ?? 0;
      }
      return count;
    }
    counters.push(await compactCount(join(b().checkout, '.fixture-codex'))); expect(counters[0]).toBe(1);
    rpc.close();
    const fresh = await openFixtureRpc(b().baseUrl, sessions[1]!);
    const snapshot = async (client: typeof fresh) => {
      const sub = await client.call('session.subscribe', { sessionId });
      return until<any>(() => client.frames.find(frame => frame.subscriptionId === sub.subscriptionId && frame.item?.kind === 'snapshot')?.item.snapshot, Boolean);
    };
    const before = await snapshot(fresh); expect(before.plan.plan[0].step).toBe('Verify typed detail'); expect(before.goal.goal.status).toBe('paused'); fresh.close();
    await writeFile(join(b().checkout, '.fixture-compact-hold'), 'synthetic handoff pause');
    const ambiguousCompact = { ...compact, commandId: randomUUID() };
    const handoff = await openFixtureRpc(b().baseUrl, sessions[1]!);
    try { await expect(handoff.call('session.compact', ambiguousCompact, 'compact-handoff', 500)).rejects.toThrow('timed out'); }
    finally { handoff.close(); }
    await until(() => fixtureRpcOnce(b().baseUrl, sessions[1]!, 'command.get', { commandId: ambiguousCompact.commandId }), receipt => receipt.state === 'running');
    counters.push(await compactCount(join(b().checkout, '.fixture-codex'))); expect(counters[1]).toBe(2);
    const priorRecovery = await readDb(db => loadState(db).recovery);
    const heldId = randomUUID();
    const held = await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'session.launch', { commandId: heldId, projectId: projects[1]!.sessionId, title: 'Batch 5 interrupted', workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: '[fixture:hold]', artifactIds: [] } });
    await settled(heldId);
    const heldDispatch = await until(() => readLaunchEvidence(b(), held.sessionId), value => value.dispatches === 1);
    await until(() => readDb(db => JSON.parse((db.prepare('SELECT descriptor_json FROM control_sessions WHERE session_id=?').get(held.sessionId) as { descriptor_json: string }).descriptor_json).status), status => status === 'streaming');
    const heldOpenTurns = await readDb(db => {
      const state = loadState(db);
      return dispatchedRuns(state, held.sessionId).filter(run => run.state === 'running' && !run.outcome && state.attempts[run.activeAttemptId].state === 'accepted' && state.attempts[run.activeAttemptId].delivery === 'dispatched').length;
    });
    expect(heldOpenTurns).toBe(1);
    const crashId = randomUUID();
    const armed = await controlEnvironment<{ pid: number }>(manifest, b().name, 'fixture', { operation: 'arm-crash', commandId: crashId, boundary: 'pre-commit' });
    await expect(fixtureRpcOnce(b().baseUrl, sessions[1]!, 'session.launch', { commandId: crashId, projectId: projects[1]!.sessionId, title: 'Crash probe', workspaceStrategy: { kind: 'current_checkout' } })).rejects.toThrow();
    await until(() => { try { process.kill(armed.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }, Boolean);
    await controlEnvironment(manifest, b().name, 'start');
    const restarted = await openFixtureRpc(b().baseUrl, sessions[1]!);
    try {
      const after = await snapshot(restarted); expect(after.plan).toEqual(before.plan); expect(after.goal.goal).toEqual(before.goal.goal);
      expect((await restarted.call('session.compact', compact)).state).toBe('succeeded');
      const ambiguousReceipt = await restarted.call('session.compact', ambiguousCompact);
      expect(ambiguousReceipt).toMatchObject({ state: 'interrupted', delivery: 'unknown' });
      expect(await restarted.call('session.compact', ambiguousCompact)).toEqual(ambiguousReceipt);
      counters.push(await compactCount(join(b().checkout, '.fixture-codex'))); expect(counters[2]).toBe(2);
      const recovery = (await restarted.call('recovery.get', {})).recovery;
      expect(recovery?.interruptedManagers).toContain(held.sessionId);
      expect(recovery.resumedAt).toBeUndefined(); expect(recovery.dismissedAt).toBeUndefined();
      if (priorRecovery?.resumedAt || priorRecovery?.dismissedAt) expect(recovery.recoveryId).not.toBe(priorRecovery.recoveryId);
      expect((await readLaunchEvidence(b(), held.sessionId)).dispatches).toBe(heldDispatch.dispatches);
      const shell = await restarted.call('shell.subscribe', {});
      const shellSnapshot = await until<any>(() => restarted.frames.find(frame => frame.subscriptionId === shell.subscriptionId && frame.item?.kind === 'snapshot')?.item.snapshot, Boolean);
      expect(shellSnapshot.recovery).toEqual(recovery);
      {
        const decide = { commandId: randomUUID(), recoveryId: recovery.recoveryId, action: 'dismiss' };
        const first = await restarted.call('recovery.decide', decide); expect(first.state).toBe('succeeded');
        expect(await restarted.call('recovery.decide', decide)).toEqual(first);
      }
      const counts = await readDb(db => ({
        goalCommands: (db.prepare('SELECT count(*) n FROM commands WHERE command_id=?').get(pause.commandId) as { n: number }).n,
        compactCommands: (db.prepare('SELECT count(*) n FROM commands WHERE command_id=?').get(compact.commandId) as { n: number }).n,
      }));
      expect(counts).toEqual({ goalCommands: 1, compactCommands: 1 });
      evidence.batch5 = { sessionId, counts, compactDispatches: counters, planRevision: after.plan.revision, goalStatus: after.goal.goal.status,
        ambiguousCompaction: { state: ambiguousReceipt.state, delivery: ambiguousReceipt.delivery, dispatches: counters[2]! - counters[0]! },
        heldTurn: { dispatches: heldDispatch.dispatches, openTurnRows: heldOpenTurns, interruptedManagerCaptured: true, noAutomaticReplay: true },
        liveTypedActivity: true, reconnect: true, restart: true, recoveryOnFreshShell: true, duplicateReceipts: true };
    } finally { restarted.close(); }
  } finally { rpc.close(); await proxy.stop(); }
});

test('two consecutive crashes retain every interrupted manager until one decision', async () => {
  const heldSessions: string[] = [];
  const occurrences: string[] = [];
  const boots: ReturnType<typeof recoveryEvents> = [];
  const priorRecovery = await readDb(db => loadState(db).recovery);
  for (let crash = 0; crash < 2; crash++) {
    const commandId = randomUUID();
    const held = await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'session.launch', { commandId, projectId: projects[1]!.sessionId,
      title: `Consecutive crash ${crash + 1}`, workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: '[fixture:hold]', artifactIds: [] } });
    heldSessions.push(held.sessionId);
    await settled(commandId);
    await until(() => readLaunchEvidence(b(), held.sessionId), value => value.dispatches === 1);
    await until(() => readDb(db => JSON.parse((db.prepare('SELECT descriptor_json FROM control_sessions WHERE session_id=?').get(held.sessionId) as { descriptor_json: string }).descriptor_json).status), status => status === 'streaming');
    const crashId = randomUUID();
    const armed = await controlEnvironment<{ pid: number }>(manifest, b().name, 'fixture', { operation: 'arm-crash', commandId: crashId, boundary: 'pre-commit' });
    await expect(fixtureRpcOnce(b().baseUrl, sessions[1]!, 'session.launch', { commandId: crashId, projectId: projects[1]!.sessionId,
      title: 'Consecutive crash probe', workspaceStrategy: { kind: 'current_checkout' } })).rejects.toThrow();
    await until(() => { try { process.kill(armed.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }, Boolean);
    await controlEnvironment(manifest, b().name, 'start');
    const recovery = (await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'recovery.get', {})).recovery;
    expect(recovery.resumedAt).toBeUndefined(); expect(recovery.dismissedAt).toBeUndefined();
    expect(recovery.interruptedManagers).toEqual(expect.arrayContaining(heldSessions));
    occurrences.push(recovery.recoveryId);
    const boot = await readDb(db => recoveryEvents(db).filter(row => row.event.type === 'recovery.required').at(-1)!);
    expect(boot.event.commandId).toMatch(/^boot:/);
    expect(boot.event.recovery).toEqual(recovery);
    boots.push(boot);
  }
  expect(occurrences[1]).toBe(occurrences[0]);
  if (priorRecovery?.resumedAt || priorRecovery?.dismissedAt) expect(occurrences[0]).not.toBe(priorRecovery.recoveryId);
  expect(boots[1]!.sequence).toBeGreaterThan(boots[0]!.sequence);
  expect(boots[1]!.event.commandId).not.toBe(boots[0]!.event.commandId);
  expect(boots[0]!.event.recovery.interruptedManagers).toContain(heldSessions[0]);
  expect(boots[0]!.event.recovery.interruptedManagers).not.toContain(heldSessions[1]);
  expect(boots[1]!.event.recovery.interruptedManagers).toEqual(expect.arrayContaining(heldSessions));
  await controlEnvironment(manifest, b().name, 'stop');
  await controlEnvironment(manifest, b().name, 'start');
  const unchanged = (await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'recovery.get', {})).recovery;
  expect(unchanged.recoveryId).toBe(occurrences[1]);
  expect(unchanged.interruptedManagers).toEqual(expect.arrayContaining(heldSessions));
  const beforeDecision = await readDb(db => {
    const state = loadState(db);
    return { recovery: state.recovery, history: recoveryEvents(db).filter(row => row.event.recovery.recoveryId === occurrences[0]),
      captured: heldSessions.map(sessionId => dispatchedRuns(state, sessionId).map(run => ({ state: run.state, outcome: run.outcome,
        attempt: state.attempts[run.activeAttemptId].state, delivery: state.attempts[run.activeAttemptId].delivery }))) };
  });
  expect(beforeDecision.recovery).toEqual(unchanged);
  expect(beforeDecision.history.slice(0, 2)).toEqual(boots);
  expect(beforeDecision.history.every(row => row.event.type === 'recovery.required')).toBe(true);
  expect(beforeDecision.captured).toEqual(heldSessions.map(() => [{ state: 'recovery', outcome: undefined, attempt: 'unknown', delivery: 'unknown' }]));
  const decision = { commandId: randomUUID(), recoveryId: occurrences[1], action: 'dismiss' };
  const receipt = await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'recovery.decide', decision);
  expect(receipt.state).toBe('succeeded');
  expect(await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'recovery.decide', decision)).toEqual(receipt);
  const closed = await readDb(db => {
    const state = loadState(db);
    return { runs: heldSessions.map(sessionId => dispatchedRuns(state, sessionId).map(run => ({ state: run.state, outcome: run.outcome }))),
      resolutions: recoveryEvents(db).filter(row => row.event.type === 'recovery.resolved' && row.event.recovery.recoveryId === occurrences[1]) };
  });
  expect(closed.runs).toEqual(heldSessions.map(() => [{ state: 'terminal', outcome: 'dismissed' }]));
  expect(closed.resolutions).toHaveLength(1);
  expect(closed.resolutions[0]!.event.commandId).toBe(decision.commandId);
  expect(closed.resolutions[0]!.event.recovery.dismissedAt).toEqual(expect.any(String));
  const dispatches = await Promise.all(heldSessions.map(async sessionId => (await readLaunchEvidence(b(), sessionId)).dispatches));
  expect(dispatches).toEqual([1, 1]);
  const decided = (await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'recovery.get', {})).recovery;
  expect(decided.dismissedAt).toEqual(expect.any(String));
  evidence.consecutiveCrashes = { occurrences, boots, interruptedManagers: heldSessions, stablePendingOccurrence: true, singleDecisionClosesBoth: true, dispatches };
});

test('a pending manager occurrence retains a new report-only crash until one decision', async () => {
  const priorRecovery = await readDb(db => loadState(db).recovery);
  const heldCommand = randomUUID();
  const held = await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'session.launch', { commandId: heldCommand, projectId: projects[1]!.sessionId,
    title: 'Manager before report-only crash', workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: '[fixture:hold]', artifactIds: [] } });
  await settled(heldCommand);
  await until(() => readLaunchEvidence(b(), held.sessionId), value => value.dispatches === 1);
  await until(() => readDb(db => JSON.parse((db.prepare('SELECT descriptor_json FROM control_sessions WHERE session_id=?').get(held.sessionId) as { descriptor_json: string }).descriptor_json).status), status => status === 'streaming');
  const firstCrash = randomUUID();
  const firstArmed = await controlEnvironment<{ pid: number }>(manifest, b().name, 'fixture', { operation: 'arm-crash', commandId: firstCrash, boundary: 'pre-commit' });
  await expect(fixtureRpcOnce(b().baseUrl, sessions[1]!, 'session.launch', { commandId: firstCrash, projectId: projects[1]!.sessionId,
    title: 'Report-only setup crash', workspaceStrategy: { kind: 'current_checkout' } })).rejects.toThrow();
  await until(() => { try { process.kill(firstArmed.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }, Boolean);
  await controlEnvironment(manifest, b().name, 'start');
  const earlier = (await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'recovery.get', {})).recovery;
  expect(earlier.interruptedManagers).toContain(held.sessionId);
  expect(earlier.resumedAt).toBeUndefined(); expect(earlier.dismissedAt).toBeUndefined();
  if (priorRecovery?.resumedAt || priorRecovery?.dismissedAt) expect(earlier.recoveryId).not.toBe(priorRecovery.recoveryId);
  const earlierBoot = await readDb(db => recoveryEvents(db).filter(row => row.event.type === 'recovery.required').at(-1)!);
  expect(earlierBoot.event.recovery).toEqual(earlier);
  const resultCommand = randomUUID();
  const owner = await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'session.launch', { commandId: resultCommand, projectId: projects[1]!.sessionId,
    title: 'Report-only result owner', workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: 'Synthetic worker result owner', artifactIds: [] } });
  await settled(resultCommand);
  await until(() => readDb(db => JSON.parse((db.prepare('SELECT descriptor_json FROM control_sessions WHERE session_id=?').get(owner.sessionId) as { descriptor_json: string }).descriptor_json).status), status => status === 'idle');
  const secondCrash = randomUUID();
  const secondArmed = await controlEnvironment<{ pid: number }>(manifest, b().name, 'fixture', { operation: 'arm-recovery-crash', commandId: secondCrash, boundary: 'result-canonical' });
  try { await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'session.send', { commandId: secondCrash, sessionId: owner.sessionId, message: { text: '[fixture:spawn]', artifactIds: [] } }); }
  catch { /* The owner dies after the canonical worker result append. */ }
  const secondMarker = await until(async () => { try { return JSON.parse(await readFile(join(b().checkout, '.fixture-crash.json'), 'utf8')); } catch { return null; } }, marker => marker?.commandId === secondCrash && marker.boundary === 'result-canonical');
  expect(secondMarker).toMatchObject({ fired: true, pid: secondArmed.pid });
  await until(() => { try { process.kill(secondArmed.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }, Boolean);
  const actorStatuses = await readDb(db => {
    const state = loadState(db);
    return Object.values(state.threads).filter(thread => thread.threadId === owner.sessionId || thread.role === 'worker' && thread.managerId === owner.sessionId)
      .map(thread => projectLifecycleStatus(state, thread.threadId)!.agentStatus);
  });
  expect(actorStatuses).not.toContain('streaming');
  await controlEnvironment(manifest, b().name, 'start');
  const reports = await readDb(db => workerReports(db, owner.sessionId));
  expect(reports).toHaveLength(1);
  const report = reports[0]!;
  expect(report.state).toBe('pending');
  expect(report.prepared).toMatchObject({ runtimeMessage: { text: expect.stringContaining('[workerResult]') }, presentation: { source: 'worker_result', routeOrigin: 'worker_result' } });
  const recovery = (await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'recovery.get', {})).recovery;
  expect(recovery.recoveryId).toBe(earlier.recoveryId);
  expect(recovery.resumedAt).toBeUndefined(); expect(recovery.dismissedAt).toBeUndefined();
  expect(recovery.interruptedManagers).toContain(held.sessionId);
  expect(recovery.interruptedManagers).toEqual(expect.arrayContaining(earlier.interruptedManagers));
  expect(recovery.interruptedWorkers).toEqual(expect.arrayContaining(earlier.interruptedWorkers));
  expect(recovery.undeliveredReports).toEqual(expect.arrayContaining(earlier.undeliveredReports));
  expect(recovery.undeliveredReports.map((value: { deliveryId: string }) => value.deliveryId)).toContain(report.delivery_id);
  expect((await readLaunchEvidence(b(), held.sessionId)).dispatches).toBe(1);
  const beforeResume = await readDb(db => ({ state: loadState(db), history: recoveryEvents(db).filter(row => row.event.recovery.recoveryId === earlier.recoveryId) }));
  expect(beforeResume.state.recovery).toEqual(recovery);
  expect(beforeResume.history[0]).toEqual(earlierBoot);
  const latestBoot = beforeResume.history.at(-1)!;
  expect(latestBoot.sequence).toBeGreaterThan(earlierBoot.sequence);
  expect(latestBoot.event.commandId).toMatch(/^boot:/);
  expect(latestBoot.event.commandId).not.toBe(earlierBoot.event.commandId);
  expect(latestBoot.event.recovery).toEqual(recovery);
  expect(beforeResume.history.every(row => row.event.type === 'recovery.required')).toBe(true);
  const heldRuns = dispatchedRuns(beforeResume.state, held.sessionId);
  expect(heldRuns).toHaveLength(1);
  const originalAttemptId = heldRuns[0]!.activeAttemptId;
  expect(heldRuns[0]).toMatchObject({ state: 'recovery' });
  expect(beforeResume.state.attempts[originalAttemptId]).toMatchObject({ state: 'unknown', delivery: 'unknown' });
  const decision = { commandId: randomUUID(), recoveryId: recovery.recoveryId, action: 'resume' };
  const receipt = await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'recovery.decide', decision);
  expect(receipt.state).toBe('succeeded');
  expect(await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'recovery.decide', decision)).toEqual(receipt);
  const resolved = await until(() => readDb(db => ({ state: loadState(db), reports: workerReports(db, owner.sessionId),
    resolutions: recoveryEvents(db).filter(row => row.event.type === 'recovery.resolved' && row.event.recovery.recoveryId === recovery.recoveryId) })), value => {
    const run = value.state.runs[heldRuns[0]!.runId];
    return run.activeAttemptId !== originalAttemptId && value.state.attempts[run.activeAttemptId].state === 'accepted' && value.reports[0]?.state === 'consumed';
  });
  expect(dispatchedRuns(resolved.state, held.sessionId)).toMatchObject([{ runId: heldRuns[0]!.runId, state: 'running' }]);
  expect(resolved.state.attempts[originalAttemptId]).toMatchObject({ state: 'unknown', delivery: 'unknown' });
  expect(resolved.state.attempts[resolved.state.runs[heldRuns[0]!.runId].activeAttemptId]).toMatchObject({ state: 'accepted', delivery: 'dispatched' });
  expect(resolved.reports).toEqual([{ ...report, state: 'consumed' }]);
  expect(resolved.resolutions).toHaveLength(1);
  expect(resolved.resolutions[0]!.event.commandId).toBe(decision.commandId);
  expect(resolved.resolutions[0]!.event.recovery.resumedAt).toEqual(expect.any(String));
  expect((await readLaunchEvidence(b(), held.sessionId)).dispatches).toBe(2);
  evidence.reportOnlyCrash = { marker: secondMarker, earlierOccurrence: earlier.recoveryId, recoveryId: recovery.recoveryId, interruptedManager: held.sessionId,
    deliveryId: report.delivery_id, actorStatuses, noAutomaticReplay: true, singleDecisionResolvesBoth: true };
});

test('9.2.10 copied data root blocks before listen; explicit local re-key revokes copied devices', async () => {
  await controlEnvironment(manifest, b().name, 'stop');
  const copied = join(manifest.root, 'copied-b-data'); await cp(b().dataDir, copied, { recursive: true });
  const blocked = spawnStandaloneBackend(b(), copied);
  await expect(blocked.ready).rejects.toThrow('IDENTITY_MISMATCH'); await blocked.stop();
  const Constructor = await loadConfiguredSqliteDatabaseConstructor(); const db = new Constructor(getEnvironmentDbPath(copied));
  let identity;
  try { identity = await recoverEnvironmentIdentity({ dataDir: copied, installationStateDir: b().installationStateDir, database: db, action: 'rekey' }); }
  finally { db.close(); }
  expect(identity.environmentId).not.toBe(sessions[1]!.environmentId);
  expect(identity.descriptor().streamEpoch).not.toBe(sessions[1]!.environment!.streamEpoch);
  const clone = spawnStandaloneBackend(b(), copied);
  try {
    const ready = await clone.ready;
    expect(ready.environment.environmentId).toBe(identity.environmentId);
    expect((await fetch(`${ready.baseUrl}/api/settings/manager-selection-catalog`, { headers: { Authorization: `Bearer ${sessions[1]!.bearer}` } })).status).toBe(401);
  } finally { await clone.stop(); await controlEnvironment(manifest, b().name, 'start'); }
  expect((await fixtureRpcOnce(b().baseUrl, sessions[1]!, 'environment.get', {})).environmentId).toBe(sessions[1]!.environmentId);
  evidence.copiedRoot = { startupBlockedBeforeListen: true, localRekey: true, environmentChanged: true, epochChanged: true, oldBearerRejected: true, sourceIdentityUnaffected: true };
});

test('9.2.10 real paged snapshot barrier orders concurrent updates; overflowing lease resyncs only its stream', async () => {
  test.setTimeout(90000);
  const seeded = await seedLoadEnvironment(manifest, b(), sessions[1]!, 1001);
  const summaryCount = await readDb(db => (db.prepare('SELECT count(*) n FROM control_sessions WHERE deleted=0').get() as { n: number }).n);
  const rpc = await openFixtureRpc(b().baseUrl, sessions[1]!);
  try {
    const first = await rpc.call('shell.subscribe', {});
    const snapshot = await until<any>(() => rpc.frames.find(frame => frame.subscriptionId === first.subscriptionId && frame.item?.kind === 'snapshot')?.item, Boolean);
    expect(snapshot.snapshot.nextPage).toBeTruthy();
    await controlEnvironment(manifest, b().name, 'fixture', { operation: 'shell-burst', sessionId: seeded.sessionIds[0], count: 8 });
    expect(rpc.frames.filter(frame => frame.subscriptionId === first.subscriptionId && ['event', 'synchronized'].includes(frame.item?.kind))).toHaveLength(0);
    const pages = [snapshot]; let next = snapshot.snapshot.nextPage;
    while (next) { const page = await rpc.call('shell.page', { page: next }); expect(page.sequence).toBe(snapshot.sequence); pages.push(page); next = page.snapshot.nextPage; }
    await until(() => rpc.frames.filter(frame => frame.subscriptionId === first.subscriptionId && frame.item?.kind === 'event').length, count => count === 8);
    const frames = rpc.frames.filter(frame => frame.subscriptionId === first.subscriptionId);
    const syncIndex = frames.findIndex(frame => frame.item?.kind === 'synchronized');
    expect(syncIndex).toBeGreaterThan(0); expect(frames.slice(syncIndex + 1).every(frame => frame.item.kind === 'event' && frame.item.sequence > snapshot.sequence)).toBe(true);
    expect(pages.flatMap(page => page.snapshot.sessions)).toHaveLength(summaryCount);
    const original = pages.flatMap(page => page.snapshot.sessions).find(session => session.sessionId === seeded.sessionIds[0]); expect(original.status).toBe('idle');
    const synchronized = frames[syncIndex]!.item; expect(synchronized.sequence).toBe(snapshot.sequence);
    rpc.socket.send(JSON.stringify({ type: 'unsubscribe', subscriptionId: first.subscriptionId }));
    const slow = await rpc.call('shell.subscribe', {});
    await until(() => rpc.frames.find(frame => frame.subscriptionId === slow.subscriptionId && frame.item?.kind === 'snapshot'), Boolean);
    await controlEnvironment(manifest, b().name, 'fixture', { operation: 'shell-burst', sessionId: seeded.sessionIds[0], count: 300 });
    const error = await until(() => rpc.frames.find(frame => frame.subscriptionId === slow.subscriptionId && frame.type === 'stream.error'), Boolean);
    expect(error!.error.code).toBe('RESYNC_REQUIRED');
    expect((await rpc.call('environment.get', {})).environmentId).toBe(sessions[1]!.environmentId);
    const metrics = await controlEnvironment<any>(manifest, b().name, 'fixture', { operation: 'metrics', gc: true });
    expect(metrics.streamQueueFramesMax).toBeLessThanOrEqual(256); expect(metrics.streamQueueBytesMax).toBeLessThanOrEqual(2097152);
    evidence.snapshotBarrier = { summaries: 1001, pages: pages.length, barrierSequence: snapshot.sequence, concurrentUpdates: 8, synchronizedBeforeUpdates: true, snapshotUnchanged: true, overflow: error!.error.code, socketSurvived: true, queueFramesMax: metrics.streamQueueFramesMax, queueBytesMax: metrics.streamQueueBytesMax };
  } finally { rpc.close(); }
});

test('a hung turn that ignores interrupt and SIGTERM is stopped, settled, and the session takes the next send', async () => {
  const a = manifest.environments[0]!; const rpc = await openFixtureRpc(a.baseUrl, sessions[0]!);
  const fixtureProcesses = async () => Promise.all((await readdir(join(a.checkout, '.fixture-codex'))).filter(file => /^process-\d+\.json$/.test(file))
    .map(async file => JSON.parse(await readFile(join(a.checkout, '.fixture-codex', file), 'utf8')) as { pid: number; threadId: string | null; turnStarts: number; interrupts: number }));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
  try {
    const launch = { commandId: randomUUID(), projectId: projects[0]!.sessionId, title: 'Hung turn', workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: '[fixture:hang]', artifactIds: [] } };
    const sessionId = (await rpc.call('session.launch', launch)).sessionId as string;
    expect(await settled(launch.commandId, 0)).toMatchObject({ state: 'succeeded', delivery: 'dispatched' });
    const nativeThread = await until(() => readDb(db => Object.values(loadState(db).bindings).find(binding => binding.scope.threadId === sessionId)?.conversation.nativeId, 0), Boolean);
    const hung = await until(async () => (await fixtureProcesses()).find(candidate => candidate.threadId === nativeThread && candidate.turnStarts === 1), Boolean);
    expect(alive(hung!.pid)).toBe(true);
    const stop = await rpc.call('session.stop', { commandId: randomUUID(), sessionId }); const stopStarted = Date.now();
    // The receipt ends as succeeded; a hung process is never a reason to report the stop as failed.
    const stopped = await settled(stop.commandId, 0); const stopMs = Date.now() - stopStarted;
    expect(stopped, JSON.stringify(stopped)).toMatchObject({ state: 'succeeded', error: null });
    expect(alive(hung!.pid)).toBe(false);
    const ignoredInterrupts = (await fixtureProcesses()).find(candidate => candidate.pid === hung!.pid)!.interrupts; expect(ignoredInterrupts).toBeGreaterThan(0);
    const afterStop = await readDb(db => loadState(db), 0);
    expect(afterStop.threads[sessionId]).toMatchObject({ desired: 'stopped', shutdown: 'clean' }); expect(afterStop.threads[sessionId]!.activeRunId).toBeUndefined();
    expect(afterStop.runs[`run-${launch.commandId}`]).toMatchObject({ state: 'terminal', outcome: 'cancelled' });
    expect((await readDb(db => db.prepare("SELECT json_extract(summary_json,'$.status') status FROM control_sessions WHERE session_id=?").get(sessionId), 0) as { status: string }).status).toBe('stopped');
    const send = await rpc.call('session.send', { commandId: randomUUID(), sessionId, message: { text: 'after the hung turn', artifactIds: [] } });
    expect(await settled(send.commandId, 0)).toMatchObject({ state: 'succeeded', delivery: 'dispatched' });
    const next = await until(() => readDb(db => loadState(db).runs[`run-${send.commandId}`], 0), run => run?.state === 'terminal');
    expect(next).toMatchObject({ outcome: 'completed' });
    const replacement = (await fixtureProcesses()).find(candidate => candidate.pid !== hung!.pid && candidate.turnStarts === 1 && alive(candidate.pid));
    expect(replacement).toBeTruthy();
    evidence.hungStop = { ignoredInterrupts, hungProcessKilled: true, stopReceipt: stopped.state, stopMs, stuckRun: 'cancelled', shutdown: 'clean', nextSend: next!.outcome, replacementProcess: true };
  } finally { rpc.close(); }
});


// QA F7/F4: exercise real RPC admission, native provider dispatch and durable live/replay projections.
async function busySendFixture(index = 0) {
  const environment = manifest.environments[index]!;
  const rpc = await openFixtureRpc(environment.baseUrl, sessions[index]!);
  const created = await rpc.call('project.create', { commandId: randomUUID(), title: 'Busy send QA', cwd: environment.checkout,
    model: { provider: 'codex-native', modelId: 'gpt-6-sol', thinkingLevel: 'high' }, secureSessionsEnabled: false });
  const sessionId = created.result.sessionId as string;
  const state = () => readDb(db => loadState(db), index);
  await until(async () => (await state()).threads[sessionId]?.activeRunId, value => !value);
  const run = (commandId: string) => until(async () => (await state()).runs[`run-${commandId}`], value => value?.state === 'terminal');
  const counters = async () => {
    const files = await readdir(join(environment.checkout, '.fixture-codex'));
    const counts = await Promise.all(files.filter(file => /^process-\d+\.json$/.test(file)).map(async file =>
      JSON.parse(await readFile(join(environment.checkout, '.fixture-codex', file), 'utf8')) as { ownerAgentId: string; turnStarts: number; steers: number; interrupts: number }));
    return counts.filter(count => count.ownerAgentId === sessionId).reduce((total, count) =>
      ({ starts: total.starts + count.turnStarts, steers: total.steers + count.steers, interrupts: total.interrupts + count.interrupts }), { starts: 0, steers: 0, interrupts: 0 });
  };
  const detail = async () => {
    const { subscriptionId } = await rpc.call('session.subscribe', { sessionId });
    return (await until(() => rpc.frames.find(frame => frame.subscriptionId === subscriptionId && frame.item?.kind === 'snapshot'), Boolean))!.item.snapshot;
  };
  const send = (text: string, delivery?: 'auto' | 'followUp' | 'steer') => rpc.call('session.send', {
    commandId: randomUUID(), sessionId, message: { text, artifactIds: [] }, ...(delivery ? { delivery } : {}) });
  const slow = async () => {
    const before = (await counters()).starts;
    const sent = await send('[fixture:slow] Finish the entire reply.');
    await until(counters, count => count.starts === before + 1);
    await until(async () => (await detail()).items, items => items.some((item: any) => item.kind === 'assistant' && item.runId === `run-${sent.commandId}`));
    return sent;
  };
  return { environment, rpc, sessionId, state, run, counters, detail, send, slow };
}
const silentNotice = 'The manager completed this turn without a visible response.';
for (const delivery of [undefined, 'auto', 'followUp'] as const) {
  test(`F7: busy ${delivery ?? 'composer default'} send queues, preserves the reply and projects pending live/replay`, async () => {
    const f = await busySendFixture();
    try {
      await f.rpc.call('shell.subscribe', {});
      const first = await f.slow(); const before = await f.counters();
      const second = await f.send('Queued follow-up while busy', delivery);
      await until(async () => (await f.state()).runs[`run-${second.commandId}`]?.entryId, Boolean);
      expect((await f.state()).runs[`run-${second.commandId}`]).toMatchObject({ state: 'queued', delivery: 'queue' });
      expect(await f.counters()).toEqual(before);
      await until(() => f.rpc.frames.find(frame => frame.item?.event?.session?.sessionId === f.sessionId && frame.item.event.session.pendingCount === 1), Boolean);
      expect((await f.detail()).session.pendingCount).toBe(1);
      expect(await f.run(first.commandId)).toMatchObject({ outcome: 'completed' });
      expect(await f.run(second.commandId)).toMatchObject({ outcome: 'completed' });
      expect(await f.counters()).toEqual({ starts: before.starts + 1, interrupts: 0, steers: 0 });
      const snapshot = await f.detail();
      expect(snapshot.items.filter((item: any) => item.kind === 'assistant' && [first.commandId, second.commandId].some(id => item.runId === `run-${id}`))).toHaveLength(2);
      expect(snapshot.items.some((item: any) => item.text === silentNotice)).toBe(false);
      expect(snapshot.session.pendingCount).toBe(0);
      evidence[`busySend-${delivery ?? 'default'}`] = { counters: await f.counters(), queuedLive: true, queuedReplay: true, completed: 2, emptyNotices: 0 };
    } finally { f.rpc.close(); }
  });
}
test('F7: explicit steer uses native steer and does not interrupt or start another turn', async () => {
  const f = await busySendFixture();
  try {
    const first = await f.slow(); const before = await f.counters();
    const steered = await f.send('Explicit correction during this turn', 'steer');
    await until(f.counters, count => count.steers === before.steers + 1);
    expect(await f.counters()).toEqual({ ...before, steers: before.steers + 1 });
    expect(await settled(steered.commandId, 0)).toMatchObject({ state: 'succeeded', delivery: 'dispatched' });
    expect(await f.run(first.commandId)).toMatchObject({ outcome: 'completed' });
    expect(await f.run(steered.commandId)).toMatchObject({ outcome: 'completed' });
    expect((await f.detail()).items.some((item: any) => item.text === silentNotice)).toBe(false);
    evidence.explicitSteer = { counters: await f.counters(), emptyNotices: 0 };
  } finally { f.rpc.close(); }
});
test('F7: Stop interrupts and failed turns never gain an empty completion notice', async () => {
  const f = await busySendFixture();
  try {
    const first = await f.slow();
    const stop = await f.rpc.call('session.stop', { commandId: randomUUID(), sessionId: f.sessionId });
    expect(await settled(stop.commandId, 0)).toMatchObject({ state: 'succeeded' });
    expect((await f.counters()).interrupts).toBeGreaterThan(0);
    expect((await f.run(first.commandId)).outcome).not.toBe('completed');
    const failed = await f.send('[fixture:error]'); expect(await f.run(failed.commandId)).toMatchObject({ outcome: 'failed' });
    expect((await f.detail()).items.some((item: any) => item.text === silentNotice)).toBe(false);
    const empty = await f.send('[fixture:empty]'); expect(await f.run(empty.commandId)).toMatchObject({ outcome: 'completed' });
    await until(async () => (await f.detail()).items.filter((item: any) => item.text === silentNotice).length, count => count === 1);
    expect((await f.detail()).items.filter((item: any) => item.text === silentNotice)).toHaveLength(1);
    evidence.stopAndSilence = { counters: await f.counters(), interruptedNotices: 0, failedNotices: 0, emptyCompletedNotices: 1 };
  } finally { f.rpc.close(); }
});
test('F4: a newly created and seeded project sends its first message without a trust decision, including after restart', async () => {
  const f = await busySendFixture(2);
  try {
    const seeded = await fetch(`${f.environment.baseUrl}/api/settings/project-resources/seed`, { method: 'POST', headers: {
      Authorization: `Bearer ${sessions[2]!.bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: f.sessionId, sessionAgentId: f.sessionId }) });
    expect(seeded.status).toBe(200);
    const resources = await seeded.json() as any;
    expect(resources.snapshot.trust.state).toBe('trusted');
    await controlEnvironment(manifest, f.environment.name, 'stop'); await controlEnvironment(manifest, f.environment.name, 'start');
    const sent = await fixtureRpcOnce(f.environment.baseUrl, sessions[2]!, 'session.send', { commandId: randomUUID(), sessionId: f.sessionId, message: { text: 'First user message', artifactIds: [] } });
    expect(await f.run(sent.commandId)).toMatchObject({ outcome: 'completed' });
    const next = await openFixtureRpc(f.environment.baseUrl, sessions[2]!);
    try { const { subscriptionId } = await next.call('session.subscribe', { sessionId: f.sessionId });
      const detail = (await until(() => next.frames.find(frame => frame.subscriptionId === subscriptionId && frame.item?.kind === 'snapshot'), Boolean))!.item.snapshot;
      expect(detail.choices.filter((choice: any) => choice.status === 'pending')).toHaveLength(0);
      expect(detail.items.some((item: any) => item.kind === 'assistant')).toBe(true);
    } finally { next.close(); }
    evidence.createdResourceTrust = { trustedOnCreation: true, persistedAcrossRestart: true, firstMessageCompleted: true, trustDecisions: 0 };
  } finally { f.rpc.close(); }
});
