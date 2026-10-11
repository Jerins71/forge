import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { getProfileUnreadStatePath } from '../../swarm/storage/data-paths.js';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { makeTempConfig, TestSwarmManager } from '../../test-support/index.js';
import { createTestEnvironment } from '../../test-support/environment-auth.js';
import { loadState } from '../../environment/control/orchestration/store.js';
import type { UnreadTracker } from '../../swarm/session/unread-tracker.js';
import type { EnvironmentService } from '../../environment/environment-service.js';
import { createShellStream } from '../../environment/streams/shell-stream.js';

// Failure scenarios: same-named foreign sessions mutate; lost ack repeats a rename;
// restart loses sidebar/message pins or unread; a mixed stale dismissal clears a
// newer occurrence; inventory-only clients mark read; failed controls look successful.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const config = await makeTempConfig({ prefix: 'v2-session-state-', omitSharedAuthFile: true, omitSharedSecretsFile: true });
  let manager: TestSwarmManager;
  let unread: UnreadTracker;
  let environment: EnvironmentService;
  async function open() {
    manager = new TestSwarmManager(config);
    manager.onCreateRuntime = ({ runtime }) => {
      const native = (runtime as unknown as { sessionManager: SessionManager }).sessionManager;
      native.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'fixture ready' }] } as never);
    };
    ({ environment, unreadTracker: unread } = await createTestEnvironment(manager, { boot: true }));
    const managerId = config.managerId ?? 'manager';
    if (!manager.getAgent(managerId)) {
      await manager.createManager(managerId, { name: config.managerDisplayName ?? 'Manager', cwd: config.defaultCwd });
    }
    environment.start();
    await vi.waitFor(() => {
      expect(Object.values(loadState(environment.database).runs).every(run => run.state === 'terminal')).toBe(true);
      expect(environment.database.prepare("SELECT effect_id FROM effects WHERE state IN ('pending','claimed')").all()).toEqual([]);
    });
  }
  async function stop() {
    for (const agent of manager.listAgents().filter(a => a.role === 'manager')) await manager.stopSession(agent.agentId);
    await unread.flush(); await environment.stop(); await manager.disposeHistoryRecall();
  }
  await open();
  cleanup.push(async () => { await stop(); await rm(config.paths.dataDir, { recursive: true, force: true }); });
  const principal = environment!.access.ensureIntegrationPrincipal({ integration: 'cli', credentialId: 'fixture', label: 'Fixture', scopes: ['session:operate', 'session:read'] });
  const rpc = async () => {
    const { createSessionStateRpc } = await import('./session-state-rpc.js');
    return createSessionStateRpc({ swarmManager: manager, control: environment.control, unreadTracker: unread });
  };
  const shell = async () => {
    const stream = createShellStream({ database: environment.database, getDescriptor: () => environment.descriptor(), subscribeCommitted: () => () => {}, withReadBarrier: fn => fn() });
    const controller = new AbortController(); const iterator = stream.shell(principal, {}, controller.signal)[Symbol.asyncIterator]();
    try { const first = await iterator.next(); if (first.value?.kind !== 'snapshot') throw new Error('Missing shell'); return first.value.snapshot; }
    finally { controller.abort(); await iterator.return?.(); }
  };
  return { config, principal, rpc, shell, get manager() { return manager; }, get unread() { return unread; }, get environment() { return environment; }, restart: async () => { await stop(); await open(); } };
}
it('isolates addressed controls and persists pins, unread and exact receipt identity through restart', async () => {
  const a = await fixture(), b = await fixture(); const rpc = await b.rpc(); const beforeA = a.manager.getAgent('manager');
  const rename = vi.spyOn(b.manager, 'renameSession');
  const input = { commandId: randomUUID(), sessionId: 'manager', title: 'B only', pinned: true };
  const first = await rpc.execute(b.principal, 'session.update', input);
  expect(await rpc.execute(b.principal, 'session.update', input)).toEqual(first);
  expect(rename).toHaveBeenCalledTimes(1);
  await rpc.execute(b.principal, 'session.readState.set', { commandId: randomUUID(), sessionId: 'manager', read: false });
  expect(a.manager.getAgent('manager')).toEqual(beforeA); expect(a.unread.getCount('manager', 'manager')).toBe(0);
  const before = (await b.shell()).sessions.find(s => s.sessionId === 'manager')!;
  expect(before).toMatchObject({ title: 'B only', pinnedAt: expect.any(String), unread: 1 });
  await b.restart();
  const after = (await b.shell()).sessions.find(s => s.sessionId === 'manager')!;
  expect(after).toMatchObject({ title: before.title, pinnedAt: before.pinnedAt, unread: before.unread, sortKey: before.sortKey });
  expect(await (await b.rpc()).execute(b.principal, 'session.update', input)).toEqual(first);
  await expect((await b.rpc()).execute(b.principal, 'session.update', { ...input, title: 'conflict' })).rejects.toMatchObject({ code: 'CONFLICT' });
});
it('preserves shell-only unread and clears only the explicitly addressed project', async () => {
  const f = await fixture(), rpc = await f.rpc();
  await rpc.execute(f.principal, 'session.readState.set', { commandId: randomUUID(), sessionId: 'manager', read: false });
  expect((await f.shell()).sessions.find(s => s.sessionId === 'manager')?.unread).toBe(1);
  expect((await f.shell()).sessions.find(s => s.sessionId === 'manager')?.unread).toBe(1);
  await expect(rpc.execute(f.principal, 'project.readState.clear', { commandId: randomUUID(), projectId: 'foreign' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await rpc.execute(f.principal, 'project.readState.clear', { commandId: randomUUID(), projectId: 'manager' });
  expect((await f.shell()).sessions.find(s => s.sessionId === 'manager')?.unread).toBe(0);
});
it('validates every occurrence and refuses stale mixed batches before dismissal', async () => {
  const f = await fixture(), rpc = await f.rpc();
  const newer = { attentionId: 'new', sessionAgentId: 'manager', profileId: 'manager', reason: 'work_settled' as const, raisedAt: new Date().toISOString() };
  vi.spyOn(f.manager, 'getSessionAttentionSnapshot').mockReturnValue({ type: 'session_attention_snapshot', revision: 2, attentions: [newer] });
  const dismiss = vi.spyOn(f.manager, 'dismissSessionAttention').mockResolvedValue({ revision: 3, changes: [{ sessionAgentId: 'manager', attention: null }] });
  await expect(rpc.execute(f.principal, 'session.attention.dismiss', { commandId: randomUUID(), occurrenceIds: ['new', 'old'] })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(dismiss).not.toHaveBeenCalled();
  const input = { commandId: randomUUID(), occurrenceIds: ['new'] };
  await rpc.execute(f.principal, 'session.attention.dismiss', input); await rpc.execute(f.principal, 'session.attention.dismiss', input);
  expect(dismiss).toHaveBeenCalledTimes(1);
});
it('fails closed on foreign pin targets and missing mutation scope', async () => {
  const f = await fixture(), rpc = await f.rpc();
  await expect(rpc.execute(f.principal, 'session.message.pin', { commandId: randomUUID(), sessionId: 'foreign', itemId: 'item', pinned: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(rpc.execute({ ...f.principal, scopes: new Set(['session:read']) }, 'session.update', { commandId: randomUUID(), sessionId: 'manager', pinned: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('projects canonical message pins live and on restart, then clears the exact item identity', async () => {
  const f = await fixture();
  const { event: entry } = await f.manager.appendConversationUserMessage('Pinnable fixture', { targetAgentId: 'manager' });
  const canonicalId = entry.timelineEntryId ?? entry.id!;
  const rpc = await f.rpc();
  const input = { commandId: randomUUID(), sessionId: 'manager', itemId: canonicalId, pinned: true };
  expect(await rpc.execute(f.principal, 'session.message.pin', input)).toMatchObject({ state: 'succeeded' });
  expect(f.manager.getPinnedMessageIds('manager')?.has(entry.id)).toBe(true);
  await f.restart();
  expect(f.manager.getPinnedMessageIds('manager')?.has(entry.id)).toBe(true);
  const next = await f.rpc();
  await next.execute(f.principal, 'session.pins.clear', { commandId: randomUUID(), sessionId: 'manager' });
  expect(f.manager.getPinnedMessageIds('manager')?.size ?? 0).toBe(0);
});

it('does not acknowledge an unread mutation whose durable write failed', async () => {
  const f = await fixture(), rpc = await f.rpc();
  const path = getProfileUnreadStatePath(f.config.paths.dataDir, 'manager');
  await mkdir(path, { recursive: true });
  try {
    expect(await rpc.execute(f.principal, 'session.readState.set', { commandId: randomUUID(), sessionId: 'manager', read: false })).toMatchObject({ state: 'interrupted' });
  } finally { await rm(path, { recursive: true, force: true }); }
});
