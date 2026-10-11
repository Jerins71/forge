import { readFileSync, writeFileSync, existsSync, openSync, fsyncSync, closeSync, promises as filePromises } from 'node:fs';
import { join } from 'node:path';
import { basename } from 'node:path';
import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import type { Database } from 'better-sqlite3';
import { loadConfiguredSqliteDatabaseConstructor } from '../../../apps/backend/src/sqlite-database-loader.js';
import { getEnvironmentDbPath, getSessionMetaPath } from '../../../apps/backend/src/swarm/storage/data-paths.js';
import { AgentDescriptorStore } from '../../../apps/backend/src/swarm/agents/agent-descriptor-store.js';
import { SwarmManager } from '../../../apps/backend/src/swarm/swarm-manager.js';
import { ConversationTimeline } from '../../../apps/backend/src/swarm/session/conversation-timeline.js';
import { RpcSendQueue } from '../../../apps/backend/src/ws/rpc/rpc-send-queue.js';
import { StreamQueue } from '../../../apps/backend/src/environment/streams/stream-budget.js';
import { TerminalService } from '../../../apps/backend/src/terminal/terminal-service.js';
import { SwarmWebSocketServer } from '../../../apps/backend/src/ws/server.js';
import { WebSocket } from './ws.js';
import type NativeSocket from 'ws';
import type { AgentDescriptor } from '../../../apps/backend/src/swarm/types.js';
import { projectDetailFeature } from '../../../apps/backend/src/ws/rpc/detail-feature-rpc.js';
import { loadState } from '../../../apps/backend/src/environment/control/orchestration/store.js';

export const crashBoundaries = ['pre-commit', 'post-commit', 'post-Git', 'post-meta', 'post-JSONL', 'post-dispatch-marker', 'post-provider-accept'] as const;
export type CrashBoundary = typeof crashBoundaries[number];
const recoveryBoundaries = ['result-canonical', 'result-dispatch', 'result-ack', 'stop-runtime'] as const;
type RecoveryBoundary = typeof recoveryBoundaries[number];
/** Instrument the real owners only inside the dedicated fixture child. No production endpoint or environment flag activates this code. */
export async function installHardeningHooks(dataDir: string, checkout: string) {
  const Constructor = await loadConfiguredSqliteDatabaseConstructor();
  const prototype = Constructor.prototype as Database;
  const databasePath = getEnvironmentDbPath(dataDir);
  const markerPath = join(checkout, '.fixture-crash.json');
  let armed: { commandId: string; boundary: CrashBoundary | RecoveryBoundary } | null = null;
  let controlDatabase: Database | undefined;
  let manager: SwarmManager | undefined;
  let terminalService: TerminalService | undefined;
  let webServer: SwarmWebSocketServer | undefined;
  const startWebServer = SwarmWebSocketServer.prototype.start;
  SwarmWebSocketServer.prototype.start = function () { webServer = this; return startWebServer.call(this); };
  let held: { commandId: string; reached: boolean; release: () => void; wait: Promise<void> } | undefined;
  const createTerminal = TerminalService.prototype.create;
  TerminalService.prototype.create = function (...args) { terminalService = this; return createTerminal.apply(this, args); };
  const terminalEvents: unknown[] = [];
  const terminalEmit = TerminalService.prototype.emit;
  TerminalService.prototype.emit = function (name, ...args) {
    if (name === 'terminal_created') { const event = args[0]; terminalEvents.push({ type: name, sessionAgentId: event.sessionAgentId, terminalSessionAgentId: event.terminal.sessionAgentId, listeners: this.listenerCount(name), valid: Boolean(projectDetailFeature(event)) }); }
    return terminalEmit.call(this, name, ...args);
  };
  let tick = 0;
  const timeline = new ConversationTimeline({ now: () => new Date().toISOString() });
  const overlay = new Map<string, AgentDescriptor>();
  const streams = new Set<NodeJS.Timeout>();
  const counters = { catalogSerializations: 0, transcriptHydrations: 0, gitScans: 0, hostResourceProbes: 0, applicationRxBytes: 0, applicationTxBytes: 0, streamQueueFramesMax: 0, streamQueueBytesMax: 0, sendQueueFramesMax: 0, sendQueueBytesMax: 0, injections: 0, agentsJsonControlWrites: 0 };
  // Count every filesystem mutation of the retired control file, including atomic rename/open.
  const agentsFile = join(dataDir, 'swarm', 'agents.json');
  const touchesAgents = (path: unknown) => String(path) === agentsFile;
  for (const name of ['writeFile', 'appendFile', 'rename', 'copyFile', 'open'] as const) {
    const owner = filePromises as unknown as Record<string, (...args: any[]) => any>;
    const original = owner[name]!;
    owner[name] = (...args: any[]) => {
      const target = name === 'rename' || name === 'copyFile' ? args[1] : args[0];
      if (touchesAgents(target) && (name !== 'open' || /[wa+]/.test(String(args[1])))) counters.agentsJsonControlWrites++;
      return original(...args);
    };
  }
  syncBuiltinESMExports();
  const sockets = new Set<WeakRef<NativeSocket>>();
  const knownSockets = new WeakSet<NativeSocket>();
  const subscriptions = new WeakMap<NativeSocket, Map<string, { method: string; sessionId?: string }>>();
  const requests = new WeakMap<NativeSocket, Map<string, { method: string; sessionId?: string }>>();
  const socketEmit = WebSocket.prototype.emit;
  WebSocket.prototype.emit = function (event, ...args) {
    if (event === 'message' && (this as unknown as { _isServer: boolean })._isServer) {
      const raw = String(args[0]); counters.applicationRxBytes += Buffer.byteLength(raw);
      try {
        const frame = JSON.parse(raw);
        if (frame.type === 'request') {
          let map = requests.get(this); if (!map) { map = new Map(); requests.set(this, map); }
          map.set(frame.requestId, { method: frame.method, sessionId: frame.input?.sessionId });
        } else if (frame.type === 'unsubscribe') subscriptions.get(this)?.delete(frame.subscriptionId);
      } catch { /* malformed frames are measured and rejected by the real parser */ }
    }
    return socketEmit.call(this, event, ...args);
  };
  const enqueue = RpcSendQueue.prototype.enqueue;
  RpcSendQueue.prototype.enqueue = function (frame, priority) {
    const state = this as unknown as { socket: NativeSocket; frames: unknown[]; bytes: number; inFlightBytes: number; sending: boolean };
    if (!knownSockets.has(state.socket)) { knownSockets.add(state.socket); sockets.add(new WeakRef(state.socket)); subscriptions.set(state.socket, new Map()); }
    const result = enqueue.call(this, frame, priority);
    if (result) counters.applicationTxBytes += Buffer.byteLength(JSON.stringify(frame));
    if (frame.type === 'result') {
      const request = requests.get(state.socket)?.get(frame.requestId);
      if (request && frame.output && typeof frame.output === 'object' && 'subscriptionId' in frame.output) subscriptions.get(state.socket)?.set(String(frame.output.subscriptionId), request);
      requests.get(state.socket)?.delete(frame.requestId);
    } else if (frame.type === 'error') requests.get(state.socket)?.delete(frame.requestId);
    else if (frame.type === 'stream.error') subscriptions.get(state.socket)?.delete(frame.subscriptionId);
    counters.sendQueueFramesMax = Math.max(counters.sendQueueFramesMax, state.frames.length + Number(state.sending));
    counters.sendQueueBytesMax = Math.max(counters.sendQueueBytesMax, state.bytes + Math.max(state.inFlightBytes, state.socket.bufferedAmount));
    return result;
  };
  const push = StreamQueue.prototype.push;
  StreamQueue.prototype.push = function (item) {
    push.call(this, item);
    const state = this as unknown as { items: unknown[]; bytes: number };
    counters.streamQueueFramesMax = Math.max(counters.streamQueueFramesMax, state.items.length); counters.streamQueueBytesMax = Math.max(counters.streamQueueBytesMax, state.bytes);
  };
  const processPrototype = ChildProcess.prototype as any;
  const spawn = processPrototype.spawn;
  processPrototype.spawn = function (options: { file: string }) {
    const executable = basename(options.file);
    if (executable === 'git' || executable === 'git.exe') counters.gitScans++;
    if (['ps', 'df', 'sysctl', 'systeminfo.exe', 'wmic.exe'].includes(executable)) counters.hostResourceProbes++;
    return spawn.call(this, options);
  };
  const listAgents = SwarmManager.prototype.listAgentsForInternalUse;
  SwarmManager.prototype.listAgentsForInternalUse = function () { manager = this; return listAgents.call(this); };
  const getAgent = SwarmManager.prototype.getAgentForInternalUse;
  SwarmManager.prototype.getAgentForInternalUse = function (id) { manager = this; return overlay.get(id) ?? getAgent.call(this, id); };
  const history = SwarmManager.prototype.getConversationHistoryPage;
  SwarmManager.prototype.getConversationHistoryPage = function (...args) { counters.transcriptHydrations++; return history.apply(this, args); };
  const hit = (boundary: CrashBoundary | RecoveryBoundary, commandId: string) => {
    if (!armed || armed.commandId !== commandId || armed.boundary !== boundary) return;
    writeFileSync(markerPath, JSON.stringify({ ...armed, fired: true, pid: process.pid, reachedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
    const fd = openSync(markerPath, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    process.kill(process.pid, 'SIGKILL');
    throw new Error('Crash hook returned unexpectedly');
  };
  const isArmedReportRun = (runId: string | undefined, database = controlDatabase) => {
    if (!armed || !database || !runId) return false;
    const state = loadState(database);
    return Object.values(state.assignments).some(assignment => {
      const transfer = assignment.resultTransferId && state.transfers[assignment.resultTransferId];
      return transfer && transfer.kind === 'worker_result' && transfer.targetRunId === runId &&
        state.runs[assignment.parentRunId]?.commandId === armed!.commandId;
    });
  };
  const originalTransaction = prototype.transaction;
  prototype.transaction = function (this: Database, fn: (...args: any[]) => any) {
    const database = this;
    const transaction = originalTransaction.call(database, (...args: any[]) => {
      const result = fn(...args);
      if (armed && database.name === databasePath && database.prepare('SELECT command_id FROM command_receipts WHERE command_id=? AND state=\'accepted\'').get(armed.commandId)) hit('pre-commit', armed.commandId);
      return result;
    });
    const wrap = (operation: (...args: any[]) => any) => (...args: any[]) => {
      const result = operation(...args);
      if (armed && database.name === databasePath && database.prepare('SELECT command_id FROM command_receipts WHERE command_id=? AND state=\'accepted\'').get(armed.commandId)) hit('post-commit', armed.commandId);
      if (armed?.boundary === 'result-dispatch' && database.name === databasePath &&
        Object.values(loadState(database).transfers).some(transfer => transfer.kind === 'worker_result' &&
          transfer.state === 'dispatch_marked' && isArmedReportRun(transfer.targetRunId, database)))
        hit('result-dispatch', armed.commandId);
      return result;
    };
    return Object.assign(wrap(transaction), { deferred: wrap(transaction.deferred), immediate: wrap(transaction.immediate), exclusive: wrap(transaction.exclusive) });
  } as Database['transaction'];
  const originalPrepare = prototype.prepare;
  prototype.prepare = function (this: Database, sql: string) {
    if (armed && this.name === databasePath) controlDatabase = this;
    const statement = originalPrepare.call(this, sql);
    if (this.name === databasePath && /SELECT summary_json FROM control_(?:sessions|projects) ORDER BY/.test(sql)) {
      const all = statement.all.bind(statement) as (...args: any[]) => unknown[];
      statement.all = (...args: any[]) => { counters.catalogSerializations++; return all(...args); };
    }
    if (this.name === databasePath && sql === "UPDATE workspace_reservations SET state='ready' WHERE command_id=?") {
      const run = statement.run.bind(statement) as (...args: any[]) => ReturnType<typeof statement.run>;
      statement.run = (...args: any[]) => { hit('post-Git', args[0]); return run(...args); };
    }
    return statement;
  } as Database['prepare'];
  const originalSave = AgentDescriptorStore.prototype.save;
  AgentDescriptorStore.prototype.save = async function () {
    if (armed?.boundary === 'post-meta') {
      const descriptor = this.snapshotForPersistence().agents.find(agent => agent.controlCommandId === armed!.commandId);
      if (descriptor) {
        const path = getSessionMetaPath(dataDir, descriptor.profileId!, descriptor.agentId);
        if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).controlCommandId === armed.commandId) hit('post-meta', armed.commandId);
      }
    }
    await originalSave.call(this);
  };
  const originalStop = SwarmManager.prototype.stopSession;
  SwarmManager.prototype.stopSession = function (...args) {
    if (armed) hit('stop-runtime', armed.commandId);
    return originalStop.apply(this, args);
  };
  const originalApply = SwarmManager.prototype.applyControlledInput;
  SwarmManager.prototype.applyControlledInput = function (text, input) {
    const control = input.controlledInput;
    if (!armed && held?.commandId !== control.commandId) return originalApply.call(this, text, input);
    const result = originalApply.call(this, text, { ...input, controlledInput: {
      ...control,
      onLocator(locator) {
        hit('post-JSONL', control.commandId);
        if (armed?.boundary === 'result-canonical' && isArmedReportRun(input.runId)) hit('result-canonical', armed.commandId);
        control.onLocator?.(locator);
      },
    } });
    // Hold after canonical append and before the core's durable dispatch marker.
    if (held?.commandId === control.commandId) {
      const hold = held;
      return result.then(async value => { hold.reached = true; await hold.wait; return value; });
    }
    return result;
  };
  const nonSteeringSessions = new Set<string>();
  const originalAcquire = SwarmManager.prototype.acquireControlledProvider;
  SwarmManager.prototype.acquireControlledProvider = async function (...args) {
    const acquired = await originalAcquire.apply(this, args);
    const adapter = acquired.adapter;
    if (nonSteeringSessions.has(args[0].threadId)) acquired.binding.capabilities = { ...acquired.binding.capabilities, native: { ...acquired.binding.capabilities.native, steer: false } };
    const start = adapter.start.bind(adapter);
    const observe = adapter.observations.bind(adapter);
    let armedAttemptId: string | undefined;
    acquired.adapter = new Proxy(adapter, {
      get(target, key) {
        if (key === 'start') return (input: Parameters<typeof start>[0]) => {
          const commandId = input.runId.replace(/^run-/, '');
          if (!armed || armed.commandId !== commandId) return start(input);
          if (armed.boundary === 'post-provider-accept') armedAttemptId = input.attemptId;
          hit('post-dispatch-marker', commandId);
          return start(input);
        };
        if (key === 'observations') return async function* (...args: Parameters<typeof observe>) {
          for await (const event of observe(...args)) {
            if (armed?.boundary === 'post-provider-accept' && event.type === 'accepted' && event.attemptId === armedAttemptId)
              hit('post-provider-accept', armed.commandId);
            if (armed?.boundary === 'result-ack' && event.type === 'accepted' && controlDatabase &&
              isArmedReportRun(loadState(controlDatabase).attempts[event.attemptId]?.runId)) hit('result-ack', armed.commandId);
            yield event;
          }
        };
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    return acquired;
  };
  return {
    arm(input: { commandId: string; boundary: CrashBoundary }) {
      if (!/^[0-9a-f-]{36}$/.test(input.commandId) || !crashBoundaries.includes(input.boundary)) throw new Error('Invalid controlled crash request');
      armed = input; return { armed: true, pid: process.pid };
    },
    async operate(input: { operation: string; boundary?: string; commandId?: string; sessionId?: string; count?: number; hz?: number; durationMs?: number; textBytes?: number; status?: AgentDescriptor['status']; gc?: boolean }) {
      if (input.operation === 'arm-recovery-crash') {
        if (!input.commandId || !/^[0-9a-f-]{36}$/.test(input.commandId) || !recoveryBoundaries.includes(input.boundary as RecoveryBoundary)) throw new Error('Invalid recovery crash request');
        armed = { commandId: input.commandId, boundary: input.boundary as RecoveryBoundary }; return { pid: process.pid };
      }
      if (input.operation === 'recovery-snapshot') return manager!.getRestartRecoverySnapshot();
      if (input.operation === 'recovery-resume') {
        const reports = manager!.getRestartRecoverySnapshot()?.undeliveredReports ?? [];
        await manager!.resumeRestartRecovery();
        // The private fixture observes asynchronous outbox completion, as RPC receipts
        // acknowledge the durable decision before provider acceptance.
        const database = new Constructor(databasePath, { readonly: true });
        try {
          const expires = Date.now() + 15_000;
          while (reports.length) {
            const state = loadState(database);
            if (reports.every(report => { const transfer = state.transfers[report.deliveryId]; return transfer && ['consumed', 'unknown', 'superseded'].includes(transfer.state); })) break;
            if (Date.now() >= expires) throw new Error('Recovery report outbox did not settle');
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        } finally { database.close(); }
        return { resumed: true };
      }
      if (input.operation === 'route-inventory') return webServer!.listRegisteredHttpRoutes().map((route, index) => ({ index, methods: route.methods, access: (route as unknown as { access?: unknown }).access ?? null }));
      if (input.operation === 'terminal-evidence') return terminalEvents;
      if (input.operation === 'disable-native-steer') {
        if (!input.sessionId || !manager?.getAgent(input.sessionId)) throw new Error('Missing fixture session');
        nonSteeringSessions.add(input.sessionId); return { nativeSteer: false };
      }
      if (input.operation === 'hold-dispatch') {
        if (!input.commandId || held) throw new Error('Invalid fixture hold');
        let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
        held = { commandId: input.commandId, reached: false, wait, release }; return { armed: true };
      }
      if (input.operation === 'hold-state') return { reached: held?.reached ?? false };
      if (input.operation === 'release-dispatch') { held?.release(); held = undefined; return { released: true }; }
      if (input.operation === 'host-terminal-create') {
        if (!terminalService || !input.sessionId) throw new Error('Fixture terminal owner unavailable');
        return terminalService.create({ sessionAgentId: input.sessionId, shell: '/bin/sh', shellArgs: [] });
      }
      if (input.operation === 'metrics') {
        if (input.gc) (globalThis as unknown as { gc?: () => void }).gc?.();
        const active = [...sockets].map(ref => ref.deref()).filter((socket): socket is NativeSocket => !!socket && socket.readyState === WebSocket.OPEN);
        return { ...counters, pid: process.pid, memory: process.memoryUsage(), sockets: active.length, subscriptions: active.flatMap(socket => [...(subscriptions.get(socket)?.entries() ?? [])].map(([subscriptionId, value]) => ({ subscriptionId, ...value }))), tcpRxBytes: active.reduce((n, socket) => n + ((socket as any)._socket?.bytesRead ?? 0), 0), tcpTxBytes: active.reduce((n, socket) => n + ((socket as any)._socket?.bytesWritten ?? 0), 0), gcAvailable: typeof (globalThis as any).gc === 'function' };
      }
      if (input.operation === 'stream-stop') { for (const timer of streams) clearInterval(timer); streams.clear(); return { stopped: true }; }
      if (!manager || !input.sessionId) throw new Error('Fixture session missing');
      const descriptor = manager.getAgentForInternalUse(input.sessionId); if (!descriptor) throw new Error('Unknown fixture session');
      if (input.operation === 'manager-status') {
        if (descriptor.role !== 'manager' || !['stopped', 'error'].includes(input.status ?? '')) throw new Error('Invalid fixture manager status');
        const internal = manager as unknown as { descriptors: Map<string, AgentDescriptor>; descriptorStoreAdapter: { saveStore(): Promise<void> } };
        internal.descriptors.get(descriptor.agentId)!.status = input.status!;
        await internal.descriptorStoreAdapter.saveStore();
        manager.emit('agent_status', { agentId: descriptor.agentId, status: input.status!, timestamp: new Date().toISOString() });
        return { status: input.status };
      }
      if (input.operation === 'project-agent-recommendations') {
        const sessionId = input.sessionId;
        manager.requestProjectAgentRecommendations = async target => {
          if (target !== sessionId) throw new Error('Unknown fixture recommendation target');
          return { whenToUse: 'Synthetic fixture documentation', systemPrompt: 'Use synthetic fixture content' };
        };
        return { configured: true };
      }
      // Attention is raised by a settled working epoch; the fixture reports one without a provider turn.
      if (input.operation === 'attention' || input.operation === 'attention-state') {
        if (input.operation === 'attention') {
          const attention = (manager as unknown as { sessionAttention: { reportStatusTransition(input: { agentId: string; previousStatus: AgentDescriptor['status']; nextStatus: AgentDescriptor['status']; transitionedAt: string }): Promise<void> } }).sessionAttention;
          const transitionedAt = new Date().toISOString();
          await attention.reportStatusTransition({ agentId: descriptor.agentId, previousStatus: 'idle', nextStatus: 'streaming', transitionedAt });
          await attention.reportStatusTransition({ agentId: descriptor.agentId, previousStatus: 'streaming', nextStatus: 'idle', transitionedAt });
        }
        return manager.getSessionAttentionSnapshot().attentions.filter(attention => attention.sessionAgentId === descriptor.agentId).map(attention => ({ attentionId: attention.attentionId, reason: attention.reason }));
      }
      const inject = () => {
        const timestamp = new Date(Date.now() + tick++).toISOString();
        // A provider's coalesced detail updates do not advance its session's activity time every token.
        // Status changes once at turn start; shell-burst separately exercises the real shell update path.
        const next = input.operation === 'stream-start' && overlay.has(descriptor.agentId) ? overlay.get(descriptor.agentId)!
          : { ...descriptor, status: input.status ?? 'streaming' as const, updatedAt: timestamp };
        overlay.set(descriptor.agentId, next);
        if (input.operation !== 'shell-burst') {
          const event = { type: 'conversation_message' as const, agentId: descriptor.agentId, role: 'assistant' as const, source: 'speak_to_user' as const, text: `Synthetic provider update ${tick} ` + 'x'.repeat(input.textBytes ?? 64), timestamp, terminal: true, id: randomUUID() };
          timeline.appendConversationEntry(descriptor, event); manager!.emit('conversation_message', event);
        }
        manager!.emit('agent_status', { agentId: descriptor.agentId, status: next.status, timestamp }); counters.injections++;
      };
      if (input.operation === 'stream-start') {
        if (!input.hz || input.hz < 1 || input.hz > 100 || !input.durationMs || input.durationMs > 120000) throw new Error('Invalid fixture stream limits');
        const timer = setInterval(inject, 1000 / input.hz); streams.add(timer);
        setTimeout(() => { clearInterval(timer); streams.delete(timer); }, input.durationMs);
        return { started: true };
      }
      if (!['burst', 'shell-burst'].includes(input.operation) || !input.count || input.count > 10000 || (input.textBytes ?? 0) > 60000) throw new Error('Invalid fixture burst');
      for (let index = 0; index < input.count; index++) inject();
      return { injected: input.count };
    },
  };
}
