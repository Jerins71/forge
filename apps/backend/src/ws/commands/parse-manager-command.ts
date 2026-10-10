import {
  fail,
  ok,
  type ClientCommandCandidate,
  type ParsedClientCommand
} from "./command-parse-helpers.js";

export function parseManagerCommand(maybe: ClientCommandCandidate): ParsedClientCommand | undefined {
  if (maybe.type === "kill_agent") {
    if (typeof maybe.agentId !== "string" || maybe.agentId.trim().length === 0) {
      return fail("kill_agent.agentId must be a non-empty string");
    }

    return ok({
      type: "kill_agent",
      agentId: maybe.agentId.trim()
    });
  }

  if (maybe.type === "stop_all_agents") {
    const managerId = (maybe as { managerId?: unknown }).managerId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof managerId !== "string" || managerId.trim().length === 0) {
      return fail("stop_all_agents.managerId must be a non-empty string");
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("stop_all_agents.requestId must be a string when provided");
    }

    return ok({
      type: "stop_all_agents",
      managerId: managerId.trim(),
      requestId
    });
  }

  if (maybe.type === "hydrate_archive_last_used") {
    const requestId = (maybe as { requestId?: unknown }).requestId;
    if (requestId !== undefined && typeof requestId !== "string") {
      return fail("hydrate_archive_last_used.requestId must be a string when provided");
    }

    return ok({
      type: "hydrate_archive_last_used",
      requestId
    });
  }

  return undefined;
}
