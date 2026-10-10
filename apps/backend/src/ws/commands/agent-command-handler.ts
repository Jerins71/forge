import type { ClientCommand, ServerEvent } from "@forge/protocol";
import type { WebSocket } from "ws";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { projectConversationPageMetadataForWire } from "../conversation-page-wire.js";

export interface AgentCommandRouteContext<Connection = WebSocket> {
  command: ClientCommand;
  socket: Connection;
  subscribedAgentId: string;
  swarmManager: SwarmManager;
  resolveManagerContextAgentId: (subscribedAgentId: string) => string | undefined;
  send: (socket: Connection, event: ServerEvent) => void;
}

export async function handleAgentCommand<Connection>(context: AgentCommandRouteContext<Connection>): Promise<boolean> {
  const { command, socket, subscribedAgentId, swarmManager, resolveManagerContextAgentId, send } = context;

  if (command.type === "stop_all_agents") {
    const managerContextId = resolveManagerContextAgentId(subscribedAgentId);
    if (!managerContextId) {
      send(socket, {
        type: "error",
        code: "UNKNOWN_AGENT",
        message: `Agent ${subscribedAgentId} does not exist.`,
        requestId: command.requestId
      });
      return true;
    }

    try {
      const stopped = await swarmManager.stopAllAgents(managerContextId, command.managerId);
      send(socket, {
        type: "stop_all_agents_result",
        managerId: stopped.managerId,
        stoppedWorkerIds: stopped.stoppedWorkerIds,
        managerStopped: stopped.managerStopped,
        // Backward compatibility for older clients still expecting terminated-oriented fields.
        terminatedWorkerIds: stopped.terminatedWorkerIds,
        managerTerminated: stopped.managerTerminated,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "STOP_ALL_AGENTS_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "get_session_workers") {
    const manager = swarmManager.getAgent(command.sessionAgentId);
    if (!manager || manager.role !== "manager") {
      send(socket, {
        type: "error",
        code: "UNKNOWN_SESSION",
        message: `Unknown or non-manager session: ${command.sessionAgentId}`,
        requestId: command.requestId
      });
      return true;
    }

    send(socket, {
      type: "session_workers_snapshot",
      sessionAgentId: command.sessionAgentId,
      workers: swarmManager.listWorkersForSession(command.sessionAgentId),
      requestId: command.requestId
    });

    return true;
  }

  if (command.type === "get_conversation_page") {
    const target = swarmManager.getAgent(command.agentId);
    if (!target) {
      send(socket, {
        type: "error",
        code: "UNKNOWN_AGENT",
        message: `Agent ${command.agentId} does not exist.`,
        requestId: command.requestId,
      });
      return true;
    }

    try {
      const result = swarmManager.getConversationHistoryPage(command.agentId, {
        cursor: command.cursor,
        limit: command.limit,
        view: command.view,
      });
      send(socket, {
        type: "conversation_page",
        agentId: command.agentId,
        messages: result.messages,
        page: projectConversationPageMetadataForWire(result.page),
        requestId: command.requestId,
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "GET_CONVERSATION_PAGE_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId,
      });
    }
    return true;
  }

  return false;
}
