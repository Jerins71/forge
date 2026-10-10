import { Value } from '@sinclair/typebox/value';
import { rpcSchemas, rpcScopes, type RpcInput } from '@forge/protocol/environment-v2';
import type { SwarmManager } from '../../swarm/swarm-manager.js';
import type { UnreadTracker } from '../../swarm/session/unread-tracker.js';
import type { ControlService, Principal } from '../../environment/control/control-types.js';
import { requireNonSystemSessionProfile } from '../../swarm/system-profile-guards.js';
import { StreamFault } from '../../environment/streams/stream-budget.js';

export type SessionStateMethod = 'session.update' | 'session.message.pin' | 'session.pins.clear' | 'session.readState.set' | 'project.readState.clear' | 'session.attention.dismiss';
export function createSessionStateRpc({ swarmManager: swarm, control, unreadTracker: unread }: { swarmManager: SwarmManager; control: ControlService; unreadTracker?: UnreadTracker }) {
  return { async execute(principal: Principal, method: SessionStateMethod, raw: unknown) {
    if (!principal.scopes.has(rpcScopes[method])) throw new StreamFault('FORBIDDEN', 'Missing session state scope');
    if (!Value.Check(rpcSchemas[method].input, raw)) throw new StreamFault('INVALID_INPUT', 'Invalid session state input');
    if (!control.admitLifecycle) throw new StreamFault('UNAVAILABLE', 'Session state control is unavailable');
    const input = raw as RpcInput<SessionStateMethod>;
    const sessionId = 'sessionId' in input ? input.sessionId : undefined;
    const projectId = 'projectId' in input ? input.projectId : undefined;
    const occurrences = swarm.getSessionAttentionSnapshot().attentions;
    const sessionIds = sessionId ? [sessionId] : projectId
      ? swarm.listAgents().filter(a => a.role === 'manager' && a.profileId === projectId).map(a => a.agentId)
      : occurrences.filter(a => (input as RpcInput<'session.attention.dismiss'>).occurrenceIds.includes(a.attentionId)).map(a => a.sessionAgentId);
    const requireSession = (id: string) => {
      const descriptor = swarm.getAgent(id);
      if (!descriptor || descriptor.role !== 'manager') throw new StreamFault('NOT_FOUND', 'Manager session is unavailable');
      requireNonSystemSessionProfile(id, swarm.listProfiles(), target => swarm.getAgent(target));
      return descriptor;
    };
    await control.admitLifecycle(principal, {
      commandId: input.commandId, command: method, request: input, sessionIds, ...(projectId ? { projectIds: [projectId] } : {}), intent: 'inspect',
      requiredScope: rpcScopes[method], receiptReplay: true,
      receipt: { method, ...(sessionId ? { sessionId } : {}), ...(projectId ? { projectId } : {}) },
      preflight() {
        if (projectId && !swarm.listProfiles().some(p => p.profileId === projectId && p.profileType !== 'system')) throw new StreamFault('NOT_FOUND', 'Project is unavailable');
        for (const id of sessionIds) requireSession(id);
        if (method === 'session.attention.dismiss') {
          const current = swarm.getSessionAttentionSnapshot().attentions;
          for (const id of (input as RpcInput<typeof method>).occurrenceIds) {
            const occurrence = current.find(a => a.attentionId === id);
            if (!occurrence) throw new StreamFault('CONFLICT', 'Attention occurrence is no longer current');
            requireSession(occurrence.sessionAgentId);
          }
        }
      },
    }, async () => {
      switch (method) {
        case 'session.update': {
          const update = input as RpcInput<typeof method>;
          if (update.title !== undefined) await swarm.renameSession(update.sessionId, update.title);
          if (update.pinned !== undefined) return swarm.pinSession(update.sessionId, update.pinned);
          return {};
        }
        case 'session.message.pin': {
          const pin = input as RpcInput<typeof method>;
          const entry = swarm.getConversationHistory(pin.sessionId).find(e => e.type === 'conversation_message' && (e.id === pin.itemId || e.timelineEntryId === pin.itemId));
          if (!entry || entry.type !== 'conversation_message' || !entry.id) throw new StreamFault('NOT_FOUND', 'Conversation item is unavailable');
          const result = await swarm.pinMessage(pin.sessionId, entry.id, pin.pinned);
          swarm.emit('message_pinned', { type: 'message_pinned', agentId: pin.sessionId, messageId: pin.itemId, pinned: pin.pinned, timestamp: result.timestamp });
          return {};
        }
        case 'session.pins.clear': await swarm.clearAllPins(sessionId!); return {};
        case 'session.readState.set': {
          if (!unread) throw new StreamFault('UNAVAILABLE', 'Unread owner is unavailable');
          const descriptor = requireSession(sessionId!);
          const profile = descriptor.profileId ?? descriptor.agentId;
          if ((input as RpcInput<typeof method>).read) unread.markRead(profile, sessionId!);
          else unread.markUnread(profile, sessionId!);
          await unread.flush(); return {};
        }
        case 'project.readState.clear':
          if (!unread) throw new StreamFault('UNAVAILABLE', 'Unread owner is unavailable');
          for (const id of sessionIds) unread.markRead(projectId!, id);
          await unread.flush(); return {};
        case 'session.attention.dismiss':
          await swarm.dismissSessionAttention((input as RpcInput<typeof method>).occurrenceIds); return {};
      }
    });
    return control.getReceipt(principal, input.commandId);
  } };
}
