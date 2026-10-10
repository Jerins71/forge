import { afterEach, describe, expect, it } from 'vitest';
import { createShellStream } from './shell-stream.js';
import { createDetailStream } from './detail-stream.js';
import { streamFixture, principal, session } from '../../ws/rpc/__tests__/fixtures.js';
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
const plan = { revision: 3, updatedAt: '2026-10-09T00:00:00.000Z', plan: [{ id: 'step', step: 'Verify', status: 'in_progress' as const }] };
const goal = { revision: 2, measuredAt: '2026-10-09T00:00:00.000Z', goal: null };
const recovery = { recoveryId: 'boot', bootId: 'boot', createdAt: '2026-10-09T00:00:00.000Z', interruptedManagers: ['session'], interruptedWorkers: [], undeliveredReports: [] };
// Failure cases: fresh clients miss persisted features; shell-only recovery is
// invisible to mounted detail; replay differs from live; snapshot pruning drops state.
describe('durable typed detail features', () => {
  it.each(['plan', 'goal'] as const)('hydrates %s on fresh detail and reconnect', async family => {
    const f = await streamFixture(); closes.push(f.close);
    f.sink.transaction(tx => {
      f.sink.append(tx, { topic: 'shell', sessionId: 'session', event: { type: 'session.upsert', session: session() } });
      f.sink.append(tx, { topic: 'detail', sessionId: 'session', event: family === 'plan' ? { type: 'plan.upsert', snapshot: plan } : { type: 'goal.upsert', snapshot: goal } });
    });
    for (let i = 0; i < 2; i++) {
      const abort = new AbortController(); const stream = f.detailStream.detail(principal, { sessionId: 'session' }, abort.signal)[Symbol.asyncIterator]();
      const first = (await stream.next()).value;
      expect(first).toMatchObject({ kind: 'snapshot', snapshot: { [family]: family === 'plan' ? plan : goal } });
      abort.abort(); await stream.return?.();
    }
  });
  it('gives fresh shell and detail clients recovery and replays its global change', async () => {
    const f = await streamFixture(); closes.push(f.close);
    f.sink.transaction(tx => f.sink.append(tx, { topic: 'shell', sessionId: 'session', event: { type: 'session.upsert', session: session() } }));
    const deps = { ...f.deps, recovery: () => recovery };
    const shellAbort = new AbortController(); const shell = createShellStream(deps).shell(principal, {}, shellAbort.signal)[Symbol.asyncIterator]();
    expect((await shell.next()).value).toMatchObject({ kind: "snapshot", snapshot: { recovery } });
    shellAbort.abort(); await shell.return?.();
    const abort = new AbortController(); const stream = createDetailStream(deps).detail(principal, { sessionId: 'session' }, abort.signal)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({ kind: 'snapshot', snapshot: { recovery } });
    const sync = (await stream.next()).value!; const cursor = { streamEpoch: sync.streamEpoch, afterSequence: sync.sequence };
    f.sink.transaction(tx => f.sink.append(tx, { topic: 'shell', sessionId: null, event: { type: 'recovery.upsert', recovery: null } }));
    expect((await stream.next()).value).toMatchObject({ kind: 'event', event: { type: 'recovery.upsert', recovery: null } });
    abort.abort(); await stream.return?.();
    const replayAbort = new AbortController(); const replay = createDetailStream(deps).detail(principal, { sessionId: 'session', cursor }, replayAbort.signal)[Symbol.asyncIterator]();
    expect((await replay.next()).value).toMatchObject({ kind: 'event', event: { type: 'recovery.upsert', recovery: null } });
    replayAbort.abort(); await replay.return?.();
  });
});
