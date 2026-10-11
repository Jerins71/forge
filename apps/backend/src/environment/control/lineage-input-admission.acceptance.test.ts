import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createControlCore } from './database.js';
import { createProjectPolicy } from './project-policy.js';
import { loadState } from './orchestration/store.js';
import { resolveSourcePoint } from './orchestration/transfers.js';
import type { ControlCoreOptions } from './effect-types.js';
import type { SwarmManager } from '../../swarm/swarm-manager.js';
import type { ConversationEntryEvent } from '../../swarm/types.js';
import type { ProviderAdapter, ProviderBinding } from '../../swarm/runtime/provider-contract.js';
import { CodexProviderAdapter } from '../../swarm/runtime/codex/codex-provider-adapter.js';

it('admits and queues an immediate send after the configure receipt while the settings handoff is draining', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-lineage-admission-'));
  const now = Date.now();
  const model = { provider: 'codex-native', modelId: 'gpt-6-sol', thinkingLevel: 'low' };
  const capabilities = new CodexProviderAdapter({} as never).capabilities();
  const entries: ConversationEntryEvent[] = [];
  const starts: string[] = [];
  let release!: () => void;
  const shutdown = new Promise<void>(resolve => { release = resolve; });
  const adapter: ProviderAdapter = {
    capabilities: () => capabilities,
    open: async () => { throw new Error('Acquisition supplies the binding'); },
    resume: async () => { throw new Error('Acquisition supplies the binding'); },
    start: async input => {
      starts.push(input.runId);
      return { status: 'accepted', turn: { ...input.binding.scope, kind: 'turn', conversationId: input.binding.conversation.nativeId, nativeId: input.runId } };
    },
    steer: async () => { throw new Error('Unused'); },
    interrupt: async () => {}, respond: async () => {}, compact: async () => {},
    async *observations() {}, close: async () => {}, drain: async () => ({ status: 'clean' }),
  };
  const options: ControlCoreOptions = {
    databasePath: path.join(root, 'control.sqlite'), dataDir: root, clock: () => now, random: randomUUID, isDeviceRevoked: () => false,
    artifacts: { validateInput: () => [], pinInput: () => {} },
    workspace: { prepareLaunch: async () => { throw new Error('Unused'); }, isLaunchCurrent: () => true, ensure: async () => ({ cwd: root, branch: null }), reconcile: async () => 'retry' },
    swarm: {
      ensureSession: async () => ({ materialized: true }),
      stopSession: async () => { await shutdown; return { stopped: true }; },
      readTransferEntries: async () => entries,
      acquireProvider: async (scope, conversation) => {
        const binding: ProviderBinding = { scope, conversation: { ...conversation, ...scope, kind: 'conversation', nativeId: conversation?.nativeId ?? 'native-source' }, capabilities, model, instructionRevision: 'fixture', toolContractRevision: 'fixture' };
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
  try {
    await core.reconcileOnBoot();
    const summary = { sessionId: 'source', projectId: 'project', title: 'Source', status: 'idle', attention: 'none', unread: 0, workerCount: 0, updatedAt: new Date(now).toISOString(), sortKey: 'source', archived: false, workspace: { kind: 'current_checkout', cwd: root, branch: null }, model: { ...model, origin: 'session_override' } };
    core.database.prepare("INSERT INTO control_sessions(session_id,project_id,desired_state,summary_json,updated_sequence) VALUES ('source','project','running',?,0)").run(JSON.stringify(summary));
    core.controlService.record({ type: 'thread.create', commandId: randomUUID(), now, threadId: 'source', role: 'manager', projectId: 'project', model });
    const first = await core.controlService.submitInput({ commandId: randomUUID(), threadId: 'source', message: { text: 'Before configure', artifactIds: [] } });
    await core.effectWorker.drain();
    const state = loadState(core.database); const attempt = state.attempts[state.runs[first.runId].activeAttemptId];
    core.controlService.record({ type: 'provider.observe', commandId: randomUUID(), now, observation: { type: 'terminal', scope: state.bindings[attempt.bindingId].scope, attemptId: attempt.attemptId, sequence: 1, origin: { kind: 'root', conversation: state.bindings[attempt.bindingId].conversation }, terminalAuthority: 'root_attempt', outcome: 'completed' } });
    const swarm = {
      getAgent: () => ({ agentId: 'source', role: 'manager', profileId: 'project', model }), listProfiles: () => [{ profileId: 'project', defaultModel: model }],
      getManagerSelectionCatalog: async () => ({ models: [{ ...model, defaultReasoningId: 'high', reasoningOptions: [{ id: 'high' }], surfaces: { change: { selectable: true } } }] }),
      updateSessionExactModel: async () => core.controlService.record({ type: 'transfer.create', commandId: randomUUID(), now, transferId: 'settings-transfer', kind: 'provider_switch', source: resolveSourcePoint(loadState(core.database), 'source', { kind: 'latest_stable' }, entries), targetThreadId: 'source', targetModel: { ...model, thinkingLevel: 'high' }, authorized: true }),
    } as unknown as SwarmManager;
    options.policy = createProjectPolicy(swarm);
    const principal = { deviceSessionId: 'ui', scopes: new Set(['session:operate'] as const) };
    const configured = await core.controlService.execute(principal, 'session.configure', { commandId: randomUUID(), sessionId: 'source', model: { mode: 'override', ...model, thinkingLevel: 'high' } });
    expect(configured.state).toBe('succeeded'); expect(loadState(core.database).threads.source.shutdown).toBe('pending');
    const commandId = randomUUID();
    const sent = await core.controlService.execute(principal, 'session.send', { commandId, sessionId: 'source', message: { text: 'Immediately after configure', artifactIds: [] } });
    expect(sent.state).toBe('accepted'); expect(loadState(core.database).runs[`run-${commandId}`].state).toBe('queued'); expect(starts).toEqual([first.runId]);
    release(); await core.effectWorker.drain();
    expect(starts).toEqual([first.runId, `run-${commandId}`]);
    expect(loadState(core.database).threads.source.shutdown).toBe('clean');
    expect(loadState(core.database).runs[`run-${commandId}`].state).toBe('running');
  } finally { release(); await core.close(); await rm(root, { recursive: true, force: true }); }
});
