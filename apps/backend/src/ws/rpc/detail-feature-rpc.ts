import { Value } from '@sinclair/typebox/value';
import {
  decodeEnvironmentValue, DetailFeatureEventSchema, rpcSchemas, rpcScopes,
  type DetailFeatureEvent, type RpcInput,
} from '@forge/protocol/environment-v2';
import type { SwarmManager } from '../../swarm/swarm-manager.js';
import type { ControlService, Principal } from '../../environment/control/control-types.js';
import { recoveryProjection } from '../../environment/streams/wire-projection.js';
import { StreamFault } from '../../environment/streams/stream-budget.js';
import { requireNonSystemSessionProfile } from '../../swarm/system-profile-guards.js';

export type DetailControlMethod = 'session.goal.control' | 'session.compact' | 'session.elicitation.respond' | 'session.elicitation.url' | 'recovery.get' | 'recovery.decide';
export function createDetailFeatureRpc({ swarmManager: swarm, control, compactionSource = "web" }: { swarmManager: SwarmManager; control: ControlService; compactionSource?: "web" | "cli" }) {
  return {
    async execute(principal: Principal, method: DetailControlMethod, raw: unknown) {
      if (!principal.scopes.has(rpcScopes[method])) throw new StreamFault('FORBIDDEN', 'Missing feature scope');
      if (!Value.Check(rpcSchemas[method].input, raw)) throw new StreamFault('INVALID_INPUT', 'Invalid feature input');
      if (method === 'recovery.get') return { recovery: recoveryProjection(swarm) };
      if (method === 'session.elicitation.url') {
        const input = raw as RpcInput<typeof method>;
        const url = swarm.getCodexElicitationUrl({ managerAgentId: input.sessionId, elicitationId: input.elicitationId, generation: input.generation });
        if (!url) throw new StreamFault('CONFLICT', 'Elicitation generation is no longer pending');
        return { url };
      }
      if (method === 'session.elicitation.respond') {
        const input = raw as RpcInput<typeof method>;
        const pending = swarm.getPendingCodexElicitationsForManager(input.sessionId).find(item => item.elicitationId === input.elicitationId);
        if (!pending || input.generation !== pending.elicitationId) throw new StreamFault('CONFLICT', 'Elicitation generation is no longer pending');
        // The pending Promise owner receives values directly. No command, effect,
        // receipt, event or log is created for this nonpersistent reply.
        if (!swarm.respondToCodexElicitation({ managerAgentId: input.sessionId, elicitationId: input.elicitationId,
          decision: input.decision, values: input.values, persistScope: input.persistScope })) throw new StreamFault('CONFLICT', 'Elicitation response was rejected');
        return {};
      }
      if (!control.admitLifecycle) throw new StreamFault('UNAVAILABLE', 'Feature control is not composed');
      const input = raw as RpcInput<'session.goal.control'> | RpcInput<'session.compact'> | RpcInput<'recovery.decide'>;
      const recovery = method === 'recovery.decide' ? recoveryProjection(swarm) : null;
      const sessionId = 'sessionId' in input ? input.sessionId : undefined;
      await control.admitLifecycle(principal, {
        commandId: input.commandId, command: method, request: input,
        sessionIds: sessionId ? [sessionId] : [...new Set([...(recovery?.interruptedManagers ?? []), ...(recovery?.interruptedWorkers ?? []).map(id => { const d = swarm.getAgent(id); return d?.role === 'worker' ? d.managerId : id; }), ...(recovery?.undeliveredReports ?? []).map(r => { const d = swarm.getAgent(r.toAgentId); return d?.role === 'worker' ? d.managerId : r.toAgentId; })])], intent: 'inspect',
        receipt: { method, ...(sessionId ? { sessionId } : {}) },
        receiptReplay: true, ambiguousDelivery: method === 'session.compact',
        preflight: () => {
          if (method === 'recovery.decide') {
            if (!recovery || recovery.recoveryId !== (input as RpcInput<'recovery.decide'>).recoveryId) throw new StreamFault('CONFLICT', 'Recovery occurrence is no longer current');
          } else {
            const agent = swarm.getAgent(sessionId!);
            if (!agent || agent.role !== 'manager') throw new StreamFault('NOT_FOUND', 'Manager session is unavailable');
            requireNonSystemSessionProfile(sessionId!, swarm.listProfiles(), id => swarm.getAgent(id));
          }
        },
      }, async () => {
        if (method === 'recovery.decide') {
          const decision = input as RpcInput<'recovery.decide'>;
          const snapshot = decision.action === 'resume' ? await swarm.resumeRestartRecovery() : await swarm.dismissRestartRecovery();
          swarm.emit('restart_recovery_snapshot', { type: 'restart_recovery_snapshot', snapshot });
        } else if (method === 'session.goal.control') {
          const goal = input as RpcInput<'session.goal.control'>;
          await swarm.controlSessionGoal(sessionId!, goal.action === 'edit' ? { action: goal.action, objective: goal.objective, tokenBudget: goal.tokenBudget } : { action: goal.action });
        } else {
          const compact = input as RpcInput<'session.compact'>;
          if (compact.mode === 'smart') return swarm.smartCompactAgentContext(sessionId!, { customInstructions: compact.customInstructions, sourceContext: { channel: compact.source ?? compactionSource, messageId: compact.commandId }, trigger: (compact.source ?? compactionSource) === "cli" ? "cli" : "api" });
          await swarm.compactAgentContext(sessionId!, { customInstructions: compact.customInstructions, sourceContext: { channel: compact.source ?? compactionSource, messageId: compact.commandId }, trigger: (compact.source ?? compactionSource) === "cli" ? "cli" : "api" });
          return { compacted: true };
        }
        return {};
      });
      return control.getReceipt(principal, input.commandId);
    },
  };
}
/** Select declared metadata before validation. In particular no elicitation
 * reply, URL credential, provider locator or secret value can enter a stream. */
export function projectDetailFeature(raw: unknown): DetailFeatureEvent | undefined {
  if (!raw || typeof raw !== 'object') return;
  const e = raw as Record<string, unknown>;
  let event: unknown;
  switch (e.type) {
    case 'manager_tool_activity': event = { type: 'tool.activity', activity: e }; break;
    case 'timeline_activity': event = { type: 'activity.upsert', item: e.item }; break;
    case 'generation_throughput': event = { type: 'throughput.upsert', measurement: e.measurement, summary: e.sessionSummary }; break;
    case 'generation_throughput_snapshot': event = { type: 'throughput.snapshot', measurements: e.measurements, summary: e.sessionSummary }; break;
    case 'secure_session_snapshot': event = { type: 'secure.upsert', snapshot: e }; break;
    case 'secure_secret_catalog_changed': event = { type: 'secure.catalog.changed', revision: e.revision }; break;
    case 'codex_elicitation_request': event = { type: 'elicitation.request', request: { ...e, generation: e.elicitationId } }; break;
    case 'codex_elicitation_dismissed': event = { type: 'elicitation.dismissed', elicitationId: e.elicitationId, agentId: e.agentId }; break;
    case 'terminals_snapshot': event = { type: 'terminals.snapshot', scopeId: e.sessionAgentId, terminals: e.terminals }; break;
    case 'terminal_created': case 'terminal_updated': event = { type: 'terminal.upsert', scopeId: e.sessionAgentId, terminal: e.terminal }; break;
    case 'terminal_closed': event = { type: 'terminal.closed', scopeId: e.sessionAgentId, terminalId: e.terminalId, reason: e.reason }; break;
    default: return;
  }
  const cleaned = decodeEnvironmentValue(DetailFeatureEventSchema, event);
  if (!cleaned || Buffer.byteLength(JSON.stringify(cleaned)) > 65536) return;
  return cleaned;
}
