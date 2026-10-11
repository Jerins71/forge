import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { DetailFeatureStreamItemSchema } from '@forge/protocol/environment-v2';
import type { SwarmManager } from '../../swarm/swarm-manager.js';
import { CodexElicitationBroker } from '../../swarm/codex-app-server/codex-elicitation-broker.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAgentHttpRoutes } from '../http/routes/agent-http-routes.js';
import { bindHttpPrincipal } from './http-principal.js';
import { streamFixture, principal, session } from './__tests__/fixtures.js';

// Failure cases: duplicate/lost acknowledgements repeat compaction or recovery;
// stale elicitation resumes a dead Promise; form values enter the command/event
// journal; shared terminal scope is routed to one session; released leases leak.
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
const commandId = '00000000-0000-4000-8000-000000000001';
const recovery = { recoveryId: randomUUID(), bootId: 'boot', createdAt: '2026-10-09T00:00:00.000Z', interruptedManagers: ['session'], interruptedWorkers: [], undeliveredReports: [] };
async function fixture() {
  const streams = await streamFixture(); closes.push(streams.close);
  streams.sink.transaction(tx => streams.sink.append(tx, { topic: 'shell', sessionId: 'session', event: { type: 'session.upsert', session: session() } }));
  const swarm = {
    getAgent: () => ({ agentId: 'session', role: 'manager', profileId: 'project' }), listProfiles: () => [],
    getRestartRecoverySnapshot: () => recovery,
    resumeRestartRecovery: vi.fn(async () => ({ ...recovery, resumedAt: recovery.createdAt })), dismissRestartRecovery: vi.fn(async () => ({ ...recovery, dismissedAt: recovery.createdAt })),
    emit: vi.fn(),
    controlSessionGoal: vi.fn(async () => ({ revision: 1, goal: null })),
    compactAgentContext: vi.fn(async () => undefined), smartCompactAgentContext: vi.fn(async () => ({ compacted: true })),
    getPendingCodexElicitationsForManager: () => [{ elicitationId: 'pending', managerAgentId: 'session', sidecarAgentId: 'sidecar', threadId: 'thread', turnId: 'turn' }],
    respondToCodexElicitation: vi.fn(() => true),
  };
  const { createDetailFeatureRpc } = await import('./detail-feature-rpc.js');
  const rpc = createDetailFeatureRpc({ swarmManager: swarm as unknown as SwarmManager, control: streams.core.controlService });
  return { ...streams, swarm, rpc };
}
describe('detail control acceptance', () => {
  it('publishes environment recovery without selecting a session and deduplicates decisions', async () => {
    const f = await fixture();
    expect(await f.rpc.execute(principal, 'recovery.get', {})).toEqual({ recovery });
    const input = { commandId, recoveryId: recovery.recoveryId, action: 'resume' };
    const a = await f.rpc.execute(principal, 'recovery.decide', input);
    const b = await f.rpc.execute(principal, 'recovery.decide', input);
    expect(a).toEqual(b); expect(a).toMatchObject({ method: 'recovery.decide', state: 'succeeded', sessionId: null });
    expect(f.swarm.resumeRestartRecovery).toHaveBeenCalledTimes(1);
    expect(f.swarm.emit).toHaveBeenCalledExactlyOnceWith('restart_recovery_snapshot', { type: 'restart_recovery_snapshot', snapshot: { ...recovery, resumedAt: recovery.createdAt } });
    await expect(f.rpc.execute(principal, 'recovery.decide', { ...input, recoveryId: 'old' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('moves goal control into the existing receipt admission owner', async () => {
    const f = await fixture(); const input = { commandId, sessionId: 'session', action: 'pause' };
    expect(await f.rpc.execute(principal, 'session.goal.control', input)).toMatchObject({ state: 'succeeded', sessionId: 'session' });
    await f.rpc.execute(principal, 'session.goal.control', input);
    expect(f.swarm.controlSessionGoal).toHaveBeenCalledTimes(1);
  });
  it('invokes compaction once and exposes unknown on ambiguous handoff', async () => {
    const f = await fixture(); f.swarm.compactAgentContext.mockRejectedValue(new Error('provider lost'));
    const input = { commandId, sessionId: 'session', mode: 'manual' };
    expect(await f.rpc.execute(principal, 'session.compact', input)).toMatchObject({ state: 'interrupted', delivery: 'unknown' });
    expect(await f.rpc.execute(principal, 'session.compact', input)).toMatchObject({ state: 'interrupted', delivery: 'unknown' });
    expect(f.swarm.compactAgentContext).toHaveBeenCalledTimes(1);
  });
  it('routes HTTP compaction through the same receipt owner and preserves admission statuses', async () => {
    const f = await fixture();
    const routes = createAgentHttpRoutes({ swarmManager: f.swarm as unknown as SwarmManager, control: f.core.controlService });
    const server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://fixture.invalid');
      bindHttpPrincipal(request, principal);
      void routes.find(route => route.methods === request.method && route.matches(url.pathname))!.handle(request, response, url);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    closes.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const compact = (target: string) => fetch(`${base}/api/agents/${target}/compact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId }) });
    expect((await compact('missing')).status).toBe(404);
    for (let i = 0; i < 2; i++) {
      const response = await compact('session'); expect(response.status).toBe(200);
      expect((await response.json()).receipt).toMatchObject({ method: 'session.compact', commandId, state: 'succeeded' });
    }
    expect(f.swarm.compactAgentContext).toHaveBeenCalledTimes(1);
  });
  it('scope checks and generation fences nonpersistent elicitation responses', async () => {
    const f = await fixture(); const input = { sessionId: 'session', elicitationId: 'pending', generation: 'pending', decision: 'allow', values: { password: 'SYNTHETIC_PRIVATE_VALUE' } };
    await f.rpc.execute(principal, 'session.elicitation.respond', input);
    expect(f.swarm.respondToCodexElicitation).toHaveBeenCalledTimes(1);
    await expect(f.rpc.execute(principal, 'session.elicitation.respond', { ...input, generation: 'old' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(f.rpc.execute({ ...principal, scopes: new Set(['session:read']) }, 'session.elicitation.respond', input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const records = f.database.prepare('SELECT normalized_json FROM commands UNION ALL SELECT payload_json FROM events UNION ALL SELECT receipt_json FROM command_receipts').all();
    expect(JSON.stringify(records)).not.toContain('SYNTHETIC_PRIVATE_VALUE');
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM commands').get()).toEqual({ count: 0 });
  });
  it('keeps full elicitation URLs behind an authorized nonpersistent read until resolution', async () => {
    const f = await fixture(); const emitted: unknown[] = [];
    const broker = new CodexElicitationBroker({ emit: event => emitted.push(event), dismiss: () => {}, logDebug: () => {} });
    const url = 'https://fixture.invalid/authorize?credential=synthetic-private';
    const pending = broker.request({ params: { threadId: 'thread', turnId: 'turn', mode: 'url', message: 'Authenticate', url },
      active: { managerAgentId: 'session', sidecarAgentId: 'sidecar', threadId: 'thread', turnId: 'turn' } });
    const request = broker.getPendingForManager('session')[0]!;
    expect(JSON.stringify(emitted)).not.toContain('synthetic-private');
    expect(emitted[0]).toMatchObject({ urlOrigin: 'https://fixture.invalid' });
    Object.assign(f.swarm, { getCodexElicitationUrl: (input: Parameters<CodexElicitationBroker['readUrl']>[0]) => broker.readUrl(input) });
    const input = { sessionId: 'session', elicitationId: request.elicitationId, generation: request.elicitationId };
    expect(await f.rpc.execute(principal, 'session.elicitation.url', input)).toEqual({ url });
    await expect(f.rpc.execute({ ...principal, scopes: new Set(['session:read']) }, 'session.elicitation.url', input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.rpc.execute(principal, 'session.elicitation.url', { ...input, generation: 'stale' })).rejects.toMatchObject({ code: 'CONFLICT' });
    broker.respond({ managerAgentId: 'session', elicitationId: request.elicitationId, decision: 'cancel' }); await pending;
    await expect(f.rpc.execute(principal, 'session.elicitation.url', input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(JSON.stringify(f.database.prepare('SELECT normalized_json FROM commands UNION ALL SELECT payload_json FROM events').all())).not.toContain('synthetic-private');
  });
  it.each(['manager_tool_activity','secure_session_snapshot','generation_throughput_snapshot','terminals_snapshot','codex_elicitation_request'])(
    'moves %s to a bounded typed ephemeral projection', async type => {
      const { projectDetailFeature } = await import('./detail-feature-rpc.js');
      const events: Record<string, unknown> = {
        manager_tool_activity: { type, sessionAgentId: 'session', revision: 1, toolCount: 1 },
        secure_session_snapshot: { type, sessionAgentId: 'session', profileId: 'project', principalKind: 'manager', ownerManagerAgentId: null, workerAssignmentId: null, revision: 1, executionMode: 'secure', environmentStatus: 'ready', leases: [], pendingRequests: [], updatedAt: '2026-10-09T00:00:00.000Z', secret: 'DROP' },
        generation_throughput_snapshot: { type, sessionAgentId: 'session', measurements: [], sessionSummary: { sessionAgentId: 'session', window: 'last_20_terminal_generations', measuredGenerationCount: 0, weightedTokensPerSecond: null, samples: [] } },
        terminals_snapshot: { type, sessionAgentId: 'project', terminals: [] },
        codex_elicitation_request: { type, elicitationId: 'pending', agentId: 'session', sidecarAgentId: 'sidecar', mode: 'url', message: 'Authenticate', persistScopes: [], url: 'https://fixture.invalid/private', urlOrigin: 'https://fixture.invalid' },
      };
      const event = projectDetailFeature(events[type]);
      expect(Value.Check(DetailFeatureStreamItemSchema, { event })).toBe(true);
      expect(JSON.stringify(event)).not.toContain('DROP'); expect(JSON.stringify(event)).not.toContain('/private');
    },
  );
});
