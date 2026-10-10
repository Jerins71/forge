import type { ServerEvent } from "./server-events.js";
// The protocol package's type-only ES lib excludes DOM; both supported runtimes provide this native encoder.
declare const TextEncoder: { new(): { encode(text: string): Uint8Array } };

/** Bounded compatibility features shared by the backend publisher and runtime decoder. */
export const legacySessionEventAllowlist = [
  "browser_session_snapshot", "browser_session_changed",
] as const satisfies readonly ServerEvent["type"][];
type LegacyType = typeof legacySessionEventAllowlist[number];

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128;
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
  if ("sessionAgentId" in value && value.sessionAgentId !== sessionId || "agentId" in value && value.agentId !== sessionId) return false;
  return isRecord(value.snapshot) && value.snapshot.sessionAgentId === sessionId && id(value.snapshot.profileId)
    && Array.isArray(value.snapshot.tabs) && value.snapshot.tabs.every(tab => isRecord(tab) && id(tab.tabId))
    && (value.type === "browser_session_snapshot" || ["host-report", "automation", "human-command", "lifecycle", "recovery"].includes(String(value.reason)));
}
