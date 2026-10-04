import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import type { WebSocket as Socket, RawData } from 'ws';
import { WebSocket, WebSocketServer } from './fixtures/ws.js';

export type ResponseFault = { transport: 'http'; path: string } | { transport: 'ws'; rpcId: string | number };
export interface WireMetrics {
  http: { requestBytes: number; responseBytes: number };
  ws: { requestBytes: number; responseBytes: number; requestFrames: number; responseFrames: number };
  droppedResponses: number;
}

/** Application payload counts only. No headers, protocols, addresses or bodies are retained. */
export async function startFaultProxy(options: { upstream: string; port?: number }) {
  const upstream = new URL(options.upstream);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password) {
    throw new Error('Expected a credential-free HTTP(S) upstream');
  }
  const counts: WireMetrics = {
    http: { requestBytes: 0, responseBytes: 0 },
    ws: { requestBytes: 0, responseBytes: 0, requestFrames: 0, responseFrames: 0 },
    droppedResponses: 0,
  };
  let nextId = 0;
  let fault: ResponseFault | undefined;
  const active = new Map<number, { transport: 'http' | 'ws'; close(): void }>();
  const sockets = new Set<Duplex>();
  const server = createServer((req, res) => {
    const id = ++nextId;
    const target = new URL(req.url ?? '/', upstream);
    // A request target never controls the upstream authority.
    target.protocol = upstream.protocol;
    target.host = upstream.host;
    const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const forwarded = transport(target, { method: req.method, headers: { ...req.headers, host: upstream.host } });
    active.set(id, { transport: 'http', close: () => { forwarded.destroy(); res.destroy(); } });
    req.on('data', (chunk: Buffer) => { counts.http.requestBytes += chunk.byteLength; });
    req.on('aborted', () => forwarded.destroy());
    forwarded.on('error', () => { active.delete(id); res.destroy(); });
    res.on('close', () => { active.delete(id); forwarded.destroy(); });
    forwarded.on('response', response => {
      const drop = fault?.transport === 'http' && fault.path === target.pathname;
      if (drop) { fault = undefined; counts.droppedResponses++; }
      else res.writeHead(response.statusCode ?? 502, response.headers);
      response.on('data', (chunk: Buffer) => {
        counts.http.responseBytes += chunk.byteLength;
        if (!drop && !res.write(chunk)) { response.pause(); res.once('drain', () => response.resume()); }
      });
      response.on('error', () => res.destroy());
      response.on('end', () => { if (drop) res.destroy(); else res.end(); active.delete(id); });
    });
    req.pipe(forwarded);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  server.on('upgrade', (req, downstream, head) => {
    const id = ++nextId;
    const target = new URL(req.url ?? '/', upstream);
    target.host = upstream.host;
    target.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
    const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim()).filter(Boolean);
    const headers = { ...req.headers };
    // ws generates handshake fields; forward remaining authorization and Origin unchanged.
    for (const key of ['host', 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) delete headers[key];
    const remote = new WebSocket(target, protocols, { headers, maxPayload: 1_048_576, handshakeTimeout: 10_000 });
    let local: Socket | undefined;
    const buffered: Array<{ data: RawData; binary: boolean }> = [];
    let bufferedBytes = 0;
    const close = () => { local?.terminate(); remote.terminate(); downstream.destroy(); active.delete(id); };
    active.set(id, { transport: 'ws', close });
    remote.on('error', close);
    downstream.on('error', close);
    remote.on('close', (code, reason) => {
      if (local?.readyState === WebSocket.OPEN) local.close([1005, 1006, 1015].includes(code) ? 1011 : code, reason);
      else downstream.destroy();
      active.delete(id);
    });
    remote.on('message', (data, binary) => {
      const size = byteLength(data);
      counts.ws.responseBytes += size;
      counts.ws.responseFrames++;
      if (!binary && fault?.transport === 'ws') {
        try {
          const frame = JSON.parse(data.toString()) as { id?: unknown; requestId?: unknown; type?: unknown; result?: unknown; error?: unknown };
          if ((frame.requestId ?? frame.id) === fault.rpcId && (frame.type === 'result' || 'result' in frame || 'error' in frame)) {
            fault = undefined; counts.droppedResponses++; return;
          }
        } catch { /* Non-JSON frames are forwarded unchanged. */ }
      }
      if (local?.readyState === WebSocket.OPEN) {
        if (local.bufferedAmount + size > 2_097_152) { close(); return; }
        local.send(data, { binary });
      } else {
        bufferedBytes += size;
        if (bufferedBytes > 2_097_152 || buffered.length >= 256) { close(); return; }
        buffered.push({ data, binary });
      }
    });
    remote.on('open', () => {
      if (downstream.destroyed) { close(); return; }
      wss.handleUpgrade(req, downstream, head, socket => {
        local = socket;
        socket.on('error', close);
        socket.on('close', () => { remote.terminate(); active.delete(id); });
        socket.on('message', (data, binary) => {
          const size = byteLength(data);
          counts.ws.requestBytes += size; counts.ws.requestFrames++;
          if (remote.readyState !== WebSocket.OPEN || remote.bufferedAmount + size > 2_097_152) { close(); return; }
          remote.send(data, { binary });
        });
        for (const item of buffered) socket.send(item.data, { binary: item.binary });
        buffered.length = 0;
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Proxy did not bind a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    metrics: (): WireMetrics => structuredClone(counts),
    connections: () => [...active].map(([id, value]) => ({ id, transport: value.transport })),
    dropNextResponse: (selected: ResponseFault) => { if (fault) throw new Error('A response fault is already armed'); fault = selected; },
    closeConnection: (id: number) => { const selected = active.get(id); if (!selected) throw new Error('Unknown proxy connection'); selected.close(); },
    stop: async () => {
      for (const selected of [...active.values()]) selected.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
function byteLength(data: RawData): number {
  return Array.isArray(data) ? data.reduce((sum, item) => sum + item.byteLength, 0) : data.byteLength;
}
