// Raw replay transport, including the app-server-owned rollout metadata on fork.
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('codex-cli 0.155.0'); process.exit(0); }
const home = process.env.CODEX_HOME;
const { port } = JSON.parse(readFileSync(join(home, 'replay-peer.json'), 'utf8'));
const rollout = join(home, `replay-rollout-${process.pid}.jsonl`);
const socket = connect(port, '127.0.0.1');
let allocating;
socket.on('connect', () => {
  socket.write(JSON.stringify({ hello: true, pid: process.pid, bindings: { $cwd: process.cwd(), $rollout: rollout } }) + '\n');
  createInterface({ input: process.stdin }).on('line', line => {
    const outbound = JSON.parse(line);
    if (outbound.method === 'thread/start' || outbound.method === 'thread/fork') {
      let tools = outbound.params.dynamicTools;
      if (outbound.method === 'thread/fork') {
        const source = readdirSync(home).filter(name => name.startsWith('replay-rollout-')).map(name => JSON.parse(readFileSync(join(home, name), 'utf8').split('\n')[0])).find(entry => entry.payload.id === outbound.params.threadId);
        if (!source) throw new Error('Replay fork source does not exist');
        tools = source.payload.dynamic_tools;
      }
      writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'unbound', dynamic_tools: tools } }) + '\n');
      allocating = outbound.id;
    }
    socket.write(JSON.stringify({ frame: outbound }) + '\n');
  }).on('close', () => { socket.destroy(); process.exit(0); });
});
createInterface({ input: socket }).on('line', line => {
  const message = JSON.parse(line);
  if ('exit' in message) process.exit(message.exit);
  const frame = message.frame;
  if (frame.id === allocating && frame.result?.thread?.id) {
    const metadata = JSON.parse(readFileSync(rollout, 'utf8'));
    metadata.payload.id = frame.result.thread.id;
    writeFileSync(rollout, JSON.stringify(metadata) + '\n');
    allocating = undefined;
  }
  process.stdout.write(JSON.stringify(frame) + '\n');
});
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
