import {
  validateChoiceAnswers,
  type ClientCommand,
  type ServerEvent,
} from "@forge/protocol";
import type { WebSocket } from "ws";
import type { SwarmManager } from "../../swarm/swarm-manager.js";

export interface ConversationCommandRouteContext<Connection = WebSocket> {
  command: ClientCommand;
  socket: Connection;
  subscribedAgentId: string;
  swarmManager: SwarmManager;
  allowNonManagerSubscriptions: boolean;
  send: (socket: Connection, event: ServerEvent) => void;
  logDebug: (message: string, details?: unknown) => void;
  resolveConfiguredManagerId: () => string | undefined;
}

export async function handleConversationCommand<Connection>(context: ConversationCommandRouteContext<Connection>): Promise<boolean> {
  const {
    command,
    socket,
    subscribedAgentId,
    swarmManager,
    allowNonManagerSubscriptions,
    send,
    logDebug,
    resolveConfiguredManagerId,
  } = context;

  if (command.type === "choice_response" || command.type === "choice_cancel") {
    const responseTargetAgentId = command.agentId;
    const { choiceId } = command;

    if (subscribedAgentId !== responseTargetAgentId) {
      logDebug("choice:rejected:subscription_mismatch", {
        choiceId,
        agentId: responseTargetAgentId,
        subscribedAgentId,
      });
      send(socket, {
        type: "error",
        code: "CHOICE_SUBSCRIPTION_MISMATCH",
        message: `Choice response rejected: not subscribed to agent ${responseTargetAgentId}`,
      });
      return true;
    }

    const pendingChoice = swarmManager.getPendingChoice(choiceId);
    if (!pendingChoice) {
      logDebug("choice:rejected:not_found", { choiceId });
      send(socket, {
        type: "error",
        code: "CHOICE_NOT_PENDING",
        message: `Choice ${choiceId} is not pending`,
      });
      return true;
    }

    if (!isChoiceResponseTargetAuthorized(responseTargetAgentId, pendingChoice)) {
      logDebug("choice:rejected:owner_mismatch", {
        choiceId,
        agentId: responseTargetAgentId,
        pendingOwner: pendingChoice,
      });
      send(socket, {
        type: "error",
        code: "CHOICE_OWNER_MISMATCH",
        message: `Choice ${choiceId} does not belong to agent ${responseTargetAgentId}`,
      });
      return true;
    }

    if (command.type === "choice_response") {
      const validationError = validateChoiceAnswers(pendingChoice.questions, command.answers);
      if (validationError) {
        logDebug("choice:rejected:invalid_response", {
          choiceId,
          agentId: responseTargetAgentId,
          validationError,
        });
        send(socket, {
          type: "error",
          code: "CHOICE_INVALID_RESPONSE",
          message: `Invalid choice response: ${validationError}`,
        });
        return true;
      }

      logDebug("choice_response:received", { choiceId, agentId: responseTargetAgentId });
      swarmManager.resolveChoiceRequest(choiceId, command.answers);
    } else {
      logDebug("choice_cancel:received", { choiceId, agentId: responseTargetAgentId });
      swarmManager.cancelChoiceRequest(choiceId, "cancelled");
    }
    return true;
  }

  if (command.type !== "user_message") {
    return false;
  }

  const managerId = resolveConfiguredManagerId();
  const targetAgentId = command.agentId ?? subscribedAgentId;

  logDebug("user_message:received", {
    subscribedAgentId,
    targetAgentId,
    managerId,
    requestedDelivery: command.delivery ?? "auto",
    textPreview: previewForLog(command.text),
    attachmentCount: command.attachments?.length ?? 0,
  });

  if (!allowNonManagerSubscriptions && managerId && targetAgentId !== managerId) {
    logDebug("user_message:rejected:subscription_not_supported", {
      targetAgentId,
      managerId,
    });
    send(socket, {
      type: "error",
      code: "SUBSCRIPTION_NOT_SUPPORTED",
      message: `Messages are currently limited to ${managerId}.`,
    });
    return true;
  }

  const targetDescriptor = swarmManager.getAgent(targetAgentId);
  if (!targetDescriptor) {
    logDebug("user_message:rejected:unknown_agent", {
      targetAgentId,
    });
    send(socket, {
      type: "error",
      code: "UNKNOWN_AGENT",
      message: `Agent ${targetAgentId} does not exist.`,
    });
    return true;
  }

  try {
    if (targetDescriptor.role === "manager" && command.text.trim() === "/new") {
      logDebug("user_message:manager_reset", {
        targetAgentId: targetDescriptor.agentId,
      });
      await swarmManager.resetManagerSession(targetDescriptor.agentId, "user_new_command");
      return true;
    }

    logDebug("user_message:dispatch:start", {
      targetAgentId,
      targetRole: targetDescriptor.role,
      persistedAttachmentCount: command.attachments?.length ?? 0,
    });

    await swarmManager.handleUserMessage(command.text, {
      targetAgentId,
      delivery: command.delivery,
      attachments: command.attachments,
      replyTo: command.replyTo,
      sourceContext: { channel: "web" },
      clientRequestId: command.clientRequestId,
      sessionReferenceAgentIds: command.sessionReferenceAgentIds,
    });

    logDebug("user_message:dispatch:complete", {
      targetAgentId,
      targetRole: targetDescriptor.role,
    });
  } catch (error) {
    logDebug("user_message:dispatch:error", {
      targetAgentId,
      targetRole: targetDescriptor.role,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    send(socket, {
      type: "error",
      code: "USER_MESSAGE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return true;
}

function previewForLog(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}…`;
}

function isChoiceResponseTargetAuthorized(
  responseTargetAgentId: string,
  pendingChoice: { agentId: string; sessionAgentId: string },
): boolean {
  return (
    responseTargetAgentId === pendingChoice.sessionAgentId ||
    responseTargetAgentId === pendingChoice.agentId
  );
}
