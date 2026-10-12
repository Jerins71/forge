import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// The normal server, core, SQLite store, Forge tools and both native adapters run, and Claude
// sessions run the real bundled Claude Code. Only Claude's remote model is replaced, by a local
// SSE endpoint, as in its replay acceptance. Codex sessions are unchanged. All homes and inert
// authentication belong to the owned fixture.
if (!process.env.FORGE_DATA_DIR || !process.env.FORGE_E2E_CHECKOUT) throw new Error('Missing isolated Claude fixture');
const home = join(process.env.FORGE_DATA_DIR, 'fixture-claude');
await mkdir(home, { recursive: true });

/** The prompt the scheduled wake-up submits when it fires; the model answers it once. */
const WAKEUP_PROMPT = '[fixture:wakeup-fired] Resume after the scheduled check.';
type Block = { type: string; text?: string; name?: string; tool_use_id?: string };
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
