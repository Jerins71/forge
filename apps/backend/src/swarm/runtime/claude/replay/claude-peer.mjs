// Replaces only the native process. The real Claude SDK parser and MCP transport run.
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const socket = connect(Number(process.env.FORGE_CLAUDE_REPLAY_PORT), '127.0.0.1');
socket.on('connect', () => {
  socket.write(JSON.stringify({ hello: true, pid: process.pid, bindings: {
    $sessionId: args.includes('--session-id') ? option('--session-id') : option('--resume'),
  } }) + '\n');
  createInterface({ input: process.stdin }).on('line', line => socket.write(JSON.stringify({ frame: JSON.parse(line) }) + '\n'))
    .on('close', () => { socket.destroy(); process.exit(0); });
});
createInterface({ input: socket }).on('line', line => {
  const message = JSON.parse(line);
  if ('exit' in message) process.exit(message.exit);
  process.stdout.write(JSON.stringify(message.frame) + '\n');
});
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
