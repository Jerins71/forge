import { parseConversationAttachments } from "../attachment-parser.js";
import { parseConversationReplyTargetInput } from "../../swarm/conversation-reply.js";
import {
  fail,
  isValidChoiceAnswer,
  ok,
  type ClientCommandCandidate,
  type ParsedClientCommand
} from "./command-parse-helpers.js";

export function parseConversationCommand(maybe: ClientCommandCandidate): ParsedClientCommand | undefined {
  if (maybe.type === "user_message") {
    if (typeof maybe.text !== "string") {
      return fail("user_message.text must be a string");
    }

    const normalizedText = maybe.text.trim();
    const parsedAttachments = parseConversationAttachments(
      (maybe as { attachments?: unknown }).attachments,
      "user_message.attachments"
    );
    if (!parsedAttachments.ok) {
      return fail(parsedAttachments.error);
    }

    if (!normalizedText && parsedAttachments.attachments.length === 0) {
      return fail("user_message must include non-empty text or at least one attachment");
    }

    if (maybe.agentId !== undefined && typeof maybe.agentId !== "string") {
      return fail("user_message.agentId must be a string when provided");
    }

    if (
      maybe.delivery !== undefined &&
      maybe.delivery !== "auto" &&
      maybe.delivery !== "followUp" &&
      maybe.delivery !== "steer"
    ) {
      return fail("user_message.delivery must be one of auto|followUp|steer");
    }

    const replyTo = parseConversationReplyTargetInput((maybe as { replyTo?: unknown }).replyTo);

    const clientRequestId = (maybe as { clientRequestId?: unknown }).clientRequestId;
    if (clientRequestId !== undefined && (typeof clientRequestId !== "string" || clientRequestId.length === 0 || clientRequestId.length > 128)) {
      return fail("user_message.clientRequestId must be a non-empty string of at most 128 characters when provided");
    }

    const sessionReferenceAgentIds = (maybe as { sessionReferenceAgentIds?: unknown }).sessionReferenceAgentIds;
    if (
      sessionReferenceAgentIds !== undefined &&
      (!Array.isArray(sessionReferenceAgentIds) ||
        sessionReferenceAgentIds.length > 20 ||
        !sessionReferenceAgentIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256))
    ) {
      return fail("user_message.sessionReferenceAgentIds must be an array of at most 20 non-empty agent ids when provided");
    }

    return ok({
      type: "user_message",
      text: normalizedText,
      attachments: parsedAttachments.attachments.length > 0 ? parsedAttachments.attachments : undefined,
      agentId: maybe.agentId,
      delivery: maybe.delivery,
      replyTo,
      clientRequestId,
      sessionReferenceAgentIds: sessionReferenceAgentIds?.length ? sessionReferenceAgentIds : undefined,
    });
  }

  if (maybe.type === "choice_response") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const choiceId = (maybe as { choiceId?: unknown }).choiceId;
    const answers = (maybe as { answers?: unknown }).answers;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("choice_response.agentId must be a non-empty string");
    }
    if (typeof choiceId !== "string" || choiceId.trim().length === 0) {
      return fail("choice_response.choiceId must be a non-empty string");
    }
    if (!Array.isArray(answers) || !answers.every(isValidChoiceAnswer)) {
      return fail("choice_response.answers must be an array of valid ChoiceAnswer objects");
    }

    return ok({
      type: "choice_response",
      agentId: agentId.trim(),
      choiceId: choiceId.trim(),
      answers,
    });
  }

  if (maybe.type === "choice_cancel") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const choiceId = (maybe as { choiceId?: unknown }).choiceId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("choice_cancel.agentId must be a non-empty string");
    }
    if (typeof choiceId !== "string" || choiceId.trim().length === 0) {
      return fail("choice_cancel.choiceId must be a non-empty string");
    }

    return ok({
      type: "choice_cancel",
      agentId: agentId.trim(),
      choiceId: choiceId.trim(),
    });
  }





  return undefined;
}
