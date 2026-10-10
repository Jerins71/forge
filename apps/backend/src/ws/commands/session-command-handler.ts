import {
  type ClientCommand,
  type ServerEvent,
} from "@forge/protocol";
import type { WebSocket } from "ws";
import { ArchiveOperationError } from "../../swarm/archive/archive-service.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  requireNonSystemProfile,
  requireNonSystemSessionProfile,
  resolveProfileIdForSessionAgent,
} from "../../swarm/system-profile-guards.js";
import type { UnreadTracker } from "../../swarm/session/unread-tracker.js";

export interface SessionCommandRouteContext<Connection = WebSocket> {
  command: ClientCommand;
  socket: Connection;
  subscribedAgentId: string;
  swarmManager: SwarmManager;
  resolveManagerContextAgentId: (subscribedAgentId: string) => string | undefined;
  send: (socket: Connection, event: ServerEvent) => void;
  handleDeletedAgentSubscriptions: (deletedAgentIds: Set<string>) => void;
  unreadTracker?: UnreadTracker;
  broadcastUnreadCountUpdate?: (sessionAgentId: string, count: number) => void;
}

export async function handleSessionCommand<Connection>(context: SessionCommandRouteContext<Connection>): Promise<boolean> {
  const {
    command,
    socket,
    subscribedAgentId,
    swarmManager,
    resolveManagerContextAgentId,
    send,
    handleDeletedAgentSubscriptions,
    unreadTracker,
    broadcastUnreadCountUpdate,
  } = context;

  if (
    command.type !== "create_session" &&
    command.type !== "stop_session" &&
    command.type !== "resume_session" &&
    command.type !== "archive_session" &&
    command.type !== "restore_session" &&
    command.type !== "delete_session" &&
    command.type !== "clear_session" &&
    command.type !== "rename_session" &&
    command.type !== "pin_session" &&
    command.type !== "fork_session"
  ) {
    return false;
  }

  const managerContextId = resolveManagerContextAgentId(subscribedAgentId);
  if (!managerContextId) {
    send(socket, {
      type: "error",
      code: "UNKNOWN_AGENT",
      message: `Agent ${subscribedAgentId} does not exist.`,
      requestId: "requestId" in command ? command.requestId : undefined
    });
    return true;
  }

  if (command.type === "create_session") {
    try {
      requireNonSystemProfile(command.profileId, swarmManager.listProfiles());

      const created = await swarmManager.createSession(command.profileId, {
        label: command.label,
        name: command.name,
        sessionPurpose: command.sessionPurpose === "agent_creator" ? "agent_creator" : undefined
      });

      send(socket, {
        type: "session_created",
        profile: created.profile,
        sessionAgent: created.sessionAgent,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "CREATE_SESSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "stop_session") {
    try {
      // Check if target is a worker agent (supports stop/resume for workers too)
      const targetAgent = swarmManager.getAgent(command.agentId);
      if (targetAgent?.role === "worker") {
        await swarmManager.stopWorker(command.agentId);
        const profileId = resolveSessionProfileId(swarmManager, targetAgent.managerId);

        send(socket, {
          type: "session_stopped",
          agentId: command.agentId,
          profileId,
          terminatedWorkerIds: [],
          requestId: command.requestId
        });
      } else {
        const { terminatedWorkerIds } = await swarmManager.stopSession(command.agentId);
        const profileId = resolveSessionProfileId(swarmManager, command.agentId);
        if (terminatedWorkerIds.length > 0) {
          handleDeletedAgentSubscriptions(new Set(terminatedWorkerIds));
        }

        send(socket, {
          type: "session_stopped",
          agentId: command.agentId,
          profileId,
          terminatedWorkerIds,
          requestId: command.requestId
        });
      }
    } catch (error) {
      send(socket, {
        type: "error",
        code: "STOP_SESSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "resume_session") {
    try {
      // Check if target is a worker agent (supports stop/resume for workers too)
      const targetAgent = swarmManager.getAgent(command.agentId);
      if (targetAgent?.role === "worker") {
        await swarmManager.resumeWorker(command.agentId);
        const profileId = resolveSessionProfileId(swarmManager, targetAgent.managerId);

        send(socket, {
          type: "session_resumed",
          agentId: command.agentId,
          profileId,
          requestId: command.requestId
        });
      } else {
        await swarmManager.resumeSession(command.agentId);
        const profileId = resolveSessionProfileId(swarmManager, command.agentId);

        send(socket, {
          type: "session_resumed",
          agentId: command.agentId,
          profileId,
          requestId: command.requestId
        });
      }
    } catch (error) {
      send(socket, {
        type: "error",
        code: "RESUME_SESSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "archive_session") {
    try {
      requireNonSystemSessionProfile(command.agentId, swarmManager.listProfiles(), (agentId) => swarmManager.getAgent(agentId));
      const result = await swarmManager.archiveSession(command.agentId);
      if (result.terminatedWorkerIds.length > 0) {
        handleDeletedAgentSubscriptions(new Set(result.terminatedWorkerIds));
      }
      send(socket, {
        type: "session_archived",
        agentId: result.agentId,
        profileId: result.profileId,
        archivedAt: result.archivedAt,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: archiveErrorCode(error, "ARCHIVE_SESSION_FAILED"),
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "restore_session") {
    try {
      requireNonSystemSessionProfile(command.agentId, swarmManager.listProfiles(), (agentId) => swarmManager.getAgent(agentId));
      const result = await swarmManager.restoreSession(command.agentId);
      send(socket, {
        type: "session_restored",
        agentId: result.agentId,
        profileId: result.profileId,
        openAgentId: result.openAgentId,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: archiveErrorCode(error, "RESTORE_SESSION_FAILED"),
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "delete_session") {
    const profileId = resolveSessionProfileId(swarmManager, command.agentId);

    try {
      requireNonSystemSessionProfile(command.agentId, swarmManager.listProfiles(), (agentId) => swarmManager.getAgent(agentId));

      const { terminatedWorkerIds } = await swarmManager.deleteSession(command.agentId);
      handleDeletedAgentSubscriptions(new Set([command.agentId, ...terminatedWorkerIds]));
      unreadTracker?.clearSession(profileId, command.agentId);
      broadcastUnreadCountUpdate?.(command.agentId, 0);

      send(socket, {
        type: "session_deleted",
        agentId: command.agentId,
        profileId,
        terminatedWorkerIds,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "DELETE_SESSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "clear_session") {
    try {
      requireNonSystemSessionProfile(command.agentId, swarmManager.listProfiles(), (agentId) => swarmManager.getAgent(agentId));
      await swarmManager.clearSessionConversation(command.agentId);
      const profileId = resolveSessionProfileId(swarmManager, command.agentId);
      unreadTracker?.clearSession(profileId, command.agentId);
      broadcastUnreadCountUpdate?.(command.agentId, 0);

      send(socket, {
        type: "session_cleared",
        agentId: command.agentId,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "CLEAR_SESSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "rename_session") {
    try {
      requireNonSystemSessionProfile(command.agentId, swarmManager.listProfiles(), (agentId) => swarmManager.getAgent(agentId));
      await swarmManager.renameSession(command.agentId, command.label);

      send(socket, {
        type: "session_renamed",
        agentId: command.agentId,
        label: command.label,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "RENAME_SESSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "pin_session") {
    try {
      requireNonSystemSessionProfile(
        command.agentId,
        swarmManager.listProfiles(),
        (agentId) => swarmManager.getAgent(agentId),
      );

      const result = await swarmManager.pinSession(command.agentId, command.pinned);

      send(socket, {
        type: "session_pinned",
        agentId: command.agentId,
        pinned: command.pinned,
        pinnedAt: result.pinnedAt,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "PIN_SESSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "fork_session") {
    try {
      requireNonSystemSessionProfile(
        command.sourceAgentId,
        swarmManager.listProfiles(),
        (agentId) => swarmManager.getAgent(agentId),
      );

      const forked = await swarmManager.forkSession(command.sourceAgentId, {
        label: command.label,
        fromMessageId: command.fromMessageId,
        sessionPurpose: command.sessionPurpose
      });

      send(socket, {
        type: "session_forked",
        sourceAgentId: command.sourceAgentId,
        newSessionAgent: forked.sessionAgent,
        profile: forked.profile,
        fromMessageId: command.fromMessageId,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "FORK_SESSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  return false;
}

function archiveErrorCode(error: unknown, fallback: string): string {
  return error instanceof ArchiveOperationError ? error.code : fallback;
}

function resolveSessionProfileId(swarmManager: SwarmManager, sessionAgentId: string): string {
  return resolveProfileIdForSessionAgent(sessionAgentId, (agentId) => swarmManager.getAgent(agentId));
}
