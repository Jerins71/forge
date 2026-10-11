// API-key access for the native Claude and Codex runtimes, end to end: one owned backend, the real
// CLIs, and a local provider stub. No real key and no provider call: each CLI runs behind a guard
// that leaves it only loopback, and every key and token here is generated for this run.
//
// Ways this can fail, each asserted below:
//  1. API-key mode sends to the provider's own endpoint, not the saved base URL.
//  2. API-key mode sends the subscription login, or sends the key in the wrong header.
//  3. Subscription mode sends the saved API key because one is still stored.
//  4. Saving a new mode stops a running turn, or the running turn changes credentials midway.
//  5. The new mode is not used by the first turn after the session goes idle.
//  6. API-key mode with no key falls back to the subscription login instead of stopping.
//  7. A malformed base URL, or API-key mode without a key, is accepted by settings.
//  8. The key comes back in a settings response or an RPC frame.
//  9. The key is written to a log, session file, database, native CLI home, or process arguments.
// 10. The saved key is readable by other users of the machine.
// 11. A removed key stays on disk, or the block shows a generic error instead of saying what to do.
// 12. Codex's own reconnect notices, sent while it falls back from a rejected WebSocket, fail the send.
//
// pnpm --dir apps/backend exec tsx ../../scripts/environment-e2e/native-api-access.e2e.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { join, relative } from 'node:path';
import type { ClaudeAuthStatus, CodexAuthStatus, NativeApiAccessUpdate } from '@forge/protocol';
import { resolveClaudeExecutable } from '../../apps/backend/src/swarm/runtime/claude/claude-runtime-environment.js';
import { getSharedAuthFilePath } from '../../apps/backend/src/swarm/storage/data-paths.js';
import { openFixtureRpc, until } from './fixtures/rpc-client.js';
import { launchFleet, repositoryRoot } from './launch.js';

type Kind = 'codex' | 'claude';
type Credential = 'api-key' | 'subscription' | 'other';
interface Seen { kind: Kind; path: string; credential: Credential; header: string; account: boolean; aborted: boolean; finished: boolean; body: string }

const keys: Record<Kind, string> = { codex: `sk-forge-e2e-${randomUUID()}`, claude: `sk-ant-forge-e2e-${randomUUID()}` };
// Stand-ins for a saved subscription login: a ChatGPT access token and a Claude OAuth token.
const chatgptToken = [{ alg: 'none' }, { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_forge_e2e' }, exp: 4102444800 }]
  .map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + `.${randomUUID()}`;
const claudeToken = `sk-ant-oat01-forge-e2e-${randomUUID()}`;
const subscription: Record<Kind, string> = { codex: chatgptToken, claude: claudeToken };
const models: Record<Kind, object> = {
  codex: { provider: 'codex-native', modelId: 'gpt-6-sol', thinkingLevel: 'high' },
  claude: { provider: 'claude-native', modelId: 'claude-sonnet-5', thinkingLevel: 'high' },
};

const seen: Seen[] = [];
/** Connection tests the backend made against the stub; kept apart from the turns the CLIs ran. */
const probes: Seen[] = [];
let upgradeStatus = '426 Upgrade Required';
let upgrades = 0;
let hold: { kind: Kind; release: Promise<void>; open(): void } | undefined;
function armHold(kind: Kind) {
  let open!: () => void;
  hold = { kind, release: new Promise<void>(resolve => { open = resolve; }), open: () => open() };
  return hold;
}
function sse(response: ServerResponse, events: Array<Record<string, unknown>>) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}
async function provide(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  // Codex compresses requests made with a ChatGPT login.
  const raw = Buffer.concat(chunks), encoding = request.headers['content-encoding'];
  const body = (encoding === 'zstd' ? zstdDecompressSync(raw) : encoding === 'gzip' ? gunzipSync(raw) : raw).toString('utf8');
  const path = request.url ?? '';
  const kind: Kind | undefined = request.method === 'POST' && path.startsWith('/v1/responses') ? 'codex'
    : request.method === 'POST' && path.startsWith('/v1/messages') && !path.includes('count_tokens') ? 'claude' : undefined;
  if (!kind) {
    response.writeHead(path.includes('count_tokens') ? 200 : 404, { 'Content-Type': 'application/json' });
    response.end(path.includes('count_tokens') ? '{"input_tokens":100}' : '{"error":{"message":"Not served by the stub","type":"not_found_error"}}');
    return;
  }
  const bearer = request.headers.authorization?.replace(/^Bearer /, '');
  const apiKey = request.headers['x-api-key'];
  const value = typeof apiKey === 'string' ? apiKey : bearer;
  const entry: Seen = { kind, path, body, aborted: false, finished: false, account: Boolean(request.headers['chatgpt-account-id']),
    header: typeof apiKey === 'string' ? 'x-api-key' : bearer ? 'authorization: Bearer' : 'none',
    credential: value === keys[kind] ? 'api-key' : value === subscription[kind] ? 'subscription' : 'other' };
  // A connection test posts an empty object: a provider refuses it before any model runs. It is not a turn.
  if (body.trim() === '{}') {
    probes.push(entry);
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end('{"error":{"message":"Empty request","type":"invalid_request_error"}}');
    return;
  }
  seen.push(entry);
  response.on('close', () => { entry.aborted = !entry.finished; });
  if (hold?.kind === kind) { const held = hold; hold = undefined; await held.release; }
  entry.finished = true;
  if (kind === 'codex') {
    const item = { id: `msg_${seen.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Stub reply.', annotations: [] }] };
    sse(response, [{ type: 'response.created', response: { id: `resp_${seen.length}` } }, { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: `resp_${seen.length}`, output: [item], usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } }]);
    return;
  }
  let model = 'claude-sonnet-5';
  try { model = JSON.parse(body).model; } catch { /* The stub reply does not depend on the request. */ }
  sse(response, [{ type: 'message_start', message: { id: `msg_${seen.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } },
    // The real CLI streams this thinking block; Forge must surface it as a reasoning row.
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Stub reasoning.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'c3R1Yg==' } }, { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Stub reply.' } },
    { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }, { type: 'message_stop' }]);
}

/** Every file under `root` that contains `needle`. */
/** What is saved, apart from the latest connection-test result, which is asserted where a test is expected. */
function savedAccess(access: CodexAuthStatus['access']) {
  if (!access) return access;
  const { probe: _probe, ...saved } = access;
  return saved;
}
async function filesContaining(root: string, needle: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await filesContaining(path, needle, found);
    else if (entry.isFile() && (await readFile(path).catch(() => Buffer.alloc(0))).includes(needle)) found.push(path);
  }
  return found;
}

async function main() {
  if (process.platform === 'win32') throw new Error('The native CLI guards are POSIX shell scripts');
  const work = await mkdtemp(join(tmpdir(), 'forge-native-api-access-'));
  const artifactRoot = join(repositoryRoot, '.internal/forge-v2-remote/native-api-access');
  await rm(artifactRoot, { recursive: true, force: true });
  const stub = createServer((request, response) => { void provide(request, response).catch(() => response.destroy()); });
  // Codex tries a WebSocket first; 426 moves it straight to the HTTP request the stub serves.
  stub.on('upgrade', (_request, socket) => { upgrades++; socket.end(`HTTP/1.1 ${upgradeStatus}\r\nContent-Length: 0\r\n\r\n`); });
  await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve));
  const stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  const baseUrls: Record<Kind, string> = { codex: `${stubUrl}/v1`, claude: `${stubUrl}/` };

  // Guards: the real executable, limited to loopback, logging its arguments.
  const real: Record<Kind, string> = { codex: execFileSync('which', ['codex'], { encoding: 'utf8' }).trim(), claude: await resolveClaudeExecutable({}) };
  const versions: Record<Kind, string> = { codex: execFileSync(real.codex, ['--version'], { encoding: 'utf8' }).trim(), claude: execFileSync(real.claude, ['--version'], { encoding: 'utf8' }).trim() };
  const spawnLog: Record<Kind, string> = { codex: join(work, 'codex-spawns.log'), claude: join(work, 'claude-spawns.log') };
  const guard = async (kind: Kind, extra = '') => {
    const path = join(work, `${kind}-guard`);
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' ${kind === 'codex' ? '"$*"' : '"$1 $2"'} >> ${JSON.stringify(spawnLog[kind])}\nexport HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost\n${extra}exec ${JSON.stringify(real[kind])} "$@"\n`, { mode: 0o700 });
    await writeFile(spawnLog[kind], '');
    return path;
  };
  const claudeHome = join(work, 'claude-config');
  await mkdir(claudeHome);
  const fleet = await launchFleet({ environments: 1, out: join(artifactRoot, 'manifest.json'), artifactRoot: join(artifactRoot, 'logs'), backendEnv: {
    CODEX_BIN: await guard('codex'), CLAUDE_CONFIG_DIR: claudeHome,
    // The guard stands in for Claude's saved subscription login, which lives in the OS keychain.
    CLAUDE_BIN: await guard('claude', `export CLAUDE_CODE_OAUTH_TOKEN=${claudeToken}\n`),
  } });
  const evidence: Record<string, unknown> = { versions, stub: 'loopback only', realProviderCalls: 0 };
  let failed = true;
  try {
    const environment = fleet.manifest.environments[0]!;
    const session = await fleet.pairing.bootstrap(fleet.children[0]!, environment);
    const authFile = getSharedAuthFilePath(environment.dataDir);
    // This environment's saved ChatGPT login, as the device-code sign-in stores it.
    await writeFile(authFile, JSON.stringify({ 'openai-codex': { type: 'oauth', access: chatgptToken, refresh: `forge-e2e-refresh-${randomUUID()}`, expires: Date.now() + 86_400_000, accountId: 'acct_forge_e2e' } }), { mode: 0o600 });

    const wire: string[] = [];
    const settings = async <T>(kind: Kind, body?: object): Promise<{ status: number; body: T & { error?: string } }> => {
      const response = await fetch(`${environment.baseUrl}/api/settings/${kind}-native`, { method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${session.bearer}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text();
      wire.push(text);
      return { status: response.status, body: JSON.parse(text) };
    };
    const configure = (kind: Kind, access: NativeApiAccessUpdate) => settings<ClaudeAuthStatus | CodexAuthStatus>(kind, { action: 'configure', access });
    const rpc = await openFixtureRpc(environment.baseUrl, session);
    const settled = (commandId: string) => until(() => rpc.call('command.get', { commandId }), receipt => !['accepted', 'running'].includes(receipt.state), 120_000);
    const succeeded = async (commandId: string) => { const receipt = await settled(commandId); assert.equal(receipt.state, 'succeeded', JSON.stringify([receipt, ...rpc.frames.filter(frame => /error|fail/i.test(JSON.stringify(frame))).slice(-4)]).slice(0, 6000)); };
    const spawns = async (kind: Kind) => (await readFile(spawnLog[kind], 'utf8')).split('\n').filter(line => line && !/^(--version|auth)( |$)/.test(line));
    const requests = (kind: Kind) => seen.filter(entry => entry.kind === kind);
    const idle = (sessionId: string) => until(async () => {
      const shell = await openFixtureRpc(environment.baseUrl, session);
      try {
        await shell.call('shell.subscribe', {});
        const snapshot = await until<any>(() => shell.frames.filter(frame => frame.item?.kind === 'snapshot').at(-1)?.item.snapshot, Boolean);
        return snapshot.sessions.find((row: any) => row.sessionId === sessionId)?.status;
      } finally { shell.close(); }
    }, status => status === 'idle', 60_000);

    for (const kind of ['codex', 'claude'] as const) {
      const result: Record<string, unknown> = {};
      evidence[kind] = result;
      const initial = await settings<CodexAuthStatus>(kind);
      assert.deepEqual(savedAccess(initial.body.access), { mode: 'subscription', apiKeyConfigured: false }, `${kind}: subscription is the default`);

      // 7. Settings reject what cannot work, with a message a person can act on.
      const noKey = await configure(kind, { mode: 'api_key', baseUrl: baseUrls[kind] });
      assert.equal(noKey.status, 400);
      assert.match(noKey.body.error!, /Enter an API key/);
      for (const baseUrl of ['router.example.com/v1', 'ftp://router.example.com', `http://user:pass@127.0.0.1/v1`]) {
        const malformed = await configure(kind, { mode: 'api_key', apiKey: keys[kind], baseUrl });
        assert.equal(malformed.status, 400, `${kind}: ${baseUrl} is rejected`);
        assert.match(malformed.body.error!, /base URL must be/i);
      }
      assert.deepEqual(savedAccess((await settings<CodexAuthStatus>(kind)).body.access), { mode: 'subscription', apiKeyConfigured: false }, `${kind}: rejected settings save nothing`);
      result.validation = { apiKeyRequired: noKey.body.error, malformedUrlRejected: true };

      // 1, 2. API-key mode: the custom base URL receives the key in the provider's header.
      const saved = await configure(kind, { mode: 'api_key', apiKey: keys[kind], baseUrl: baseUrls[kind] });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.deepEqual(savedAccess(saved.body.access), { mode: 'api_key', apiKeyConfigured: true, baseUrl: baseUrls[kind] });
      // Saving a key tests the connection: the stub answers at the provider's path under the saved base URL.
      assert.equal(saved.body.access?.probe?.outcome, 'ok', JSON.stringify(saved.body.access?.probe));
      assert.ok(saved.body.access?.probe?.endpoint?.startsWith(baseUrls[kind]), `${kind}: the connection test used the saved base URL`);
      assert.equal(probes.filter(entry => entry.kind === kind).at(-1)?.credential, 'api-key', `${kind}: the connection test carried the saved key`);
      assert.equal(saved.body.connected, true);
      const project = await rpc.call('project.create', { commandId: randomUUID(), title: `API access ${kind}`, cwd: environment.checkout, model: models[kind], secureSessionsEnabled: false }, randomUUID(), 60_000);
      assert.equal(project.state, 'succeeded');
      const sessionId = project.result.sessionId as string;
      await rpc.call('session.subscribe', { sessionId });
      const send = async (text: string) => (await rpc.call('session.send', { commandId: randomUUID(), sessionId, message: { text, artifactIds: [] } })).commandId as string;
      // The project's hidden onboarding turn runs first; this check is about access, not about sending across it.
      await until(() => requests(kind).some(entry => entry.finished), Boolean, 120_000);
      await idle(sessionId);
      await succeeded(await send('First message, with an API key.'));
      await until(() => requests(kind).some(entry => entry.finished), Boolean, 120_000);
      await idle(sessionId);
      assert(requests(kind).every(entry => entry.credential === 'api-key'), `${kind}: only the API key reaches the base URL`);
      if (kind === 'claude') {
        // The bundled Claude CLI's own thinking stream becomes one persisted reasoning row.
        const reasoning = await until<any>(() => rpc.frames.map(frame => frame.item?.event).find(event => event?.type === 'item.upsert' && event.item.activity?.kind === 'reasoning' && event.item.activity.sessionId === sessionId)?.item, Boolean, 30_000);
        assert.equal(reasoning.text, 'Stub reasoning.');
        assert.equal((await rpc.call('session.content', { sessionId, contentRef: reasoning.contentRef, offset: 0, maxBytes: 4096 })).text, 'Stub reasoning.');
        result.reasoningRow = { summary: reasoning.text, status: reasoning.activity.status };
      }
      assert.equal(requests(kind)[0]!.header, kind === 'codex' ? 'authorization: Bearer' : 'x-api-key');
      if (kind === 'codex') assert.match((await spawns(kind)).at(-1)!, new RegExp(`openai_base_url="${baseUrls.codex}"`));
      result.apiKeyMode = { requests: requests(kind).length, header: requests(kind)[0]!.header, path: requests(kind)[0]!.path, reachedCustomBaseUrl: true };

      // 4. Saving a new mode during a turn leaves that turn alone.
      const before = { requests: requests(kind).length, spawns: (await spawns(kind)).length };
      const gate = armHold(kind);
      const running = await send('Second message, held open while the mode changes.');
      const held = await until(() => requests(kind)[before.requests], Boolean, 120_000);
      const switched = await configure(kind, { mode: 'subscription' });
      assert.equal(switched.status, 200, JSON.stringify(switched.body));
      assert.deepEqual(savedAccess(switched.body.access), { mode: 'subscription', apiKeyConfigured: true, baseUrl: baseUrls[kind] });
      // 9. While the CLI is running with the key, it is not in any process's arguments.
      const processList = execFileSync('ps', ['-Ao', 'args'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      assert(!processList.includes(keys[kind]), `${kind}: the key is not in process arguments`);
      await new Promise(resolve => setTimeout(resolve, 1500));
      assert.equal(held.aborted, false, `${kind}: the running turn keeps its connection`);
      assert.equal((await spawns(kind)).length, before.spawns, `${kind}: no new process while the turn runs`);
      assert.equal(held.credential, 'api-key');
      gate.open();
      await succeeded(running);
      await idle(sessionId);
      assert(requests(kind).every(entry => entry.credential === 'api-key' && !entry.aborted), `${kind}: the running turn finished on the key it started with`);

      // 3, 5. The first turn after idle uses the subscription login, although the key is still saved.
      const afterSwitch = requests(kind).length;
      await succeeded(await send('Third message, on the subscription.'));
      await until(() => requests(kind).slice(afterSwitch).some(entry => entry.finished), Boolean, 120_000);
      await idle(sessionId);
      const onSubscription = requests(kind).slice(afterSwitch);
      assert(onSubscription.every(entry => entry.credential === 'subscription' && entry.header === 'authorization: Bearer'), `${kind}: subscription mode sends only the subscription login`);
      if (kind === 'codex') assert(onSubscription.every(entry => entry.account), 'codex: ChatGPT account header accompanies the login');
      assert((await spawns(kind)).length > before.spawns, `${kind}: the runtime was replaced at the idle boundary`);
      // The replacement resumes the same native conversation: earlier turns reach the provider once, from
      // native history, and nothing is injected in their place.
      const resumed = onSubscription[0]!.body;
      const count = (text: string) => resumed.split(text).length - 1;
      assert.deepEqual([count('First message, with an API key.'), count('Second message, held open while the mode changes.'), count('Third message, on the subscription.')], [1, 1, 1], `${kind}: history is resumed natively, not duplicated`);
      assert.equal(count('Forge context transfer'), 0, `${kind}: no handoff text is injected for a credential change`);
      result.switchAtIdle = { runningTurnAborted: false, processesDuringTurn: before.spawns, processesAfterIdle: (await spawns(kind)).length,
        subscriptionRequests: onSubscription.length, subscriptionHeader: onSubscription[0]!.header, baseUrlAppliesToSubscription: true,
        nativeConversationResumed: true, earlierTurnsInRequest: 'once each', handoffTextInjected: false };

      // And back, keeping the saved key without sending it again.
      const back = await configure(kind, { mode: 'api_key' });
      assert.deepEqual(savedAccess(back.body.access), { mode: 'api_key', apiKeyConfigured: true, baseUrl: baseUrls[kind] });
      const afterBack = requests(kind).length;
      await succeeded(await send('Fourth message, with the saved key again.'));
      await until(() => requests(kind).slice(afterBack).some(entry => entry.finished), Boolean, 120_000);
      await idle(sessionId);
      assert(requests(kind).slice(afterBack).every(entry => entry.credential === 'api-key'), `${kind}: the saved key is used again`);
      result.switchBack = { requests: requests(kind).length - afterBack, savedKeyReused: true };

      // 6. Removing the key leaves API-key mode blocked with a clear message at every entry point; it never
      // borrows the subscription login.
      const removed = await configure(kind, { mode: 'api_key', removeApiKey: true });
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      assert.deepEqual(savedAccess(removed.body.access), { mode: 'api_key', apiKeyConfigured: false, baseUrl: baseUrls[kind] });
      assert.equal(removed.body.connected, false);
      assert.deepEqual(await filesContaining(environment.dataDir, keys[kind]), [], `${kind}: the removed key is gone from disk`);
      const clear = new RegExp(`${kind === 'codex' ? 'Codex' : 'Claude'} is set to use an API key, but no key is saved on this environment`);
      if (kind === 'claude') assert.match(removed.body.message ?? '', clear);
      const blockedAt = requests(kind).length;
      const outcome = async (call: Promise<any>) => JSON.stringify(await call.then(async receipt => ['accepted', 'running'].includes(receipt.state) ? settled(receipt.commandId) : receipt, error => ({ rejected: String(error.message) })));
      const blockedSend = await outcome(rpc.call('session.send', { commandId: randomUUID(), sessionId, message: { text: 'This must not run.', artifactIds: [] } }));
      assert.match(blockedSend, clear, `${kind}: sending says why it cannot run`);
      const blockedCreate = await outcome(rpc.call('project.create', { commandId: randomUUID(), title: `No key ${kind}`, cwd: environment.checkout, model: models[kind], secureSessionsEnabled: false }, randomUUID(), 60_000));
      assert.match(blockedCreate, clear, `${kind}: creating a project says why it cannot run`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      assert.equal(requests(kind).length, blockedAt, `${kind}: nothing is sent without the key`);
      result.missingKey = { removedThroughSettings: true, keyOnDisk: false, requestsSent: 0, sendError: clear.source, projectCreateError: clear.source };
      assert.equal((await configure(kind, { mode: 'api_key', apiKey: keys[kind] })).status, 200);
      await succeeded(await send('Fifth message, after saving the key again.'));
      await until(() => requests(kind).slice(blockedAt).some(entry => entry.finished), Boolean, 120_000);
      await idle(sessionId);
      assert(requests(kind).slice(blockedAt).every(entry => entry.credential === 'api-key'));
    }

    // A router that rejects Codex's WebSocket upgrade outright: Codex retries, then completes over HTTP.
    // Those retries are not a failed send.
    upgradeStatus = '404 Not Found';
    const routed = await rpc.call('project.create', { commandId: randomUUID(), title: 'API access codex, no WebSocket', cwd: environment.checkout, model: models.codex, secureSessionsEnabled: false }, randomUUID(), 60_000);
    assert.equal(routed.state, 'succeeded', JSON.stringify(routed));
    await rpc.call('session.subscribe', { sessionId: routed.result.sessionId });
    const upgradesBefore = upgrades, routedAt = seen.length;
    const routedSend = await rpc.call('session.send', { commandId: randomUUID(), sessionId: routed.result.sessionId, message: { text: 'Through a router without WebSocket support.', artifactIds: [] } });
    await succeeded(routedSend.commandId);
    await until(() => seen.slice(routedAt).some(entry => entry.kind === 'codex' && entry.finished), Boolean, 120_000);
    await idle(routed.result.sessionId);
    assert(upgrades - upgradesBefore > 1, 'Codex retried the rejected WebSocket upgrade');
    assert(seen.slice(routedAt).every(entry => entry.credential === 'api-key' && !entry.aborted));
    evidence.codexWebSocketRejected = { upgradeStatus, upgradeAttempts: upgrades - upgradesBefore, sendReceipt: 'succeeded', completedOverHttp: true };
    upgradeStatus = '426 Upgrade Required';

    // 8. Nothing sent to a client carries a key.
    const sentToClients = wire.join('\n') + JSON.stringify(rpc.frames);
    for (const kind of ['codex', 'claude'] as const) assert(!sentToClients.includes(keys[kind]), `${kind}: the key is in no settings response or RPC frame`);
    rpc.close();
    // 9, 10. On disk the keys exist only in the protected auth file.
    await new Promise(resolve => setTimeout(resolve, 1000));
    const holders: Record<string, string[]> = {};
    for (const kind of ['codex', 'claude'] as const) {
      const found = (await Promise.all([fleet.manifest.root, artifactRoot, work].map(root => filesContaining(root, keys[kind])))).flat();
      holders[kind] = found.map(path => relative(fleet.manifest.root, path));
      assert.deepEqual(found, [authFile], `${kind}: the key is stored only in auth.json`);
    }
    assert.equal((await stat(authFile)).mode & 0o777, 0o600);
    evidence.secrets = { settingsResponses: wire.length, rpcFrames: rpc.frames.length, keyInResponsesOrFrames: false, keyInProcessArguments: false,
      filesHoldingKey: holders, authFileMode: '0600', scanned: ['fleet root (data, checkout, native homes)', 'backend logs', 'native CLI config'] };
    evidence.requests = seen.map(({ kind, path, credential, header, aborted }) => ({ kind, path, credential, header, aborted }));
    evidence.spawns = { codex: await spawns('codex'), claude: (await spawns('claude')).length };
    failed = false;
  } finally {
    if (failed) evidence.failure = { requests: seen.map(({ kind, path, credential, header, aborted }) => ({ kind, path, credential, header, aborted })), codexSpawns: await readFile(spawnLog.codex, 'utf8').catch(() => ''), claudeSpawns: await readFile(spawnLog.claude, 'utf8').catch(() => '') };
    await fleet.stop(failed).catch(() => undefined);
    stub.closeAllConnections();
    await new Promise<void>(resolve => stub.close(() => resolve()));
    await rm(work, { recursive: true, force: true });
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(join(artifactRoot, 'evidence.json'), `${JSON.stringify({ passed: !failed, ...evidence }, null, 2)}\n`);
  }
  console.log(`Native API access passed; evidence in ${join(artifactRoot, 'evidence.json')}`);
}
await main().catch(error => { console.error(error); process.exitCode = 1; });
