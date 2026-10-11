import { validateChoiceAnswers, type ChoiceRequestEvent } from "@forge/protocol";
import type { Database } from "better-sqlite3";
import { ControlError, type EnvironmentControlService } from "../command-service.js";
import type { CoreChoicePort } from "../../../swarm/swarm-choice-service.js";
import { loadState } from "./store.js";
import { requestChoice, requestForChoice, requestSession } from "./request-projection.js";

/** Existing facade reads and controls delegate to the retained request owner. */
export function createCoreChoicePort({ database, controlService, clock, random }: {
  database: Database; controlService: EnvironmentControlService; clock: () => number; random: () => string;
}): CoreChoicePort {
  return {
    pending() {
      const state = loadState(database);
      return Object.values(state.requests).flatMap(request => {
        const choice = requestChoice(request);
        if (request.state !== "pending" || !choice) return [];
        const event = database.prepare("SELECT created_at FROM lifecycle_events WHERE event_type='request.opened' AND json_extract(event_json,'$.request.requestId')=? ORDER BY sequence DESC LIMIT 1").get(request.requestId) as { created_at: number };
        return [{ type: "choice_request", ...choice, status: "pending" as const, sessionAgentId: requestSession(state.threads[request.threadId]), timestamp: new Date(event.created_at).toISOString() } satisfies ChoiceRequestEvent];
      });
    },
    respond(choiceId, answers) {
      const state = loadState(database); const request = requestForChoice(state, choiceId);
      if (!request) return false;
      if (request.state !== "pending") throw new ControlError("CONFLICT", "Provider request is no longer pending");
      const choice = requestChoice(request);
      const invalid = choice ? validateChoiceAnswers(choice.questions, answers) : "Provider questions are unavailable";
      if (invalid) throw new ControlError("INVALID_INPUT", invalid);
      const owner = state.threads[request.threadId];
      if (owner.desired !== "running" || owner.generation !== request.lifetime.generation || (request.lifetime.expiresAt && Date.parse(request.lifetime.expiresAt) <= clock())) {
        controlService.record({ type: "request.expire", commandId: `choice:${random()}`, now: clock(), threadId: request.threadId, requestId: request.requestId });
        throw new ControlError("CONFLICT", "Provider request expired");
      }
      controlService.record({ type: "request.respond", commandId: `choice:${random()}`, now: clock(), threadId: request.threadId, requestId: request.requestId, response: answers }); return true;
    },
    cancel(choiceId, reason) {
      const request = requestForChoice(loadState(database), choiceId);
      if (!request) return false;
      controlService.record({ type: reason === "expired" ? "request.expire" : "request.cancel", commandId: `choice:${random()}`, now: clock(), threadId: request.threadId, requestId: request.requestId }); return true;
    },
  };
}
