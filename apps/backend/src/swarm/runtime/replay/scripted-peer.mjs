// A raw stdio peer. Forge still owns the actual readline/JSON-RPC parser.
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('codex-cli 0.155.0'); process.exit(0); }
const home = process.env.CODEX_HOME;
const { port } = JSON.parse(readFileSync(join(home, 'replay-peer.json'), 'utf8'));
const rollout = join(home, `replay-rollout-${process.pid}.jsonl`);
const socket = connect(port, '127.0.0.1');
let outbound;
socket.on('connect', () => {
socket.write(JSON.stringify({ hello: true, pid: process.pid, bindings: { $cwd: process.cwd(), $rollout: rollout } }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  outbound = JSON.parse(line);
  if (outbound.method === 'thread/start') writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'unbound', dynamic_tools: outbound.params.dynamicTools } }) + '\n');
  socket.write(JSON.stringify({ frame: outbound }) + '\n');
}).on('close', () => { socket.destroy(); process.exit(0); });
});
createInterface({ input: socket }).on('line', line => {
  const message = JSON.parse(line);
  if ('exit' in message) process.exit(message.exit);
  const frame = message.frame;
  if (frame.result?.thread?.id && outbound?.method === 'thread/start') {
    const metadata = JSON.parse(readFileSync(rollout, 'utf8'));
    metadata.payload.id = frame.result.thread.id;
    writeFileSync(rollout, JSON.stringify(metadata) + '\n');
  }
  process.stdout.write(JSON.stringify(frame) + '\n');
});
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
