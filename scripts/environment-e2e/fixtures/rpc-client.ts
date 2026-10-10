import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from './ws.js';
import type { BootstrapSession } from '../launch.js';

export type WireFrame = Record<string, any>;
export async function openFixtureRpc(baseUrl: string, session: BootstrapSession, socketBase = baseUrl) {
  const response = await fetch(`${baseUrl}/api/v2/access/ws-ticket`, { method: 'POST', headers: { Connection: 'close', Authorization: `Bearer ${session.bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ audience: 'rpc', protocolVersion: 2 }) });
  if (!response.ok) throw new Error(`RPC ticket denied (${response.status})`);
  const ticket = (await response.json() as { ticket: string }).ticket;
  const socket = new WebSocket(`${socketBase.replace(/^http/, 'ws')}/api/v2/rpc`, ['forge.v2', `ticket.${ticket}`]);
  const frames: WireFrame[] = [];
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  socket.on('message', data => {
    const frame = JSON.parse(data.toString()) as WireFrame; frames.push(frame);
    const call = pending.get(frame.requestId);
    if (!call || !['result', 'error'].includes(frame.type)) return;
    pending.delete(frame.requestId); clearTimeout(call.timer);
    if (frame.type === 'result') call.resolve(frame.output);
    else call.reject(Object.assign(new Error(frame.error?.message ?? 'RPC denied'), frame.error));
  });
  socket.on('error', () => {});
  socket.on('close', () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('RPC socket closed')); } pending.clear(); });
  await once(socket, 'open');
  return { socket, frames,
    call<T = any>(method: string, input: unknown, requestId: string = randomUUID(), timeoutMs = 10000): Promise<T> {
      return new Promise<T>((resolveCall, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('RPC result timed out')); }, timeoutMs);
        pending.set(requestId, { resolve: resolveCall, reject, timer });
        socket.send(JSON.stringify({ type: 'request', requestId, method, input }));
      });
    },
    close() { socket.terminate(); },
  };
}
export async function fixtureRpcOnce<T = any>(baseUrl: string, session: BootstrapSession, method: string, input: unknown): Promise<T> {
  const rpc = await openFixtureRpc(baseUrl, session);
  try { return await rpc.call<T>(method, input); } finally { rpc.close(); }
}
export async function until<T>(read: () => T | Promise<T>, accepts: (value: T) => boolean, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await read(); if (accepts(value)) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Fixture observation timed out');
}
