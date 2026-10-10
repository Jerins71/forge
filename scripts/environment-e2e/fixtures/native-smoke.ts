import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openFixtureRpc, until } from './rpc-client.js';
import type { BootstrapSession, EnvironmentFixture } from '../launch.js';

export interface NativeSmokeEvidence { sessionId: string; assistantReplies: number; workerResults: number; dispatches: number; choices: number; workerSpawns: number; detailItemUpdates: number; }
export async function nativeSmoke(environment: EnvironmentFixture, session: BootstrapSession): Promise<NativeSmokeEvidence> {
  const rpc = await openFixtureRpc(environment.baseUrl, session);
  try {
    const receipt = await rpc.call('project.create', { commandId: randomUUID(), title: 'Synthetic native fixture', cwd: environment.checkout, model: { provider: 'codex-native', modelId: 'gpt-6-sol', thinkingLevel: 'high' }, secureSessionsEnabled: false });
    assert.equal(receipt.state, 'succeeded');
    const sessionId = receipt.result.sessionId as string;
    await rpc.call('session.subscribe', { sessionId });
    const settled = (commandId: string) => until(() => rpc.call('command.get', { commandId }), r => !['accepted', 'running'].includes(r.state));
    const events = () => rpc.frames.flatMap(frame => frame.item?.event ? [frame.item.event] : []);
    const itemText = (event: any) => event.type === 'item.upsert' ? JSON.stringify(event.item) : '';
    const send = async (text: string) => { const sent = await rpc.call('session.send', { commandId: randomUUID(), sessionId, message: { text, artifactIds: [] } }); assert.equal((await settled(sent.commandId)).state, 'succeeded'); };
    await send('Synthetic smoke hello.');
    await until(() => events().some(e => itemText(e).includes(`fixture:${environment.instanceId}:assistant reply`)), Boolean);
    await send('[fixture:choice]');
    const choice = await until<any>(() => events().find(e => e.type === 'choice.upsert' && e.choice.status === 'pending')?.choice, Boolean);
    const answered = await rpc.call('session.choose', { commandId: randomUUID(), sessionId, choiceId: choice.choiceId, answers: [{ questionId: choice.questions[0].id, selectedOptionIds: [choice.questions[0].options[0].id] }] });
    assert.equal((await settled(answered.commandId)).state, 'succeeded');
    await until(() => events().some(e => itemText(e).includes('choice answered')), Boolean);
    await send('[fixture:spawn]');
    await until(() => events().some(e => itemText(e).includes('worker result')), Boolean);
    const files = (await readdir(join(environment.checkout, '.fixture-codex'))).filter(file => /^process-\d+\.json$/.test(file));
    const counters = await Promise.all(files.map(async file => JSON.parse(await readFile(join(environment.checkout, '.fixture-codex', file), 'utf8')) as Record<string, number>));
    const sum = (key: string) => counters.reduce((total, counter) => total + (counter[key] ?? 0), 0);
    assert.equal(sum('choices'), 1); assert.equal(sum('workerSpawns'), 1); assert(sum('turnStarts') >= 4);
    assert.equal(await readFile(join(environment.checkout, 'fixture-provider-marker.txt'), 'utf8').then(text => text.split(':')[0]), environment.instanceId);
    return { sessionId, assistantReplies: events().filter(e => e.type === 'item.upsert' && e.item.kind === 'assistant').length, workerResults: 1, dispatches: sum('turnStarts'), choices: sum('choices'), workerSpawns: sum('workerSpawns'), detailItemUpdates: events().filter(e => e.type === 'item.upsert').length };
  } finally { rpc.close(); }
}
