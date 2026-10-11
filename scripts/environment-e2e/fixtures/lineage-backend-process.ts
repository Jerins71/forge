import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// The normal server, core, SQLite store, Forge tools and both native adapters run.
// Only Claude's remote model is replaced by a local SSE endpoint, as in its replay
// acceptance. All homes and inert authentication belong to the owned fixture.
if (!process.env.FORGE_DATA_DIR || !process.env.FORGE_E2E_CHECKOUT) throw new Error('Missing isolated lineage fixture');
const home = join(process.env.FORGE_DATA_DIR, 'fixture-claude');
await mkdir(home, { recursive: true });
let sequence = 0;
const provider = createServer(async (request, response) => {
  for await (const chunk of request) { void chunk; /* Retain no synthetic provider input. */ }
  if (request.url?.includes('count_tokens')) { response.setHeader('Content-Type', 'application/json'); response.end('{"input_tokens":100}'); return; }
  if (!request.url?.startsWith('/v1/messages')) { response.end('{}'); return; }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit('message_start', { message: { id: `lineage_${++sequence}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Claude lineage fixture reply.' } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } });
  emit('message_stop', {}); response.end();
});
await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address() as { port: number };
process.env.FORGE_E2E_LINEAGE = '1';
process.env.FORGE_CLAUDE_AUTH_MODE = 'api_key';
process.env.CLAUDE_CONFIG_DIR = home;
process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-fixture';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${address.port}`;
await import('./backend-process.js');
