#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';

// Real app-server boundary: one JSON-RPC message per line, bidirectional requests.
// No network, shell execution, provider credentials or prompt text in counters.
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.155.0');
  process.exit(0);
}
if (process.argv[2] !== 'app-server') throw new Error('Fixture supports --version and app-server only');
const checkout = realpathSync(process.cwd());
const fixture = JSON.parse(readFileSync(join(checkout, '.fixture-environment.json'), 'utf8'));
if (fixture.formatVersion !== 1 || !fixture.instanceId) throw new Error('Not a marked fixture checkout');
const nativeHome = realpathSync(process.env.CODEX_HOME);
const nativeCheckout = dirname(dirname(nativeHome));
const homeFixture = JSON.parse(readFileSync(join(nativeCheckout, '.fixture-environment.json'), 'utf8'));
if (homeFixture.instanceId !== fixture.instanceId) throw new Error('Fixture native home belongs to another environment');
const stateDir = dirname(nativeHome);
mkdirSync(stateDir, { recursive: true });
const counterPath = join(stateDir, `process-${process.pid}.json`);
const counters = { formatVersion: 1, instanceId: fixture.instanceId, pid: process.pid, ownerAgentId: null, threadId: null,
  initialize: 0, threadStarts: 0, turnStarts: 0, compactions: 0, steers: 0, interrupts: 0, toolCalls: 0, choices: 0, workerSpawns: 0, workerResults: 0 };
const threads = new Map();
const pending = new Map();
let requestId = 0;
let threadId = 0;
let active;
function write(path, value) {
  const parent = realpathSync(dirname(path));
  const owned = [checkout, nativeCheckout].some(root => {
    const local = relative(root, parent);
    return !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`);
  });
  if (!owned) throw new Error('Fixture write outside checkout');
  writeFileSync(path, value, { mode: 0o600 });
}
function count(name) { counters[name]++; write(counterPath, `${JSON.stringify(counters)}\n`); }
write(counterPath, `${JSON.stringify(counters)}\n`);
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }
function ask(method, params) {
  const id = `fixture-request-${++requestId}`;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ jsonrpc: '2.0', id, method, params }); });
}
function context(turn) { return { threadId: turn.thread.id, turnId: turn.id }; }
function complete(turn, status = 'completed') {
  if (turn.done) return;
  turn.done = true;
  if (active === turn) active = undefined;
  notify('turn/completed', { threadId: turn.thread.id, turn: { id: turn.id, status, items: [], error: null } });
}
async function dynamicTool(turn, tool, args) {
  const namespace = turn.thread.dynamicTools.find(value => value.name === 'forge');
  if (!namespace?.tools.some(value => value.name === tool)) throw new Error(`Fixture requires registered Forge tool: ${tool}`);
  count('toolCalls');
  return ask('item/tool/call', { ...context(turn), callId: `${turn.id}-tool-${counters.toolCalls}`, namespace: 'forge', tool, arguments: args });
}
async function runTurn(turn, text) {
  if (turn.done) return;
  notify('turn/started', { threadId: turn.thread.id, turn: { id: turn.id, status: 'inProgress', items: [] } });
  let reply = `fixture:${fixture.instanceId}:assistant reply`;
  try {
    if (text.includes('[fixture:hold]')) return;
    if (text.includes('[fixture:detail]')) {
      await dynamicTool(turn, 'update_plan', { plan: [{ step: 'Verify typed detail', status: 'in_progress' }] });
      await dynamicTool(turn, 'create_goal', { objective: 'Verify the explicitly requested fixture goal', tokenBudget: 1 });
    }
    if (text.includes('[fixture:choice]')) {
      count('choices');
      const result = await ask('item/tool/requestUserInput', { ...context(turn), itemId: `${turn.id}-choice`, questions: [{
        id: 'fixture-choice', header: 'Fixture choice', question: 'Which synthetic option?', isSecret: false,
        options: [{ label: 'Continue', description: 'Complete this fixture turn.' }, { label: 'Wait', description: 'Alternate synthetic option.' }],
      }] });
      if (!result.answers?.['fixture-choice']) throw new Error('Fixture choice response missing');
      reply = `fixture:${fixture.instanceId}:choice answered`;
    }
    if (text.includes('[fixture:spawn]') || text.includes('[fixture:spawn-choice]')) {
      count('workerSpawns');
      const result = await dynamicTool(turn, 'spawn_agent', { agentId: text.includes('[fixture:spawn-choice]') ? 'fixture-choice-worker' : 'fixture-worker', customSpecialist: 'fixture-worker',
        cwd: checkout, initialMessage: text.includes('[fixture:spawn-choice]') ? '[fixture:choice] Request the synthetic worker choice.' : '[fixture:worker] Return the synthetic worker result.' });
      if (result.success !== true) throw new Error('Fixture worker spawn failed');
      reply = `fixture:${fixture.instanceId}:worker spawned`;
    }
    if (text.includes('[fixture:worker]')) reply = `fixture:${fixture.instanceId}:worker result`;
    if (text.includes('[fixture:long-tool]')) {
      await dynamicTool(turn, 'notes', { op: 'write', path: 'fixture-output.txt', text: 'synthetic-output '.repeat(3000) });
      await dynamicTool(turn, 'notes', { op: 'read', path: 'fixture-output.txt', maxChars: 16000 });
    }
    if (turn.done) return;
    write(join(checkout, 'fixture-provider-marker.txt'), `${fixture.instanceId}:turns=${counters.turnStarts}\n`);
    const item = { id: `${turn.id}-assistant`, type: 'agentMessage', text: '', phase: 'final_answer' };
    notify('item/started', { ...context(turn), item });
    const half = Math.floor(reply.length / 2);
    notify('item/agentMessage/delta', { ...context(turn), itemId: item.id, delta: reply.slice(0, half) });
    notify('item/agentMessage/delta', { ...context(turn), itemId: item.id, delta: reply.slice(half) });
    notify('item/completed', { ...context(turn), item: { ...item, text: reply } });
    notify('thread/tokenUsage/updated', { threadId: turn.thread.id, turnId: turn.id,
      tokenUsage: { total: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, last: { totalTokens: 20 }, modelContextWindow: 128000 } });
    complete(turn);
  } catch {
    if (!turn.done) {
      notify('error', { ...context(turn), error: { message: 'Synthetic fixture scenario failed' }, willRetry: false });
      complete(turn, 'failed');
    }
  }
}
function threadResponse(thread) { return { thread: { id: thread.id, path: thread.path, turns: [] }, model: thread.model }; }
async function request(method, params = {}) {
  if (method === 'initialize') { count('initialize'); return { userAgent: 'forge-fixture/1', platformFamily: process.platform }; }
  if (method === 'account/login/start') {
    if (params.type !== 'apiKey' || params.apiKey !== 'forge-fixture-inert-not-a-provider-key') throw new Error('Fixture accepts synthetic identity only');
    return { type: 'apiKey' };
  }
  if (method === 'thread/backgroundTerminals/clean') return {};
  if (method === 'account/read') return { account: null, requiresOpenaiAuth: false };
  if (method === 'model/list') return { data: [{ id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'Fixture Codex',
    description: 'Deterministic fixture', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Fixture' }], defaultReasoningEffort: 'high' }], nextCursor: null };
  if (method === 'thread/start') {
    count('threadStarts');
    const id = `fixture-${fixture.instanceId}-${process.pid}-${++threadId}`;
    const rollouts = join(stateDir, 'native-home');
    mkdirSync(rollouts, { recursive: true });
    const thread = { id, path: join(rollouts, `${id}.jsonl`), dynamicTools: params.dynamicTools ?? [], model: params.model ?? 'gpt-6-sol' };
    write(thread.path, `${JSON.stringify({ type: 'session_meta', payload: { id, dynamic_tools: thread.dynamicTools } })}\n`);
    counters.ownerAgentId = /Your agent ID: `([^`]+)`/.exec(params.developerInstructions ?? '')?.[1] ?? null;
    counters.threadId = id;
    write(counterPath, `${JSON.stringify(counters)}\n`);
    threads.set(id, thread);
    return threadResponse(thread);
  }
  if (method === 'thread/resume' || method === 'thread/fork') {
    const path = join(stateDir, 'native-home', `${params.threadId}.jsonl`);
    if (!existsSync(path)) throw new Error('Unknown persisted fixture thread');
    const header = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]);
    const thread = { id: params.threadId, path, dynamicTools: header.payload.dynamic_tools, model: params.model ?? 'gpt-6-sol' };
    counters.threadId = thread.id;
    write(counterPath, `${JSON.stringify(counters)}\n`);
    threads.set(thread.id, thread);
    return threadResponse(thread);
  }
  if (method === 'thread/compact/start') {
    const thread = threads.get(params.threadId);
    if (!thread || active) throw new Error('Compaction requires an idle fixture thread');
    count('compactions');
    const turn = { thread, id: `${thread.id}-compact-${counters.compactions}`, done: false };
    active = turn;
    setTimeout(() => {
      notify('turn/started', { threadId: thread.id, turn: { id: turn.id, status: 'inProgress', items: [] } });
      const item = { id: `${turn.id}-item`, type: 'contextCompaction' };
      notify('item/started', { ...context(turn), item });
      notify('item/completed', { ...context(turn), item });
      complete(turn);
    }, 15);
    return {};
  }
  if (method === 'thread/inject_items') return {};
  if (method === 'turn/start') {
    const thread = threads.get(params.threadId);
    if (!thread || active) throw new Error('Unknown thread or turn already active');
    count('turnStarts');
    const turn = { thread, id: `${thread.id}-turn-${counters.turnStarts}`, done: false };
    active = turn;
    const text = (params.input ?? []).map(item => item.text ?? '').join('\n');
    if (text.includes('worker result') && !text.includes('[fixture:worker]')) count('workerResults');
    // Acknowledge before notifications, matching the native transport race.
    setTimeout(() => void runTurn(turn, text), 15);
    return { turn: { id: turn.id, status: 'inProgress', items: [] } };
  }
  if (method === 'turn/steer') {
    if (!active || active.id !== params.expectedTurnId) throw new Error('Turn is no longer active');
    count('steers');
    const text = (params.input ?? []).map(item => item.text ?? '').join('\n');
    if (text.includes('worker result')) count('workerResults');
    notify('item/completed', { ...context(active), item: { id: `${active.id}-steer-${counters.steers}`, type: 'userMessage', clientId: params.clientUserMessageId } });
    return { turnId: active.id };
  }
  if (method === 'turn/interrupt') { count('interrupts'); if (active) complete(active, 'interrupted'); return {}; }
  throw new Error('Unsupported fixture JSON-RPC method');
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
  if (!message.method) {
    const work = pending.get(message.id);
    if (work) { pending.delete(message.id); if (message.error) work.reject(new Error('Forge tool request rejected')); else work.resolve(message.result); }
    return;
  }
  if (message.id === undefined) return; // initialized notification
  void request(message.method, message.params).then(result => send({ jsonrpc: '2.0', id: message.id, result }),
    () => send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Synthetic fixture request rejected' } }));
});
input.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
