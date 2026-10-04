import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from './ws.js';
import { startFaultProxy } from '../fault-proxy.js';

export async function proxySelfTest(): Promise<void> {
  let forwarded = 0;
  const echo = createServer((req, res) => {
    forwarded++;
    req.pipe(res);
  });
  const wss = new WebSocketServer({ server: echo });
  wss.on('connection', socket => socket.on('message', (data, binary) => socket.send(data, { binary })));
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  const address = echo.address();
  assert(address && typeof address === 'object');
  const proxy = await startFaultProxy({ upstream: `http://127.0.0.1:${address.port}` });
  const socket = new WebSocket(proxy.url.replace('http:', 'ws:'), ['forge.v2', 'fixture-ticket']);
  try {
    await once(socket, 'open');
    assert.equal(socket.protocol, 'forge.v2');
    const binaryReply = once(socket, 'message');
    socket.send(Buffer.from([0, 255, 1, 2]));
    const [bytes, binary] = await binaryReply;
    assert.equal(binary, true);
    assert.deepEqual(bytes, Buffer.from([0, 255, 1, 2]));
    const response = await fetch(`${proxy.url}/echo`, { method: 'POST', body: 'fixture-http' });
    assert.equal(await response.text(), 'fixture-http');
    proxy.dropNextResponse({ transport: 'http', path: '/drop' });
    await assert.rejects(fetch(`${proxy.url}/drop`, { method: 'POST', body: 'accepted' }));
    assert.equal(forwarded, 2, 'lost HTTP response must have reached upstream');
    proxy.dropNextResponse({ transport: 'ws', rpcId: 'lost-result' });
    socket.send(JSON.stringify({ type: 'result', requestId: 'lost-result', output: { committed: true } }));
    // The next echo is a barrier proving the selected preceding result was dropped.
    const remaining: string[] = [];
    const capture = (data: import('ws').RawData) => remaining.push(data.toString());
    socket.on('message', capture);
    const barrier = once(socket, 'message');
    socket.send(JSON.stringify({ id: 'barrier', result: {} }));
    await barrier;
    socket.off('message', capture);
    assert.equal(remaining.length, 1);
    assert.equal(JSON.parse(remaining[0]!).id, 'barrier');
    const closed = once(socket, 'close');
    const selected = proxy.connections().find(connection => connection.transport === 'ws');
    assert(selected);
    proxy.closeConnection(selected.id);
    await closed;
    const metrics = proxy.metrics();
    assert.equal(metrics.droppedResponses, 2);
    assert(metrics.http.requestBytes > 0 && metrics.http.responseBytes > 0);
    assert(metrics.ws.requestBytes > 0 && metrics.ws.responseBytes > 0);
    assert.equal(proxy.connections().length, 0);
  } finally {
    socket.terminate();
    await proxy.stop();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    echo.closeAllConnections();
    await new Promise<void>(resolve => echo.close(() => resolve()));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await proxySelfTest();
  console.log('HTTP/WS fault-proxy self-test passed');
}
