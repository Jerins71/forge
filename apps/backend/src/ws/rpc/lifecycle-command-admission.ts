import type { ClientCommand } from "@forge/protocol";
import { requireNonSystemSessionProfile } from "../../swarm/system-profile-guards.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import type { ControlService, Principal } from "../../environment/control/control-types.js";
import { StreamFault } from "../../environment/streams/stream-budget.js";
import { awaitCommandReceipt, controlCommandId } from "./control-command-helpers.js";

const lifecycleCommands = new Set<ClientCommand["type"]>([
  "resume_session", "kill_agent", "stop_all_agents",
  "choice_cancel", "clear_session", "delete_session", "archive_session", "fork_session",
]);
export function isLifecycleCommand(command: ClientCommand): boolean { return lifecycleCommands.has(command.type); }

/** One admission policy for V2 legacy RPC, authenticated Builder WS and CLI. */
export async function admitLifecycleCommand<T>(control: ControlService, principal: Principal,
  swarm: Pick<SwarmManager, "getAgent" | "listAgents" | "listProfiles" | "getRestartRecoverySnapshot" | "isSessionShutdownSafe">,
  command: ClientCommand, sessionId: string, operation: () => Promise<T>): Promise<T> {
  if (!isLifecycleCommand(command)) return operation();
  if (!control.admitLifecycle) throw new StreamFault("UNAVAILABLE", "Lifecycle admission is not composed.");
  const addressed = command as ClientCommand & { agentId?: string; sourceAgentId?: string; managerId?: string; requestId?: string; choiceId?: string };
  const targetId = addressed.agentId ?? addressed.sourceAgentId ?? addressed.managerId ?? sessionId;
  const target = swarm.getAgent(targetId);
  const owner = (id: string): string => { const descriptor = swarm.getAgent(id); return descriptor?.role === "worker" ? descriptor.managerId : id; };
  if (command.type === "kill_agent") {
    if (target && target.role !== "worker") throw new StreamFault("INVALID_INPUT", "Manager cannot be killed.");
    // The typed UI path already uses session.stop for a worker. Both paths now
    // use the manager's effect lane without stopping the owning manager.
    await awaitCommandReceipt(control, principal, await control.execute(principal, "session.stop", {
      commandId: controlCommandId(principal, "session.stop"), sessionId: targetId,
    }));
    return undefined as T;
  }
  const sessionIds = [owner(targetId)];
  if (command.type === "delete_session" || command.type === "fork_session" && command.sessionPurpose === "side_chat")
    sessionIds.push(...swarm.listAgents().filter(agent => agent.role === "manager" && agent.sideChatSourceAgentId === targetId).map(agent => agent.agentId));
  const stop = command.type === "clear_session" || command.type === "delete_session" || command.type === "archive_session" || command.type === "stop_all_agents";
  const intent = stop ? "stop" : command.type === "resume_session" && target?.role !== "worker" ? "resume" : command.type === "choice_cancel" ? "cancel-choice" : "inspect";
  // Choice cancellation has immutable occurrence identity. Other commands use
  // the existing requestId; old identifier-less calls are distinct requests.
  const requestId = addressed.requestId ?? (command.type === "choice_cancel" ? addressed.choiceId : undefined);
  return control.admitLifecycle(principal, {
    commandId: controlCommandId(principal, command.type, requestId), command: command.type,
    sessionIds, intent, request: command, ...(command.type === "choice_cancel" ? { choiceId: command.choiceId } : {}),
    preflight() {
      if (command.type === "clear_session" || command.type === "delete_session" || command.type === "archive_session" || command.type === "fork_session") {
        if (!target || target.role !== "manager") throw new StreamFault("NOT_FOUND", "Unknown manager session.");
        try { requireNonSystemSessionProfile(targetId, swarm.listProfiles(), id => swarm.getAgent(id)); }
        catch { throw new StreamFault("FORBIDDEN", "Cannot modify sessions in system-managed profiles."); }
      }

      if (command.type === "stop_all_agents" && owner(sessionId) !== targetId)
        throw new StreamFault("FORBIDDEN", "Only the selected manager can stop its agents.");
    },
  }, async () => {
    const result = await operation();
    const affected = sessionIds;
    if (stop && affected.some(id => !swarm.isSessionShutdownSafe(id)))
      throw new StreamFault("UNAVAILABLE", "Session shutdown is not safely complete; retry cleanup with a new request.");
    return result;
  });
}
