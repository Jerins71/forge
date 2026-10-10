import type { ClientCommand, ServerEvent } from "@forge/protocol";
import type { WebSocket } from "ws";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import type { UnreadTracker } from "../../swarm/session/unread-tracker.js";
export interface ManagerCommandRouteContext<Connection = WebSocket> {
  command: ClientCommand; socket: Connection; subscribedAgentId: string; swarmManager: SwarmManager;
  resolveManagerContextAgentId: (subscribedAgentId: string) => string | undefined;
  send: (socket: Connection, event: ServerEvent) => void;
  broadcastToSubscribed: (event: ServerEvent) => void;
  handleDeletedAgentSubscriptions: (deletedAgentIds: Set<string>) => void;
  unreadTracker?: UnreadTracker;
}
export async function handleManagerCommand<Connection>(context: ManagerCommandRouteContext<Connection>): Promise<boolean> {
  const { command, socket, swarmManager, send } = context;
  if (command.type === "hydrate_archive_last_used") {
    try {
      const result = await swarmManager.hydrateArchivedLastUsed();
      send(socket, {
        type: "archive_last_used_hydrated",
        scannedSessionCount: result.scannedSessionCount,
        hydratedSessionCount: result.hydratedSessionCount,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "HYDRATE_ARCHIVE_LAST_USED_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  return false;
}
