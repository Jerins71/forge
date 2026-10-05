import type { ServerEvent } from "./server-events.js";
// The protocol package's type-only ES lib excludes DOM; both supported runtimes provide this native encoder.
declare const TextEncoder: { new(): { encode(text: string): Uint8Array } };

/** Bounded compatibility features shared by the backend publisher and runtime decoder. */
export const legacySessionEventAllowlist = [
  "session_plan_snapshot", "session_goal_snapshot", "manager_tool_activity",
  "browser_session_snapshot", "browser_session_changed", "secure_session_snapshot",
  "secure_secret_catalog_changed", "codex_elicitation_request", "codex_elicitation_dismissed",
  "generation_throughput", "generation_throughput_snapshot",
  "terminals_snapshot", "terminal_created", "terminal_updated", "terminal_closed",
] as const satisfies readonly ServerEvent["type"][];
type LegacyType = typeof legacySessionEventAllowlist[number];

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const terminal = (value: unknown, sessionId: string) => isRecord(value) && id(value.terminalId) && value.sessionAgentId === sessionId
  && id(value.profileId) && typeof value.name === "string" && typeof value.shell === "string" && typeof value.cwd === "string"
  && number(value.cols) && number(value.rows) && ["running", "exited", "restoring", "restore_failed"].includes(String(value.state))
  && (value.pid === null || number(value.pid)) && (value.exitCode === null || typeof value.exitCode === "number")
  && (value.exitSignal === null || number(value.exitSignal)) && typeof value.recoveredFromPersistence === "boolean"
  && typeof value.createdAt === "string" && typeof value.updatedAt === "string";
export function isBoundedLegacyValue(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 32_768;
  if (Array.isArray(value)) return value.length <= 256 && value.every(v => isBoundedLegacyValue(v, depth + 1));
  return isRecord(value) && Object.keys(value).length <= 128 && Object.entries(value).every(([key, v]) => key.length <= 128 && (v === undefined || isBoundedLegacyValue(v, depth + 1)));
}

/** Explicit event-specific requirements plus recursive byte/depth/string/array caps. */
export function validateLegacySessionEvent(value: unknown, sessionId: string): value is Extract<ServerEvent, { type: LegacyType }> {
  if (!isRecord(value) || !legacySessionEventAllowlist.includes(value.type as LegacyType) || !isBoundedLegacyValue(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536) return false;
  // Terminals belong to the session's terminal scope (its profile), which the server resolves and routes;
  // terminal events must be self-consistent with that scope rather than equal to the session ID.
  const scope = value.sessionAgentId;
  switch (value.type) {
    case "terminals_snapshot": return id(scope) && Array.isArray(value.terminals) && value.terminals.length <= 20 && value.terminals.every(item => terminal(item, scope as string));
    case "terminal_created": case "terminal_updated": return id(scope) && terminal(value.terminal, scope as string);
    case "terminal_closed": return id(scope) && id(value.terminalId) && ["user_closed", "session_deleted", "manager_deleted", "shutdown", "orphan_cleanup"].includes(String(value.reason));
  }
  if ("sessionAgentId" in value && value.sessionAgentId !== sessionId || "agentId" in value && value.agentId !== sessionId) return false;
  switch (value.type as Exclude<LegacyType, "terminals_snapshot" | "terminal_created" | "terminal_updated" | "terminal_closed">) {
    case "manager_tool_activity": return value.sessionAgentId === sessionId && number(value.revision) && number(value.toolCount) && (value.backgroundCount === undefined || number(value.backgroundCount));
    case "session_plan_snapshot": return value.sessionAgentId === sessionId && id(value.profileId) && number(value.revision) && (typeof value.updatedAt === "string" || value.updatedAt === null) && Array.isArray(value.plan) && value.plan.every(step => isRecord(step) && typeof step.step === "string" && ["pending", "in_progress", "completed"].includes(String(step.status)));
    case "session_goal_snapshot": return value.sessionAgentId === sessionId && id(value.profileId) && number(value.revision) && typeof value.measuredAt === "string" && (value.goal === null || isRecord(value.goal) && id(value.goal.id) && typeof value.goal.objective === "string" && ["active", "paused", "blocked", "completed", "cancelled"].includes(String(value.goal.status)) && number(value.goal.activeElapsedMs) && number(value.goal.turnCount) && isRecord(value.goal.usage));
    case "secure_secret_catalog_changed": return number(value.revision);
    case "secure_session_snapshot": return value.sessionAgentId === sessionId && id(value.profileId) && number(value.revision) && typeof value.updatedAt === "string" && ["manager", "worker"].includes(String(value.principalKind)) && typeof value.executionMode === "string" && typeof value.environmentStatus === "string" && Array.isArray(value.leases) && value.leases.every(isRecord) && Array.isArray(value.pendingRequests) && value.pendingRequests.every(isRecord);
    case "browser_session_snapshot": case "browser_session_changed": return isRecord(value.snapshot) && value.snapshot.sessionAgentId === sessionId && id(value.snapshot.profileId) && Array.isArray(value.snapshot.tabs) && value.snapshot.tabs.every(tab => isRecord(tab) && id(tab.tabId)) && (value.type === "browser_session_snapshot" || ["host-report", "automation", "human-command", "lifecycle", "recovery"].includes(String(value.reason)));
    case "codex_elicitation_dismissed": return value.agentId === sessionId && id(value.elicitationId);
    case "codex_elicitation_request": return value.agentId === sessionId && id(value.elicitationId) && id(value.sidecarAgentId) && ["form", "url"].includes(String(value.mode)) && typeof value.message === "string" && Array.isArray(value.persistScopes) && value.persistScopes.every(s => s === "session" || s === "always") && (value.fields === undefined || Array.isArray(value.fields) && value.fields.every(f => isRecord(f) && id(f.key) && typeof f.label === "string" && ["string", "boolean", "number", "enum"].includes(String(f.type)) && typeof f.required === "boolean"));
    case "generation_throughput": return isRecord(value.measurement) && value.measurement.sessionId === sessionId && id(value.measurement.measurementId) && number(value.measurement.sequence) && ["starting", "generating", "completed", "aborted"].includes(String(value.measurement.phase));
    case "generation_throughput_snapshot": return value.sessionAgentId === sessionId && Array.isArray(value.measurements) && value.measurements.every(m => isRecord(m) && m.sessionId === sessionId && id(m.measurementId) && number(m.sequence)) && isRecord(value.sessionSummary);
  }
}
