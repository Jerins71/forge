import {
  fail,
  ok,
  type ClientCommandCandidate,
  type ParsedClientCommand
} from "./command-parse-helpers.js";

export const MAX_CONVERSATION_PAGE_CURSOR_LENGTH = 4_096;

export function parseSessionCommand(maybe: ClientCommandCandidate): ParsedClientCommand | undefined {
  if (maybe.type === "create_session") {
    const profileId = (maybe as { profileId?: unknown }).profileId;
    const label = (maybe as { label?: unknown }).label;
    const name = (maybe as { name?: unknown }).name;
    const sessionPurpose = (maybe as { sessionPurpose?: unknown }).sessionPurpose;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof profileId !== "string" || profileId.trim().length === 0) {
      return fail("create_session.profileId must be a non-empty string");
    }
    if (label !== undefined && typeof label !== "string") {
      return fail("create_session.label must be a string when provided");
    }
    if (name !== undefined && typeof name !== "string") {
      return fail("create_session.name must be a string when provided");
    }
    if (sessionPurpose !== undefined && sessionPurpose !== "agent_creator") {
      return fail('create_session.sessionPurpose must be "agent_creator" when provided');
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("create_session.requestId must be a string when provided");
    }

    const normalizedLabel = label?.trim();
    const normalizedName = name?.trim();

    return ok({
      type: "create_session",
      profileId: profileId.trim(),
      label: normalizedLabel ? normalizedLabel : undefined,
      name: normalizedName ? normalizedName : undefined,
      sessionPurpose,
      requestId
    });
  }

  if (maybe.type === "stop_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("stop_session.agentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("stop_session.requestId must be a string when provided");
    }

    return ok({
      type: "stop_session",
      agentId: agentId.trim(),
      requestId
    });
  }

  if (maybe.type === "resume_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("resume_session.agentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("resume_session.requestId must be a string when provided");
    }

    return ok({
      type: "resume_session",
      agentId: agentId.trim(),
      requestId
    });
  }

  if (maybe.type === "archive_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("archive_session.agentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("archive_session.requestId must be a string when provided");
    }

    return ok({
      type: "archive_session",
      agentId: agentId.trim(),
      requestId
    });
  }

  if (maybe.type === "restore_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("restore_session.agentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("restore_session.requestId must be a string when provided");
    }

    return ok({
      type: "restore_session",
      agentId: agentId.trim(),
      requestId
    });
  }

  if (maybe.type === "delete_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("delete_session.agentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("delete_session.requestId must be a string when provided");
    }

    return ok({
      type: "delete_session",
      agentId: agentId.trim(),
      requestId
    });
  }

  if (maybe.type === "clear_session") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("clear_session.agentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("clear_session.requestId must be a string when provided");
    }

    return ok({
      type: "clear_session",
      agentId: agentId.trim(),
      requestId
    });
  }



  if (maybe.type === "fork_session") {
    const sourceAgentId = (maybe as { sourceAgentId?: unknown }).sourceAgentId;
    const label = (maybe as { label?: unknown }).label;
    const fromMessageId = (maybe as { fromMessageId?: unknown }).fromMessageId;
    const sessionPurpose = (maybe as { sessionPurpose?: unknown }).sessionPurpose;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof sourceAgentId !== "string" || sourceAgentId.trim().length === 0) {
      return fail("fork_session.sourceAgentId must be a non-empty string");
    }
    if (sessionPurpose !== undefined && sessionPurpose !== "side_chat") {
      return fail('fork_session.sessionPurpose must be "side_chat" when provided');
    }
    if (label !== undefined && typeof label !== "string") {
      return fail("fork_session.label must be a string when provided");
    }
    if (fromMessageId !== undefined && typeof fromMessageId !== "string") {
      return fail("fork_session.fromMessageId must be a string when provided");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("fork_session.requestId must be a string when provided");
    }

    const normalizedLabel = label?.trim();
    const normalizedFromMessageId = fromMessageId?.trim();

    return ok({
      type: "fork_session",
      sourceAgentId: sourceAgentId.trim(),
      label: normalizedLabel ? normalizedLabel : undefined,
      fromMessageId: normalizedFromMessageId ? normalizedFromMessageId : undefined,
      ...(sessionPurpose ? { sessionPurpose } : {}),
      requestId
    });
  }

  if (maybe.type === "get_session_workers") {
    const sessionAgentId = (maybe as { sessionAgentId?: unknown }).sessionAgentId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof sessionAgentId !== "string" || sessionAgentId.trim().length === 0) {
      return fail("get_session_workers.sessionAgentId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("get_session_workers.requestId must be a string when provided");
    }

    return ok({
      type: "get_session_workers",
      sessionAgentId: sessionAgentId.trim(),
      requestId
    });
  }

  if (maybe.type === "get_conversation_page") {
    const agentId = (maybe as { agentId?: unknown }).agentId;
    const cursor = (maybe as { cursor?: unknown }).cursor;
    const limit = (maybe as { limit?: unknown }).limit;
    const view = (maybe as { view?: unknown }).view;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return fail("get_conversation_page.agentId must be a non-empty string");
    }
    if (typeof cursor !== "string" || cursor.trim().length === 0) {
      return fail("get_conversation_page.cursor must be a non-empty string");
    }
    if (cursor.trim().length > MAX_CONVERSATION_PAGE_CURSOR_LENGTH) {
      return fail(`get_conversation_page.cursor must be at most ${MAX_CONVERSATION_PAGE_CURSOR_LENGTH} characters`);
    }
    if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) <= 0 || (limit as number) > 500)) {
      return fail("get_conversation_page.limit must be an integer from 1 to 500 when provided");
    }
    if (view !== undefined && view !== "web" && view !== "all") {
      return fail("get_conversation_page.view must be web or all when provided");
    }
    if (typeof requestId !== "string" || requestId.trim().length === 0) {
      return fail("get_conversation_page.requestId must be a non-empty string");
    }

    return ok({
      type: "get_conversation_page",
      agentId: agentId.trim(),
      cursor: cursor.trim(),
      limit: limit as number | undefined,
      ...(view ? { view } : {}),
      requestId: requestId.trim(),
    });
  }

  return undefined;
}
