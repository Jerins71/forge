import {
  isManagerPosture,
  type ClientCommand,
  type ManagerPosture,
  type ServerEvent,
} from "@forge/protocol";
import type { WebSocket } from "ws";
import { ArchiveOperationError } from "../../swarm/archive/archive-service.js";
import { inferSwarmModelPresetFromDescriptor, parseSwarmModelPreset } from "../../swarm/catalog/model-presets.js";
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
  supportsGoalControlRequestId?: boolean;
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
    supportsGoalControlRequestId = false,
  } = context;

  if (
    command.type !== "create_session" &&
    command.type !== "stop_session" &&
    command.type !== "resume_session" &&
    command.type !== "archive_session" &&
    command.type !== "restore_session" &&
    command.type !== "delete_session" &&
    command.type !== "clear_session" &&
    command.type !== "session_goal_control" &&
    command.type !== "rename_session" &&
    command.type !== "pin_session" &&
    command.type !== "update_session_model" &&
    command.type !== "update_session_delegation" &&
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
      requestId: command.type === "session_goal_control" && !supportsGoalControlRequestId
        ? undefined
        : "requestId" in command ? command.requestId : undefined
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

  if (command.type === "session_goal_control") {
    const responseRequestId = supportsGoalControlRequestId ? command.requestId : undefined;
    try {
      requireNonSystemSessionProfile(
        command.agentId,
        swarmManager.listProfiles(),
        (agentId) => swarmManager.getAgent(agentId),
      );
      // Capture the origin-scoped response context before control yields. Subscription and
      // capability state may change on this socket while the domain operation is in flight.
      const responseContext = responseRequestId === undefined
        ? undefined
        : {
            socket,
            requestId: responseRequestId,
            sessionAgentId: command.agentId,
            profileId: resolveSessionProfileId(swarmManager, command.agentId),
          };
      const snapshot = await swarmManager.controlSessionGoal(command.agentId, command);
      if (responseContext) {
        send(responseContext.socket, {
          type: "session_goal_snapshot",
          sessionAgentId: responseContext.sessionAgentId,
          profileId: responseContext.profileId,
          ...snapshot,
          requestId: responseContext.requestId,
        });
      }
    } catch (error) {
      send(socket, {
        type: "error",
        code: "SESSION_GOAL_CONTROL_FAILED",
        message: error instanceof Error ? error.message : String(error),
        ...(responseRequestId === undefined ? {} : { requestId: responseRequestId }),
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

  if (command.type === "update_session_model") {
    try {
      requireNonSystemSessionProfile(
        command.sessionAgentId,
        swarmManager.listProfiles(),
        (agentId) => swarmManager.getAgent(agentId),
      );

      const canonicalPreset = command.mode === "override" && !command.modelSelection
        ? parseSwarmModelPreset(command.model, "update_session_model.model")
        : undefined;
      // Exact selections without a catalog preset family (discovered OpenRouter models) omit `model`.
      const eventModel = command.mode === "inherit"
        ? undefined
        : command.modelSelection
          ? inferEventModelPreset(
              await swarmManager.updateSessionExactModel(
                command.sessionAgentId,
                command.modelSelection,
                command.reasoningLevel,
              )
            )
          : canonicalPreset;

      if (command.mode === "override" && !command.modelSelection) {
        await swarmManager.updateSessionModel(
          command.sessionAgentId,
          command.mode,
          canonicalPreset,
          command.reasoningLevel,
        );
      }

      if (command.mode === "inherit") {
        await swarmManager.updateSessionModel(
          command.sessionAgentId,
          command.mode,
          undefined,
          undefined,
        );
      }

      send(socket, {
        type: "session_model_updated",
        sessionAgentId: command.sessionAgentId,
        mode: command.mode,
        model: eventModel,
        reasoningLevel: command.reasoningLevel,
        requestId: command.requestId,
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "UPDATE_SESSION_MODEL_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId,
      });
    }

    return true;
  }

  if (command.type === "update_session_delegation") {
    try {
      requireNonSystemSessionProfile(
        command.sessionAgentId,
        swarmManager.listProfiles(),
        (agentId) => swarmManager.getAgent(agentId),
      );
      let postureUpdate: { mode: "inherit" } | { mode: "override"; value: ManagerPosture } | undefined;
      if (command.managerPosture?.mode === "inherit") {
        postureUpdate = command.managerPosture;
      } else if (command.managerPosture?.mode === "override") {
        if (!isManagerPosture(command.managerPosture.value)) {
          send(socket, {
            type: "error",
            code: "UPDATE_SESSION_DELEGATION_FAILED",
            message: 'managerPosture override must be "delegation_first", "adaptive", or "hands_on"',
            requestId: command.requestId,
          });
          return true;
        }
        postureUpdate = { mode: "override", value: command.managerPosture.value };
      }
      await swarmManager.updateSessionDelegation(command.sessionAgentId, {
        ...(postureUpdate ? { managerPosture: postureUpdate } : {}),
        ...(command.delegationRoster
          ? { delegationRoster: command.delegationRoster }
          : {}),
      });
      const session = swarmManager.getAgent(command.sessionAgentId);
      if (
        !session?.managerPosture
        || !session.managerPostureOrigin
        || !session.delegationRosterId
        || !session.delegationRosterOrigin
      ) {
        throw new Error("Session delegation state was not persisted.");
      }
      send(socket, {
        type: "session_delegation_updated",
        sessionAgentId: command.sessionAgentId,
        managerPosture: session.managerPosture,
        managerPostureOrigin: session.managerPostureOrigin,
        delegationRosterId: session.delegationRosterId,
        delegationRosterOrigin: session.delegationRosterOrigin,
        requestId: command.requestId,
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "UPDATE_SESSION_DELEGATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId,
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

function inferEventModelPreset(descriptor: { provider: string; modelId: string }): string | undefined {
  return inferSwarmModelPresetFromDescriptor(descriptor);
}
