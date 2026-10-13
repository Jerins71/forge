import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeRuntimeEvents } from '../../../apps/backend/src/swarm/runtime/claude/claude-runtime-events.js';

// The normal server, core, SQLite store, Forge tools and both native adapters run, and Claude
// sessions run the real bundled Claude Code. Only Claude's remote model is replaced, by a local
// SSE endpoint, as in its replay acceptance. Codex sessions are unchanged. All homes and inert
// authentication belong to the owned fixture.
if (!process.env.FORGE_DATA_DIR || !process.env.FORGE_E2E_CHECKOUT) throw new Error('Missing isolated Claude fixture');
const home = join(process.env.FORGE_DATA_DIR, 'fixture-claude');
await mkdir(home, { recursive: true });

// Replay the incident's already-settled root: its original task-registration edges were absent.
// The real CLI still owns the background process and sends its completion wake. Only that first
// task's registration projection is suppressed, so the test exercises native continuation admission.
const untracked = new WeakSet<ClaudeRuntimeEvents>();
const mapFrame = ClaudeRuntimeEvents.prototype.map;
ClaudeRuntimeEvents.prototype.map = function (frame) {
  if (frame.type === 'assistant' && frame.message.content.some(block => block.type === 'tool_use' && (block.input as { description?: string }).description === 'Untracked native wake fixture')) untracked.add(this);
  if (untracked.has(this) && frame.type === 'system') {
    if (frame.subtype === 'task_started' || frame.subtype === 'background_tasks_changed') return [];
    if (frame.subtype === 'task_notification') untracked.delete(this);
  }
  return mapFrame.call(this, frame);
};

/** The prompt the scheduled wake-up submits when it fires; the model answers it once. */
const WAKEUP_PROMPT = '[fixture:wakeup-fired] Resume after the scheduled check.';
type Block = { type: string; text?: string; name?: string; tool_use_id?: string; content?: string | Block[] };
type Message = { role: string; content: string | Block[] };
const blocks = (message: Message | undefined): Block[] => !message ? [] : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
/**
 * What the model does next, from the request alone. A turn containing `[fixture:wakeup]` calls
 * Claude's own ScheduleWakeup, the way a real model would, and the CLI schedules, holds and later
 * fires it. Everything else is one plain reply.
 */
function reply(body: { messages?: Message[]; tools?: Array<{ name: string }> }): { text: string } | { tool: string; input: object } {
  // Claude Code may follow the user's turn with a system-role context message; the turn is the last user message.
  const last = [...body.messages ?? []].reverse().find(message => message.role === 'user');
  const text = blocks(last).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
  const answered = blocks(last).some(block => block.type === 'tool_result');
  const lastAssistant = (body.messages ?? []).reduce((index, message, next) => message.role === 'assistant' ? next : index, -1);
  const pendingText = (body.messages ?? []).slice(lastAssistant + 1).flatMap(blocks).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
  if (pendingText.includes('[fixture:background-update]')) return { text: 'Update delivered while the background command runs.' };
  if (text.includes('[fixture:native-wake]') && !answered && body.tools?.some(tool => tool.name === 'Bash')) {
    return { tool: 'Bash', input: { command: `node -e 'const fs=require("node:fs");const timer=setInterval(()=>{if(fs.existsSync(".fixture-background-release")){clearInterval(timer);console.log("Native wake fixture completed")}},100)'`, run_in_background: true, description: 'Untracked native wake fixture' } };
  }
  if (text.includes('<task-notification>') && text.includes('native wake fixture') && body.tools?.some(tool => tool.name === 'Bash')) {
    return { tool: 'Bash', input: { command: `node -e 'const fs=require("node:fs");const timer=setInterval(()=>{if(fs.existsSync(".fixture-wake-release")){clearInterval(timer);console.log("Wake turn finished")}},100)'`, description: 'Hold the native wake turn for update' } };
  }
  if (answered && body.messages?.some(message => blocks(message).some(block => block.type === 'tool_use' && (block as { input?: { description?: string } }).input?.description === 'Hold the native wake turn for update'))) return { text: 'Native wake turn finished successfully.' };
  if (text.includes('[fixture:background]') && !answered && body.tools?.some(tool => tool.name === 'Bash')) {
    return { tool: 'Bash', input: { command: `node -e 'const fs=require("node:fs");const timer=setInterval(()=>{if(fs.existsSync(".fixture-background-release")){clearInterval(timer);console.log("Background fixture completed")}},100)'`, run_in_background: true, description: 'Wait for the background fixture release' } };
  }
  if (text.includes('[fixture:background-update]')) return { text: 'Update delivered while the background command runs.' };
  if (text.includes('<task-notification>') && text.includes('background fixture')) return { text: 'Background fixture finished successfully.' };
  if (answered && body.messages?.some(message => blocks(message).some(block => block.type === 'tool_use' && block.name === 'Bash'))) {
    return { text: 'Background command started; waiting for its completion.' };
  }
  if (text.includes('[fixture:wakeup-fired]')) return { text: 'Woke up: the scheduled check ran.' };
  if (text.includes('[fixture:wakeup]') && !answered && body.tools?.some(tool => tool.name === 'ScheduleWakeup')) {
    return { tool: 'ScheduleWakeup', input: { delaySeconds: 120, reason: 'Check the fixture build again', prompt: WAKEUP_PROMPT, noop: false } };
  }
  if (answered && body.messages?.some(message => blocks(message).some(block => block.type === 'tool_use' && block.name === 'ScheduleWakeup'))) {
    return { text: 'Waiting for the scheduled check.' };
  }
  return { text: 'Claude lineage fixture reply.' };
}

let sequence = 0;
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (request.url?.includes('count_tokens')) { response.setHeader('Content-Type', 'application/json'); response.end('{"input_tokens":100}'); return; }
  if (!request.url?.startsWith('/v1/messages')) { response.end('{}'); return; }
  // Read only to choose the scripted step; synthetic provider input is not retained.
  let body: Parameters<typeof reply>[0] = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* A plain reply. */ }
  const requestedText = (body.messages ?? []).filter(message => message.role === 'user').flatMap(blocks).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
  if (requestedText.lastIndexOf('[fixture:claude-fail]') > requestedText.lastIndexOf('[fixture:background]')) {
    response.writeHead(403, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Fixture provider refused this turn' } }));
    return;
  }
  const next = reply(body);
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const id = ++sequence;
  emit('message_start', { message: { id: `fixture_${id}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  if ('tool' in next) {
    emit('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_fixture_${id}`, name: next.tool, input: {} } });
    emit('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(next.input) } });
  } else {
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: next.text } });
  }
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: 'tool' in next ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } });
  emit('message_stop', {}); response.end();
});
await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address() as { port: number };
process.env.FORGE_E2E_CLAUDE = '1';
process.env.FORGE_CLAUDE_AUTH_MODE = 'api_key';
process.env.CLAUDE_CONFIG_DIR = home;
process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-fixture';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${address.port}`;
await import('./backend-process.js');
