import type { ServerEvent, SecureSessionSnapshot } from '@forge/protocol';
import type { ManagerWsConversationEventContext } from './types';
import { reduceManagerToolActivity } from './manager-tool-activity-state';
export function applySecureSessionSnapshot(snapshot: SecureSessionSnapshot, context: ManagerWsConversationEventContext): void {
    const targetAgentId = context.state.targetAgentId;
    if (!isSecureSessionSnapshotForTarget(snapshot, targetAgentId, context.state.agents))
        return;
    const current = context.state.secureSessionSnapshots[snapshot.sessionAgentId];
    if (current && snapshot.revision < current.revision)
        return;
    context.updateState({
        secureSessionSnapshots: {
            ...context.state.secureSessionSnapshots,
            [snapshot.sessionAgentId]: snapshot,
        },
        ...(context.state.secureSessionSnapshotLoadingSessionId === snapshot.sessionAgentId
            || context.state.secureSessionSnapshotLoadingSessionId === targetAgentId
            ? { secureSessionSnapshotLoadingSessionId: null }
            : {}),
    });
}
export function isSecureSessionSnapshotForTarget(snapshot: SecureSessionSnapshot, targetAgentId: string | null, agents: ReadonlyArray<{
    agentId: string;
    managerId: string;
    role: 'manager' | 'worker';
}> = []): boolean {
    if (!targetAgentId)
        return false;
    const snapshotAuthorityAgentId = snapshot.ownerManagerAgentId ?? snapshot.sessionAgentId;
    const target = agents.find((agent) => agent.agentId === targetAgentId);
    const targetAuthorityAgentId = target?.role === 'worker'
        ? target.managerId
        : targetAgentId;
    return targetAgentId === snapshot.sessionAgentId
        || targetAuthorityAgentId === snapshotAuthorityAgentId;
}
export function applyDetailFeature(event: ServerEvent, context: ManagerWsConversationEventContext): boolean {
    switch (event.type) {
        case 'codex_elicitation_request': {
            if (event.agentId !== context.state.targetAgentId)
                return true;
            const existing = context.state.codexElicitations.filter((item) => item.elicitationId !== event.elicitationId);
            context.updateState({ codexElicitations: [...existing, event] });
            return true;
        }
        case 'codex_elicitation_dismissed': {
            if (event.agentId !== context.state.targetAgentId)
                return true;
            context.updateState({ codexElicitations: context.state.codexElicitations.filter((item) => item.elicitationId !== event.elicitationId) });
            return true;
        }
        case 'manager_tool_activity': {
            const patch = reduceManagerToolActivity(context.state, event);
            if (patch)
                context.updateState(patch);
            return true;
        }
        case 'session_plan_snapshot': {
            const current = context.state.planSnapshots[event.sessionAgentId];
            if (current && event.revision < current.revision) {
                return true;
            }
            context.updateState({
                planSnapshots: {
                    ...context.state.planSnapshots,
                    [event.sessionAgentId]: event,
                },
                ...(context.state.planSnapshotLoadingSessionId === event.sessionAgentId
                    ? { planSnapshotLoadingSessionId: null }
                    : {}),
            });
            return true;
        }
        case 'session_goal_snapshot': {
            const current = context.state.goalSnapshots[event.sessionAgentId];
            if (current && event.revision < current.revision)
                return true;
            context.updateState({
                goalSnapshots: {
                    ...context.state.goalSnapshots,
                    [event.sessionAgentId]: event,
                },
                ...(context.state.goalSnapshotLoadingSessionId === event.sessionAgentId
                    ? { goalSnapshotLoadingSessionId: null }
                    : {}),
            });
            return true;
        }
        case 'secure_session_snapshot':
            applySecureSessionSnapshot(event, context);
            return true;
        default: return false;
    }
}
