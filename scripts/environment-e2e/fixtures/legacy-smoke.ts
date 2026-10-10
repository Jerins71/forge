import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixtureRpcOnce } from './rpc-client.js';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from './ws.js';
import type { BootstrapSession, EnvironmentFixture } from '../launch.js';

type Frame = Record<string, unknown>;
export interface LegacySmokeEvidence { sessionId: string; assistantReplies: number; workerResults: number; dispatches: number; choices: number; workerSpawns: number; streamingDeltas: number; }
export async function legacySmoke(environment: EnvironmentFixture, session: BootstrapSession): Promise<LegacySmokeEvidence> {
  const response = await fetch(`${environment.baseUrl}/api/v2/access/ws-ticket`, { method: 'POST', headers: { Authorization: `Bearer ${session.bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ audience: 'legacy', protocolVersion: 1 }) });
  if (!response.ok) throw new Error('Legacy smoke requires paired auth');
  const ticket = (await response.json() as { ticket: string }).ticket;
  const socket = new WebSocket(environment.baseUrl.replace('http:', 'ws:'), ['forge.v2', `ticket.${ticket}`]);
  const frames: Frame[] = [];
  let phase = 'inventory';
  const listeners = new Set<() => void>();
  socket.on('message', data => { frames.push(JSON.parse(data.toString()) as Frame); for (const listener of listeners) listener(); });
  await once(socket, 'open');
  function send(frame: Frame) { socket.send(JSON.stringify(frame)); }
  function wait(predicate: (frame: Frame) => boolean, since = 0): Promise<Frame> {
    return new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Legacy fixture smoke timed out at ${phase} (${frames.slice(since).map(frame => frame.type).slice(-20).join(',')})`)); }, 20_000);
      const check = () => {
        const error = frames.slice(since).find(frame => frame.type === 'error');
        if (error) { cleanup(); reject(new Error(`Legacy fixture command rejected (${String(error.code)})`)); return; }
        const found = frames.slice(since).find(predicate);
        if (found) { cleanup(); resolveWait(found); }
      };
      const cleanup = () => { clearTimeout(timer); listeners.delete(check); };
      listeners.add(check); check();
    });
  }
  try {
    send({ type: 'subscribe_inventory', requestId: 'legacy-smoke-inventory' });
    await wait(frame => frame.type === 'inventory_snapshot');
    phase = 'create project';
    const receipt = await fixtureRpcOnce(environment.baseUrl, session, 'project.create', { commandId: randomUUID(), title: 'Synthetic native fixture', cwd: environment.checkout, model: { provider: 'codex-native', modelId: 'gpt-6-sol', thinkingLevel: 'high' }, secureSessionsEnabled: false });
    assert.equal(receipt.state, 'succeeded');
    const manager = { agentId: receipt.result.sessionId };
    let since = frames.length;
    phase = 'subscribe conversation';
    send({ type: 'subscribe', agentId: manager.agentId, conversationView: 'all' });
    await wait(frame => frame.type === 'ready' && frame.subscribedAgentId === manager.agentId, since);
    async function message(text: string, expected: string) {
      phase = 'hello reply';
      const start = frames.length;
      send({ type: 'user_message', agentId: manager.agentId, text });
      const reply = await wait(frame => frame.type === 'conversation_message' && frame.agentId === manager.agentId && frame.role === 'assistant' && String(frame.text).includes(expected), start);
      phase = 'hello idle';
      await wait(frame => frame.type === 'agent_status' && frame.agentId === manager.agentId && frame.status === 'idle', frames.indexOf(reply) + 1);
    }
    await message('Synthetic smoke hello.', `fixture:${environment.instanceId}:assistant reply`);
    since = frames.length;
    phase = 'choice request';
    send({ type: 'user_message', agentId: manager.agentId, text: '[fixture:choice]' });
    const choice = await wait(frame => frame.type === 'choice_request' && frame.status === 'pending', since);
    phase = 'choice answer';
    send({ type: 'choice_response', agentId: manager.agentId, choiceId: choice.choiceId,
      answers: [{ questionId: 'fixture-choice', selectedOptionIds: ['0'] }] });
    const answerReply = await wait(frame => frame.type === 'conversation_message' && frame.role === 'assistant' && String(frame.text).includes('choice answered'), since);
    phase = 'choice idle';
    await wait(frame => frame.type === 'agent_status' && frame.agentId === manager.agentId && frame.status === 'idle', frames.indexOf(answerReply) + 1);
    since = frames.length;
    phase = 'worker result';
    send({ type: 'user_message', agentId: manager.agentId, text: '[fixture:spawn]' });
    await wait(frame => frame.type === 'conversation_message' && frame.agentId === manager.agentId && frame.source === 'worker_report' && String(frame.text).includes('worker result'), since);
    await wait(frame => frame.type === 'agent_status' && frame.agentId === manager.agentId && frame.status === 'idle', since);
    const counterFiles = (await readdir(join(environment.checkout, '.fixture-codex'))).filter(file => /^process-\d+\.json$/.test(file));
    const counters = await Promise.all(counterFiles.map(async file => JSON.parse(await readFile(join(environment.checkout, '.fixture-codex', file), 'utf8')) as Record<string, number>));
    const sum = (key: string) => counters.reduce((total, counter) => total + (counter[key] ?? 0), 0);
    assert.equal(sum('choices'), 1);
    assert.equal(sum('workerSpawns'), 1);
    assert(sum('turnStarts') >= 4);
    assert.equal(await readFile(join(environment.checkout, 'fixture-provider-marker.txt'), 'utf8').then(text => text.split(':')[0]), environment.instanceId);
    return {
      sessionId: manager.agentId,
      assistantReplies: frames.filter(frame => frame.type === 'conversation_message' && frame.role === 'assistant').length,
      workerResults: frames.filter(frame => frame.type === 'conversation_message' && frame.source === 'worker_report').length,
      dispatches: sum('turnStarts'), choices: sum('choices'), workerSpawns: sum('workerSpawns'),
      streamingDeltas: frames.filter(frame => frame.type === 'assistant_message_chunk' || frame.type === 'conversation_log').length,
    };
  } finally {
    const closed = once(socket, 'close'); socket.close(); await closed;
  }
}
