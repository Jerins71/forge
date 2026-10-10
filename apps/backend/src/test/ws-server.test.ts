import { createTestEnvironment } from '../test-support/environment-auth.js'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { expect, it } from 'vitest'
import { SwarmWebSocketServer } from '../ws/server.js'
import { getAvailablePort } from '../test-support/index.js'
import { WsServerTestSwarmManager as TestSwarmManager, bootWsServerTestManager as bootWithDefaultManager, makeWsServerTempConfig as makeTempConfig } from '../test-support/ws-integration-harness.js'

it('replays canonical manager history over native RPC and removes both legacy upgrade routes', async () => {
  const config = await makeTempConfig(await getAvailablePort()); const manager = new TestSwarmManager(config); await bootWithDefaultManager(manager, config);
  const { environment, unreadTracker, paired } = await createTestEnvironment(manager);
  const server = new SwarmWebSocketServer({ environment, unreadTracker, swarmManager: manager, host: config.host, port: config.port, });
  await server.start(); environment.start();
  const base = `ws://${config.host}:${config.port}`;
  const connect = async () => {
    const client = new WebSocket(base + '/api/v2/rpc', await paired.protocols()); await once(client, 'open');
    return { client, call: (method: string, input: unknown) => new Promise<any>((resolve, reject) => {
      const requestId = randomUUID(); const listener = (raw: WebSocket.RawData) => { const frame = JSON.parse(raw.toString()); if (frame.requestId !== requestId) return; client.off('message', listener); if (frame.type === 'result') resolve(frame.output); else reject(frame.error); };
      client.on('message', listener); client.send(JSON.stringify({ type: 'request', requestId, method, input }));
    }) };
  };
  try {
    for (const path of ['/', '/api/cli/ws']) {
      const obsolete = new WebSocket(base + path, await paired.protocols()); obsolete.on('error', () => {});
      const status = await new Promise<number>(resolve => obsolete.once('unexpected-response', (_req, res) => { res.resume(); obsolete.terminate(); resolve(res.statusCode!); })); expect(status).toBe(404);
    }
    const a = await connect();
    try {
      const receipt = await a.call('session.send', { commandId: randomUUID(), sessionId: 'manager', message: { text: 'remember this', artifactIds: [] } });
      for (let i = 0; i < 100; i++) { const current = await a.call('command.get', { commandId: receipt.commandId }); if (current.state === 'succeeded') break; await new Promise(r => setTimeout(r, 10)); }
    } finally { a.client.terminate(); }
    const b = await connect();
    try { const history = await b.call('session.history', { sessionId: 'manager', turns: 20 }); expect(JSON.stringify(history.items)).toContain('remember this'); }
    finally { b.client.terminate(); }
  } finally { await server.stop(); }
}, 15_000)
