import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { ChoiceSummarySchema, decodeEnvironmentValue } from "@forge/protocol/environment-v2";
import type { Static } from "@sinclair/typebox";
import type { CoreState, Request, Thread } from "./types.js";

export function requestChoiceId(requestId: string): string {
  return requestId.length <= 128 ? requestId : `request-${createHash("sha256").update(requestId).digest("hex")}`;
}
export function requestForChoice(state: CoreState, choiceId: string): Request | undefined {
  return state.requests[choiceId] ?? Object.values(state.requests).find(request => requestChoiceId(request.requestId) === choiceId);
}
export function requestChoice(request: Request): Static<typeof ChoiceSummarySchema> | undefined {
  const payload = request.payload as { questions?: unknown } | null;
  return decodeEnvironmentValue(ChoiceSummarySchema, { choiceId: requestChoiceId(request.requestId), agentId: request.threadId,
    status: request.state === "responding" ? "pending" : request.state === "resolved" ? "answered" : request.state,
    questions: payload?.questions });
}
export function requestSession(thread: Thread): string { return thread.role === "worker" ? thread.managerId! : thread.threadId; }

/** A disposable read projection of retained request facts, never a callback owner. */
export function projectRequestChoice(database: Database, request: Request): void {
  const choice = requestChoice(request);
  const row = database.prepare("SELECT state_json FROM orchestration_threads WHERE thread_id=?").get(request.threadId) as { state_json: string } | undefined;
  if (!choice || !row) return;
  database.prepare(`INSERT INTO control_choices (choice_id,session_id,runtime_generation,state,choice_json,updated_sequence) VALUES (?,?,?,?,?,0)
    ON CONFLICT(choice_id) DO UPDATE SET state=excluded.state,choice_json=excluded.choice_json,answer_command_id=CASE WHEN ? THEN NULL ELSE control_choices.answer_command_id END`)
    .run(choice.choiceId, requestSession(JSON.parse(row.state_json)), `${request.ref.bindingId}:${request.ref.generation}`, choice.status, JSON.stringify(choice), request.state === "pending" ? 1 : 0);
}
