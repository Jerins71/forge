// Replaces only the native process. The real Claude SDK parser and MCP transport run.
import { connect } from 'node:net';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (process.env.FORGE_CLAUDE_REPLAY_ARGS_PATH) appendFileSync(process.env.FORGE_CLAUDE_REPLAY_ARGS_PATH, JSON.stringify(args) + "\n");
const option = name => {
  const value = args.find(arg => arg.startsWith(name + '='));
  const index = args.indexOf(name);
  return value ? value.slice(name.length + 1) : index < 0 ? undefined : args[index + 1];
};
// A real Claude process busy with its provider stream outlives a closed input until it is signalled hard.
const lingers = process.env.FORGE_CLAUDE_REPLAY_LINGER === '1';
if (lingers) process.on('SIGTERM', () => {});
const socket = connect(Number(process.env.FORGE_CLAUDE_REPLAY_PORT), '127.0.0.1');
socket.on('connect', () => {
  socket.write(JSON.stringify({ hello: true, pid: process.pid, bindings: {
    $sessionId: option('--session-id') ?? option('--resume'),
  } }) + '\n');
  createInterface({ input: process.stdin }).on('line', line => socket.write(JSON.stringify({ frame: JSON.parse(line) }) + '\n'))
    .on('close', () => { if (!lingers) { socket.destroy(); process.exit(0); } });
});
createInterface({ input: socket }).on('line', line => {
  const message = JSON.parse(line);
  if ('exit' in message) process.exit(message.exit);
  process.stdout.write(JSON.stringify(message.frame) + '\n');
});
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
