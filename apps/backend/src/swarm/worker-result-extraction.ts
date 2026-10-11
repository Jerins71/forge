import type { ActivitySummaryEvent } from "@forge/protocol";
import type { ConversationEntryEvent, ConversationMessageEvent } from "./types.js";

const MAX_WORKER_RESULT_CHARS = 16_000;

/** Select only the terminal run's canonical range, never another assignment's latest text. */
export function selectWorkerRunFinal(history: ConversationEntryEvent[], runId: string, inputEntryId: string): ConversationMessageEvent | undefined {
  const start = history.findIndex(entry => entry.type === "conversation_message" && entry.id === inputEntryId);
  const candidates = start < 0 ? history.filter(entry => entry.type === "conversation_message" && entry.turnId === runId) : history.slice(start + 1);
  let final: ConversationMessageEvent | undefined;
  for (const entry of candidates) {
    if (entry.type !== "conversation_message") continue;
    if (entry.role === "user" && entry.turnId !== runId) break;
    if (entry.turnId && entry.turnId !== runId) continue;
    if (entry.id && (entry.role === "assistant" || (entry.role === "system" && looksLikeWorkerError(entry))) && entry.source !== "worker_report" && (entry.text.trim() || entry.attachments?.length)) final = entry;
  }
  return final;
}

type FailedStatusRow = ActivitySummaryEvent & { timelineEntryId: string };

/**
 * The run's failed status row: what the worker shows when its provider failed without leaving a reply.
 * It names the provider and model, so it is the result the manager reads instead of "returned nothing".
 */
export function selectWorkerRunFailure(history: ConversationEntryEvent[], runId: string, inputEntryId: string): FailedStatusRow | undefined {
  const start = history.findIndex(entry => entry.type === "conversation_message" && entry.id === inputEntryId);
  let failure: FailedStatusRow | undefined;
  for (const entry of start < 0 ? history : history.slice(start + 1)) {
    if (entry.type === "conversation_message" && entry.role === "user" && entry.turnId !== runId) { if (start >= 0) break; continue; }
    if (entry.type !== "activity_summary" || entry.turnId !== runId) continue;
    if (entry.status === "failed" && entry.activity?.kind === "status" && entry.timelineEntryId) failure = entry as FailedStatusRow;
  }
  return failure;
}

export function buildWorkerFailureResult(workerAgentId: string, failure: Pick<ActivitySummaryEvent, "displaySummary">): string {
  return truncateWorkerResult([
    "status: blocked",
    `summary: Worker ${workerAgentId} failed: ${failure.displaySummary.replace(/^Failed:\s*/, "")}`,
    "follow-up: Check the worker or retry the assignment.",
  ].join("\n"));
}

export function buildWorkerResult(workerAgentId: string, finalMessage?: ConversationMessageEvent): string {
  if (!finalMessage) {
    return [
      "status: blocked",
      `summary: Worker ${workerAgentId} settled without returning a final result.`,
      "follow-up: Check the worker or retry the assignment.",
    ].join("\n");
  }

  const rawText = finalMessage.text.trim();
  const lines = /^status:\s*(?:done|partial|blocked)(?:\s|$)/i.test(rawText)
    ? [rawText]
    : [
        `status: ${looksLikeWorkerError(finalMessage) ? "blocked" : "done"}`,
        "summary:",
        rawText.length > 0
          ? rawText
          : `Worker ${workerAgentId} completed without a final text result.`,
      ];
  const attachmentCount = finalMessage.attachments?.length ?? 0;
  if (attachmentCount > 0) {
    lines.push(
      "",
      `attachments: ${attachmentCount} generated attachment${attachmentCount === 1 ? "" : "s"}`,
    );
  }
  return truncateWorkerResult(lines.join("\n"));
}

function looksLikeWorkerError(message: ConversationMessageEvent): boolean {
  return (
    message.role === "system" &&
    /^(?:⚠️\s*)?(?:worker\b.*\b(?:failed|blocked|terminated|timed out)\b|(?:agent|runtime|compaction|context guard|extension) error\b|error:)/i.test(
      message.text.trim(),
    )
  );
}

function truncateWorkerResult(text: string): string {
  if (text.length <= MAX_WORKER_RESULT_CHARS) {
    return text;
  }
  const marker = "\n\n[worker result truncated]";
  return `${text.slice(0, MAX_WORKER_RESULT_CHARS - marker.length).trimEnd()}${marker}`;
}
