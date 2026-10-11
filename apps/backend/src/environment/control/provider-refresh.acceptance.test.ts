import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createControlCore } from './database.js';
import { createCoreLineagePort } from './orchestration/lineage-tool-port.js';
import { loadState } from './orchestration/store.js';
import type { ControlCoreOptions } from './effect-types.js';
import type { AgentDescriptor, ConversationEntryEvent } from '../../swarm/types.js';
import type { ProviderAdapter, ProviderBinding } from '../../swarm/runtime/provider-contract.js';
import { CodexProviderAdapter } from '../../swarm/runtime/codex/codex-provider-adapter.js';
import { ClaudeProviderAdapter } from '../../swarm/runtime/claude/claude-provider-adapter.js';
import { SwarmAgentLifecycleService } from '../../swarm/swarm-agent-lifecycle-service.js';

// Changed credentials replace a thread's provider binding through the settings transfer. Ways this can fail:
//  - an idle thread keeps its binding, so the next turn runs on the old provider process;
//  - the old binding is closed while the core still dispatches to it, so the next turn fails;
//  - a working thread is drained, interrupting its turn;
//  - a working thread's refresh is forgotten once its turn ends;
//  - the replacement binding starts a new native conversation instead of resuming the same one;
//  - input sent after the refresh is lost instead of running on the replacement.
async function fixture(model: AgentDescriptor['model'], capabilities: ProviderBinding['capabilities']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-provider-refresh-'));
  const now = Date.now();
  const entries: ConversationEntryEvent[] = [];
  const starts: Array<{ runId: string; bindingId: string; conversation: string }> = [];
  const acquired: ProviderBinding[] = [];
  const closed: string[] = [];
  const adapter: ProviderAdapter = {
    capabilities: () => capabilities,
    open: async () => { throw new Error('Acquisition supplies the binding'); },
    resume: async () => { throw new Error('Acquisition supplies the binding'); },
    start: async input => {
      if (closed.includes(input.binding.scope.bindingId)) throw new Error('Dispatched to a closed binding');
      starts.push({ runId: input.runId, bindingId: input.binding.scope.bindingId, conversation: input.binding.conversation.nativeId });
      return { status: 'accepted', turn: { ...input.binding.scope, kind: 'turn', conversationId: input.binding.conversation.nativeId, nativeId: input.runId } };
    },
    steer: async () => { throw new Error('Unused'); },
    interrupt: async () => {}, respond: async () => {}, compact: async () => {},
    async *observations() {}, close: async binding => { closed.push(binding.scope.bindingId); }, drain: async () => ({ status: 'clean' }),
  };
  const options: ControlCoreOptions = {
    databasePath: path.join(root, 'control.sqlite'), dataDir: root, clock: () => now, random: randomUUID, isDeviceRevoked: () => false,
    artifacts: { validateInput: () => [], pinInput: () => {} },
    workspace: { prepareLaunch: async () => { throw new Error('Unused'); }, isLaunchCurrent: () => true, ensure: async () => ({ cwd: root, branch: null }), reconcile: async () => 'retry' },
    swarm: {
      ensureSession: async () => ({ materialized: true }),
      stopSession: async () => ({ stopped: true }),
      readTransferEntries: async () => entries,
      acquireProvider: async (scope, conversation) => {
        const binding: ProviderBinding = { scope, conversation: { ...conversation, ...scope, kind: 'conversation', nativeId: conversation?.nativeId ?? 'native-source' }, capabilities, model, instructionRevision: 'fixture', toolContractRevision: 'fixture' };
        acquired.push(binding);
        return { adapter, binding };
      },
      applyInput: async input => {
        const entryId = `input-${input.runId}`;
        entries.push({ type: 'conversation_message', agentId: 'source', id: entryId, timelineEntryId: entryId, turnId: input.runId, text: input.message.text, role: 'user', source: 'user_input', timestamp: new Date(now).toISOString() });
        return { entryId, runtimeMessage: { text: input.message.text } };
      },
      applyChoice: async () => 'answered',
    },
  };
  const core = await createControlCore(options);
  await core.reconcileOnBoot();
  const descriptor = { agentId: 'source', role: 'manager', profileId: 'project', model } as AgentDescriptor;
  const summary = { sessionId: 'source', projectId: 'project', title: 'Source', status: 'idle', attention: 'none', unread: 0, workerCount: 0, updatedAt: new Date(now).toISOString(), sortKey: 'source', archived: false, workspace: { kind: 'current_checkout', cwd: root, branch: null }, model: { ...model, origin: 'session_override' } };
  core.database.prepare("INSERT INTO control_sessions(session_id,project_id,desired_state,summary_json,updated_sequence) VALUES ('source','project','running',?,0)").run(JSON.stringify(summary));
  core.controlService.record({ type: 'thread.create', commandId: randomUUID(), now, threadId: 'source', role: 'manager', projectId: 'project', model });
  const port = createCoreLineagePort(core.eventSink, core.controlService, { getAgent: () => descriptor, readEntries: async () => entries, clock: () => now, random: randomUUID });
  const send = async (text: string) => { const run = await core.controlService.submitInput({ commandId: randomUUID(), threadId: 'source', message: { text, artifactIds: [] } }); await core.effectWorker.drain(); return run.runId; };
  const complete = (runId: string) => {
    const state = loadState(core.database); const attempt = state.attempts[state.runs[runId].activeAttemptId]; const binding = state.bindings[attempt.bindingId];
    core.controlService.record({ type: 'provider.observe', commandId: randomUUID(), now, observation: { type: 'terminal', scope: binding.scope, attemptId: attempt.attemptId, sequence: 1, origin: { kind: 'root', conversation: binding.conversation }, terminalAuthority: 'root_attempt', outcome: 'completed' } });
  };
  const thread = () => loadState(core.database).threads.source;
  // The deferred refresh reads history before recording its transfer.
  const settle = async () => { for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve)); await core.effectWorker.drain(); };
  return { core, port, descriptor, send, complete, thread, settle, starts, acquired, closed, close: async () => { await core.close(); await rm(root, { recursive: true, force: true }); } };
}
const codex = { provider: 'codex-native', modelId: 'gpt-6-sol', thinkingLevel: 'low' };

it('replaces an idle thread\'s binding and resumes the same conversation on the next turn', async () => {
  const f = await fixture(codex, new CodexProviderAdapter({} as never).capabilities());
  try {
    f.complete(await f.send('Before the credentials change'));
    const before = f.thread();
    await f.port.refreshContext('source');
    await f.settle();
    expect(f.closed).toEqual([before.bindingId]);
    expect(f.thread()).toMatchObject({ desired: 'running', shutdown: 'clean', model: codex });
    expect(f.thread().generation).toBeGreaterThan(before.generation);
    const next = await f.send('After the credentials change');
    expect(f.starts.map(start => start.runId)).toEqual([expect.any(String), next]);
    expect(f.starts[1]!.bindingId).not.toBe(before.bindingId);
    expect(f.acquired).toHaveLength(2);
    expect(f.acquired[1]!.conversation.nativeId).toBe(f.acquired[0]!.conversation.nativeId);
    expect(loadState(f.core.database).runs[next].state).toBe('running');
  } finally { await f.close(); }
});

it('leaves a working thread alone and replaces its binding once the turn ends', async () => {
  const f = await fixture(codex, new CodexProviderAdapter({} as never).capabilities());
  try {
    const running = await f.send('Working while the credentials change');
    const before = f.thread();
    await f.port.refreshContext('source');
    await f.settle();
    expect(f.closed).toEqual([]);
    expect(f.thread()).toMatchObject({ shutdown: 'clean', generation: before.generation, bindingId: before.bindingId, activeRunId: running });
    f.complete(running);
    await f.settle();
    expect(f.closed).toEqual([before.bindingId]);
    expect(f.thread()).toMatchObject({ desired: 'running', shutdown: 'clean' });
    expect(f.thread().generation).toBeGreaterThan(before.generation);
    const next = await f.send('After the turn ended');
    expect(f.starts.at(-1)).toMatchObject({ runId: next, conversation: f.acquired[0]!.conversation.nativeId });
    expect(f.starts.at(-1)!.bindingId).not.toBe(before.bindingId);
    // Asking again with nothing live records nothing more.
    f.complete(next);
    await f.port.refreshContext('source'); await f.port.refreshContext('source');
    await f.settle();
    expect(f.closed).toHaveLength(2);
  } finally { await f.close(); }
});

it('sends Claude "Switch account" through the same binding replacement, never a runtime recycle', async () => {
  const claude = { provider: 'claude-native', modelId: 'claude-sonnet-5', thinkingLevel: 'high' };
  const f = await fixture(claude, new ClaudeProviderAdapter({} as never).capabilities());
  try {
    f.complete(await f.send('Before switching account'));
    const before = f.thread();
    const recycled: string[] = [];
    const runtime = { getStatus: () => 'idle', getPendingCount: () => 0, recycle: async () => { recycled.push('recycle'); }, shutdownForReplacement: async () => { recycled.push('shutdown'); } };
    const other = { agentId: 'other', role: 'manager', profileId: 'project', status: 'idle', model: codex } as AgentDescriptor;
    const lifecycle = new SwarmAgentLifecycleService({
      descriptors: new Map([['source', { ...f.descriptor, status: 'idle' } as AgentDescriptor], ['other', other]]), runtimes: new Map([['source', runtime], ['other', runtime]]),
      runtimeRecoveryState: { hasPendingManagerRuntimeRecycle: () => false, getPendingManagerRuntimeRecycleReason: () => undefined, setPendingManagerRuntimeRecycle: () => { recycled.push('deferred'); }, clearPendingManagerRuntimeRecycle: () => {} },
    } as unknown as ConstructorParameters<typeof SwarmAgentLifecycleService>[0]);
    lifecycle.installCoreProviderRefresh(agentId => f.port.refreshContext(agentId));
    // ClaudeAuthService calls this once the new login is verified.
    await lifecycle.notifyNativeAuthChanged('claude-native');
    await f.settle();
    expect(recycled).toEqual([]);
    expect(f.closed).toEqual([before.bindingId]);
    const next = await f.send('After switching account');
    expect(f.starts.at(-1)).toMatchObject({ runId: next, conversation: f.acquired[0]!.conversation.nativeId });
    expect(f.acquired).toHaveLength(2);
  } finally { await f.close(); }
});
