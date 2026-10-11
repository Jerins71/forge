import {
  ACTIVITY_DETAIL_MAX_CHARS,
  ACTIVITY_INPUT_MAX_CHARS,
  ACTIVITY_LIVE_MESSAGE_MAX_CHARS,
  ACTIVITY_SUMMARY_MAX_CHARS,
  type PersistedActivityDetail,
  type TimelineActivity,
  type TimelineActivityKind,
} from "@forge/protocol";
import type { AgentToolCallEvent } from "../types.js";

const MAX_TRACKED_ITEMS = 256;
/** Output deltas within this window coalesce into one live upsert per row. */
const LIVE_UPDATE_INTERVAL_MS = 80;
/** Reports of one turn failure arrive together; a later failure is a new one. */
const FAILURE_REPORT_WINDOW_MS = 10_000;

export interface ProviderTextFact {
  channel: "assistant" | "reasoning";
  /** Agent that is thinking or replying; its manager's session shows the row. */
  actorId: string;
  sessionId: string;
  nativeId: string;
  phase: "start" | "delta" | "complete";
  text: string;
  runId?: string;
  timestamp: string;
}

interface Tracked { item: TimelineActivity; streamed: boolean; publishedAt: number; timer?: ReturnType<typeof setTimeout> }

/**
 * Owns the live state of tool and reasoning rows. Every row is one bounded
 * `TimelineActivity`; live publication and the persisted summary read the same item.
 */
export class ActivityTimelineTracker {
  private readonly items = new Map<string, Tracked>();
  /** The open status row of each actor's current turn, and the retries it has counted. */
  private readonly status = new Map<string, Tracked>();
  private readonly attempts = new Map<string, number>();
  private readonly failedAt = new Map<string, { at: number; runId?: string }>();

  constructor(private readonly publish: (item: TimelineActivity) => void, private readonly now: () => number = Date.now) {}

  /** Folds one tool lifecycle event into its row; completed rows stay available for the canonical summary. */
  observeTool(event: AgentToolCallEvent): TimelineActivity | undefined {
    const callId = event.toolCallId?.trim();
    if (!callId) return undefined;
    const itemId = toolActivityItemId(event.actorAgentId, callId);
    let tracked = this.items.get(itemId);
    const payload = parsePayload(event.text);
    if (!tracked) {
      // An update or end without a start still gets a row; it has no arguments to summarize.
      const input = event.kind === "tool_execution_start" ? payload : undefined;
      const kind = classifyToolKind(event.toolName);
      tracked = this.track({
        itemId, sessionId: event.agentId, actorId: event.actorAgentId, ...(event.turnId ? { runId: event.turnId } : {}),
        kind, status: "running", startedAt: event.timestamp, summary: summarizeTool(kind, event.toolName, input),
        ...(event.toolName ? { toolName: event.toolName.slice(0, 128) } : {}),
        ...bounded("input", describeInput(kind, input), "head"),
      });
    }
    const item = tracked.item;
    if (item.status !== "running") return item;
    if (event.kind === "tool_execution_update") {
      const text = resultText(payload);
      if (text) {
        // Codex reports each output delta as `{ output }`; other runtimes report the output so far.
        const next = isOutputDelta(payload) ? (item.detail ?? "") + text : text;
        tracked.streamed = true;
        Object.assign(item, bounded("detail", next, "tail"));
      }
      this.publishSoon(tracked);
    } else if (event.kind === "tool_execution_end") {
      const text = resultText(payload);
      // Streamed output is fuller than a final preview; keep it when the result adds nothing longer.
      if (text && !(tracked.streamed && (item.detail?.length ?? 0) >= text.length)) Object.assign(item, bounded("detail", text, "tail"));
      const exitCode = readExitCode(payload);
      if (exitCode !== undefined) item.exitCode = exitCode;
      item.status = event.isError ? "failed" : "completed";
      item.completedAt = event.timestamp;
      this.publishNow(tracked);
    } else this.publishNow(tracked);
    return item;
  }

  /**
   * Streams reasoning or reply text into its row. Returns the finished reasoning row to persist,
   * once, when its provider item completes; a reply row is never persisted.
   */
  observeText(fact: ProviderTextFact): TimelineActivity | undefined {
    const reply = fact.channel === "assistant";
    const itemId = `${reply ? "message" : "reasoning"}:${fact.actorId}:${fact.nativeId}`;
    let tracked = this.items.get(itemId);
    if (tracked && tracked.item.status !== "running") return undefined;
    // A reply item with no text yet, such as one that only calls tools, has nothing to show.
    if (!tracked && reply && !fact.text) return undefined;
    tracked ??= this.track({
      itemId, sessionId: fact.sessionId, actorId: fact.actorId, ...(fact.runId ? { runId: fact.runId } : {}),
      kind: reply ? "message" : "reasoning", status: "running", startedAt: fact.timestamp, summary: reply ? "" : "Thinking…",
    });
    const item = tracked.item;
    // A completed provider item carries the whole text; deltas extend what has streamed so far.
    const text = fact.phase === "delta" ? (item.detail ?? "") + fact.text : fact.text || item.detail || "";
    if (text) {
      delete item.truncated;
      Object.assign(item, text.length > (reply ? ACTIVITY_LIVE_MESSAGE_MAX_CHARS : ACTIVITY_DETAIL_MAX_CHARS)
        ? { detail: text.slice(0, reply ? ACTIVITY_LIVE_MESSAGE_MAX_CHARS : ACTIVITY_DETAIL_MAX_CHARS), truncated: true } : { detail: text });
      item.summary = firstLine(text) || (reply ? "" : "Thinking…");
    }
    if (fact.phase !== "complete") { this.publishSoon(tracked); return undefined; }
    if (!reply) return this.finishReasoning(tracked, fact.timestamp);
    item.status = "completed"; item.completedAt = fact.timestamp;
    this.publishNow(tracked);
    return undefined;
  }

  /** One status row per turn, updated in place while the provider retries a failing request. */
  observeRetry(fact: { actorId: string; sessionId: string; attempt: number; message: string; runId?: string; timestamp: string }): void {
    this.failedAt.delete(fact.actorId);
    const tracked = this.statusRow(fact);
    const message = oneLine(fact.message);
    Object.assign(tracked.item, bounded("detail", `Attempt ${fact.attempt}\n${fact.message}`, "head"));
    tracked.item.summary = `Retrying: ${message} (attempt ${fact.attempt})`.slice(0, ACTIVITY_SUMMARY_MAX_CHARS);
    this.attempts.set(tracked.item.itemId, fact.attempt);
    this.publishNow(tracked);
  }

  /**
   * Ends the turn's open rows: reasoning an interrupt left running, and the status row, which
   * fails with the provider error or records the retries the turn recovered from.
   */
  settleTurn(fact: { actorId: string; sessionId: string; error?: string; stopped?: boolean; runId?: string; timestamp: string }): TimelineActivity[] {
    const finished: TimelineActivity[] = [];
    for (const tracked of this.items.values()) {
      if (tracked.item.actorId !== fact.actorId || tracked.item.status !== "running") continue;
      if (tracked.item.kind === "reasoning") finished.push(this.finishReasoning(tracked, fact.timestamp));
      // A reply the turn left open is over; its row ends without being persisted.
      else if (tracked.item.kind === "message") { tracked.item.status = "completed"; tracked.item.completedAt = fact.timestamp; this.publishNow(tracked); }
    }
    const open = this.status.get(fact.actorId);
    if (!open && !fact.error) return finished;
    // The adapter and the runtime can both report one failure; the first report is the row.
    if (fact.error && this.hasRecentFailure(fact.actorId, fact.runId)) return finished;
    if (fact.error) this.failedAt.set(fact.actorId, { at: this.now(), runId: fact.runId });
    const tracked = open ?? this.statusRow(fact);
    const item = tracked.item;
    const attempts = this.attempts.get(item.itemId);
    this.status.delete(fact.actorId); this.attempts.delete(item.itemId);
    if (fact.error) {
      item.status = "failed";
      item.summary = `Failed: ${readableProviderError(fact.error)}${attempts ? ` (after ${attempts} ${attempts === 1 ? "retry" : "retries"})` : ""}`.slice(0, ACTIVITY_SUMMARY_MAX_CHARS);
      Object.assign(item, bounded("detail", `${attempts ? `Retried ${attempts} ${attempts === 1 ? "time" : "times"}\n` : ""}${fact.error}`, "head"));
    } else {
      item.status = "completed";
      item.summary = `${fact.stopped ? "Stopped" : "Recovered"} after ${attempts} ${attempts === 1 ? "retry" : "retries"}: ${oneLine((item.detail ?? "").split("\n").slice(1).join(" "))}`.slice(0, ACTIVITY_SUMMARY_MAX_CHARS);
    }
    item.completedAt = fact.timestamp;
    this.publishNow(tracked);
    finished.push(item);
    return finished;
  }

  /** The failure is already in the transcript; a later report of it for the same turn adds nothing. */
  noteFailureReported(actorId: string, runId?: string): void {
    this.failedAt.set(actorId, { at: this.now(), runId });
  }

  /** A failure already reported for this actor's turn. A known different run is always a new failure. */
  hasRecentFailure(actorId: string, runId?: string): boolean {
    const last = this.failedAt.get(actorId);
    if (!last || this.now() - last.at >= FAILURE_REPORT_WINDOW_MS) return false;
    return !runId || !last.runId || runId === last.runId;
  }

  private statusRow(fact: { actorId: string; sessionId: string; runId?: string; timestamp: string }): Tracked {
    let tracked = this.status.get(fact.actorId);
    if (!tracked) {
      tracked = this.track({
        itemId: `status:${fact.actorId}:${fact.runId ?? fact.timestamp}`, sessionId: fact.sessionId, actorId: fact.actorId,
        ...(fact.runId ? { runId: fact.runId } : {}), kind: "status", status: "running", startedAt: fact.timestamp, summary: "Retrying…",
      });
      this.status.set(fact.actorId, tracked);
    }
    return tracked;
  }

  /** The row for a finished tool call, used once by its canonical summary. */
  completedTool(actorId: string, toolCallId: string): TimelineActivity | undefined {
    const item = this.items.get(toolActivityItemId(actorId, toolCallId))?.item;
    return item && item.status !== "running" ? item : undefined;
  }

  /** Rows still running in a session, replayed to a client that subscribes mid-turn. */
  running(sessionId: string): TimelineActivity[] {
    return [...this.items.values()].filter(tracked => tracked.item.sessionId === sessionId && tracked.item.status === "running").map(tracked => ({ ...tracked.item }));
  }

  forget(agentId: string): void {
    for (const [id, tracked] of this.items) {
      if (tracked.item.sessionId !== agentId && tracked.item.actorId !== agentId) continue;
      clearTimeout(tracked.timer); this.items.delete(id);
      this.attempts.delete(id);
    }
    this.status.delete(agentId);
  }

  private finishReasoning(tracked: Tracked, timestamp: string): TimelineActivity {
    const item = tracked.item;
    if (!item.detail) item.hidden = true;
    item.status = "completed"; item.completedAt = timestamp;
    this.publishNow(tracked);
    return item;
  }

  private track(item: TimelineActivity): Tracked {
    const tracked: Tracked = { item, streamed: false, publishedAt: 0 };
    this.items.set(item.itemId, tracked);
    // Finished rows are evicted first; a running row is dropped only when nothing else is left.
    for (const [id, value] of this.items) {
      if (this.items.size <= MAX_TRACKED_ITEMS) break;
      if (value.item.status !== "running") this.items.delete(id);
    }
    for (const [id, value] of this.items) {
      if (this.items.size <= MAX_TRACKED_ITEMS) break;
      if (value !== tracked) { clearTimeout(value.timer); this.items.delete(id); }
    }
    return tracked;
  }

  private publishSoon(tracked: Tracked): void {
    if (tracked.timer) return;
    const wait = tracked.publishedAt + LIVE_UPDATE_INTERVAL_MS - this.now();
    if (wait <= 0) { this.publishNow(tracked); return; }
    tracked.timer = setTimeout(() => this.publishNow(tracked), wait);
    tracked.timer.unref?.();
  }

  private publishNow(tracked: Tracked): void {
    clearTimeout(tracked.timer); tracked.timer = undefined;
    tracked.publishedAt = this.now();
    this.publish({ ...tracked.item });
  }
}

export function toolActivityItemId(actorId: string, toolCallId: string): string {
  return `tool:${actorId}:${toolCallId}`;
}

/** The bounded content a canonical summary keeps so a reload renders the same row. */
export function persistedActivityDetail(item: TimelineActivity): PersistedActivityDetail {
  return {
    kind: item.kind, startedAt: item.startedAt,
    ...(item.input ? { input: item.input } : {}), ...(item.detail ? { detail: item.detail } : {}),
    ...(item.truncated ? { truncated: true } : {}), ...(item.hidden ? { hidden: true } : {}),
    ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
  };
}

export function classifyToolKind(toolName: string | undefined): TimelineActivityKind {
  const name = toolName?.toLowerCase() ?? "";
  if (/(^|_)(bash|shell|exec|command)($|_)|terminal/.test(name)) return "command";
  if (/apply_patch|file_change|(^|_)(edit|write|multiedit|notebookedit)($|_)/.test(name)) return "file_edit";
  if (/web|fetch|browser|url/.test(name)) return "web";
  if (/grep|glob|search|find/.test(name)) return "search";
  if (/(^|_)(read|view|ls|list_dir)($|_)|imageview/.test(name)) return "file_read";
  if (/agent|worker|speak_to_user|task/.test(name)) return "agent";
  return "tool";
}

function summarizeTool(kind: TimelineActivityKind, toolName: string | undefined, input: unknown): string {
  const args = isRecord(input) ? input : {};
  const pick = (...keys: string[]) => keys.map(key => args[key]).find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const command = Array.isArray(args.command) ? args.command.filter(part => typeof part === "string").join(" ") : pick("command", "cmd", "script");
  const subject = kind === "command" ? command
    : kind === "file_read" || kind === "file_edit" ? pick("path", "file_path", "filePath", "notebook_path") ?? firstChangedPath(args)
    : kind === "search" ? pick("pattern", "query", "glob", "path")
    : kind === "web" ? pick("url", "query")
    : kind === "agent" ? pick("targetAgentId", "agentId", "description")
    : pick("tool", "description", "path", "query");
  return (firstLine(subject ?? "") || toolName || "Tool").slice(0, ACTIVITY_SUMMARY_MAX_CHARS);
}

function firstChangedPath(args: Record<string, unknown>): string | undefined {
  const change = Array.isArray(args.changes) ? args.changes.find(isRecord) : undefined;
  return change && typeof change.path === "string" ? change.path : undefined;
}

function describeInput(kind: TimelineActivityKind, input: unknown): string {
  if (input === undefined) return "";
  if (typeof input === "string") return input;
  if (kind === "command" && isRecord(input)) {
    const command = Array.isArray(input.command) ? input.command.join(" ") : input.command ?? input.cmd;
    if (typeof command === "string") return command;
  }
  return JSON.stringify(input, null, 2);
}

/** Readable text of a serialized tool result, as rows show it. */
export function toolResultText(serialized: string): string {
  return resultText(parsePayload(serialized));
}

/** Readable text of a tool result or partial result, whatever shape the runtime reports. */
function resultText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) return payload.map(contentText).filter(Boolean).join("\n");
  if (!isRecord(payload)) return payload === undefined || payload === null ? "" : String(payload);
  if (typeof payload.content === "string" && payload.content) return payload.content;
  if (Array.isArray(payload.content)) {
    const text = payload.content.map(contentText).filter(Boolean).join("\n");
    if (text) return text;
  }
  for (const key of ["output", "aggregatedOutput", "outputPreview", "stdout", "text", "delta", "message"]) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
  }
  if (Array.isArray(payload.changes)) {
    return payload.changes.filter(isRecord).map(change => [change.kind, change.path].filter(value => typeof value === "string").join(" ") + (typeof change.diffPreview === "string" && change.diffPreview ? `\n${change.diffPreview}` : "")).join("\n\n");
  }
  return Object.keys(payload).length ? JSON.stringify(payload, null, 2) : "";
}

function contentText(part: unknown): string {
  return typeof part === "string" ? part : isRecord(part) && typeof part.text === "string" ? part.text : "";
}

function isOutputDelta(payload: unknown): boolean {
  return isRecord(payload) && typeof payload.output === "string" && Object.keys(payload).length === 1;
}

function readExitCode(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload.exitCode ?? (isRecord(payload.details) ? payload.details.exitCode : undefined);
  return Number.isInteger(value) ? value as number : undefined;
}

function bounded(field: "input" | "detail", text: string, keep: "head" | "tail"): Partial<TimelineActivity> {
  if (!text) return {};
  const max = field === "input" ? ACTIVITY_INPUT_MAX_CHARS : ACTIVITY_DETAIL_MAX_CHARS;
  if (text.length <= max) return { [field]: text };
  return { [field]: keep === "head" ? text.slice(0, max) : text.slice(-max), truncated: true };
}

/** One readable sentence for a provider failure; the raw text stays in the row's details. */
export function readableProviderError(raw: string): string {
  const text = oneLine(raw).replace(/[.\s]+$/, "");
  if (/\b401\b|unauthori[sz]ed|(invalid|incorrect) api key|authentication/i.test(text)) return "The provider rejected the API key (401). Check the key in Settings → Authentication.";
  if (/\b429\b|rate.?limit|too many requests/i.test(text)) return "The provider is rate limiting requests (429). Wait a moment, then send again.";
  if (/\b404\b|not found/i.test(text)) return "The provider endpoint was not found (404). Check the base URL in Settings → Authentication.";
  if (/exited \(code=|process exited|app-server exited/i.test(text)) return "The provider process stopped unexpectedly.";
  if (/\b5\d\d\b|overloaded|unavailable/i.test(text)) return "The provider is unavailable right now. Try again shortly.";
  return `${text.slice(0, 240)}.`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function firstLine(text: string): string {
  const line = text.split("\n").map(value => value.trim()).find(Boolean) ?? "";
  // Reasoning summaries often open with a bold markdown heading.
  return line.replace(/^\*\*(.+?)\*\*$/, "$1").slice(0, ACTIVITY_SUMMARY_MAX_CHARS);
}

function parsePayload(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
