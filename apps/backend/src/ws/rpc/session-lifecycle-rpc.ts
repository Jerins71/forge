import { Value } from '@sinclair/typebox/value';
import { rpcSchemas, rpcScopes, type RpcInput } from '@forge/protocol/environment-v2';
import type { ControlService, Principal } from '../../environment/control/control-types.js';
import type { SwarmManager } from '../../swarm/swarm-manager.js';
import { requireNonSystemSessionProfile } from '../../swarm/system-profile-guards.js';
import { StreamFault } from '../../environment/streams/stream-budget.js';

export const lifecycleMethods = ['session.resume', 'session.archive', 'session.restore', 'session.clear', 'session.delete', 'session.fork', 'session.choice.cancel', 'session.stopAll', 'worker.stop', 'worker.resume', 'worker.kill'] as const;
export type SessionLifecycleMethod = typeof lifecycleMethods[number];
/** Native producers share the existing admission/effect lanes and domain policy. */
export function createSessionLifecycleRpc({ swarmManager: swarm, control }: { swarmManager: SwarmManager; control: ControlService }) {
  return {
    async execute(principal: Principal, method: SessionLifecycleMethod, raw: unknown) {
      if (!principal.scopes.has(rpcScopes[method])) throw new StreamFault('FORBIDDEN', 'Session operation is not authorized');
      if (!Value.Check(rpcSchemas[method].input, raw)) throw new StreamFault('INVALID_INPUT', 'Invalid session operation');
      if (!control.admitLifecycle) throw new StreamFault('UNAVAILABLE', 'Lifecycle admission is unavailable');
      const input = raw as RpcInput<SessionLifecycleMethod>;
      const target = swarm.getAgent(input.sessionId);
      const projectId = target?.profileId ?? input.sessionId;
      const stop = method === 'session.archive' || method === 'session.clear' || method === 'session.delete' || method === 'session.stopAll';
      const sessionIds = [input.sessionId];
      if (method === 'session.delete' || method === 'session.fork' && 'purpose' in input && input.purpose === 'side_chat')
        sessionIds.push(...swarm.listAgents().filter(d => d.role === 'manager' && d.sideChatSourceAgentId === input.sessionId).map(d => d.agentId));
      const forkId = `v2-${input.commandId}`;
      await control.admitLifecycle(principal, {
        commandId: input.commandId, command: method, request: input,
        sessionIds, intent: stop ? 'stop' : method === 'session.resume' ? 'resume' : method === 'session.choice.cancel' ? 'cancel-choice' : 'inspect',
        ...('choiceId' in input ? { choiceId: input.choiceId } : {}),
        receipt: { method, sessionId: method === 'session.fork' ? forkId : input.sessionId, projectId }, receiptReplay: true, requiredScope: rpcScopes[method],
        ...(method === 'session.fork' ? { frozenRequest: { sessionId: forkId } } : {}),
        preflight() {
          if (!target || target.role !== 'manager') throw new StreamFault('NOT_FOUND', 'Manager session not found');
          if (method === 'session.clear' || method === 'session.delete' || method === 'session.archive' || method === 'session.restore' || method === 'session.fork') {
            try { requireNonSystemSessionProfile(input.sessionId, swarm.listProfiles(), id => swarm.getAgent(id)); }
            catch { throw new StreamFault('FORBIDDEN', 'Cannot modify sessions in system-managed profiles'); }
          }
          if ('workerId' in input) {
            const worker = swarm.getAgent(input.workerId);
            if (!worker || worker.role !== 'worker' || worker.managerId !== input.sessionId) throw new StreamFault('NOT_FOUND', 'Worker does not belong to this session');
          }
          if ('choiceId' in input) {
            const choice = swarm.getPendingChoice(input.choiceId);
            if (!choice || choice.sessionAgentId !== input.sessionId) throw new StreamFault('CONFLICT', 'Choice is no longer pending in this session');
          }
        },
      }, async () => {
        let result: Record<string, unknown> = { projectId, sessionId: input.sessionId };
        switch (method) {
          case 'session.resume': await swarm.resumeSession(input.sessionId); break;
          case 'session.archive': result = { ...result, ...await swarm.archiveSession(input.sessionId) }; break;
          case 'session.restore': result = { ...result, ...await swarm.restoreSession(input.sessionId) }; break;
          case 'session.clear': await swarm.clearSessionConversation(input.sessionId); break;
          case 'session.delete': result = { ...result, ...await swarm.deleteSession(input.sessionId) }; break;
          case 'session.fork': {
            const fork = input as RpcInput<'session.fork'>;
            const created = await swarm.forkSession(input.sessionId, { sessionAgentId: forkId, label: fork.title, fromMessageId: fork.fromItemId, sessionPurpose: fork.purpose });
            result = { projectId: created.profile.profileId, sessionId: created.sessionAgent.agentId }; break;
          }
          case 'session.choice.cancel': swarm.cancelChoiceRequest((input as RpcInput<'session.choice.cancel'>).choiceId, 'cancelled'); break;
          case 'session.stopAll': result = { ...result, ...await swarm.stopAllAgents(input.sessionId, input.sessionId) }; break;
          case 'worker.stop': await swarm.stopWorker((input as RpcInput<'worker.stop'>).workerId); break;
          case 'worker.resume': await swarm.resumeWorker((input as RpcInput<'worker.resume'>).workerId); break;
          case 'worker.kill': await swarm.killAgent(input.sessionId, (input as RpcInput<'worker.kill'>).workerId); break;
        }
        if (stop && sessionIds.some(id => !swarm.isSessionShutdownSafe(id))) throw new StreamFault('UNAVAILABLE', 'Session shutdown is still settling');
        // Keep receipts bounded: domain return values can include full descriptors.
        return { projectId: result.projectId, sessionId: result.sessionId,
          ...(result.stoppedWorkerIds ? { stoppedWorkerIds: result.stoppedWorkerIds } : {}),
          ...(result.managerStopped !== undefined ? { managerStopped: result.managerStopped } : {}),
          ...(result.archivedAt ? { archivedAt: result.archivedAt } : {}),
          ...(result.openAgentId ? { openAgentId: result.openAgentId } : {}),
          ...(result.terminatedWorkerIds ? { terminatedWorkerIds: result.terminatedWorkerIds } : {}) };
      });
      return control.getReceipt(principal, input.commandId);
    },
  };
}
