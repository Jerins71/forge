import type { ServerEvent } from "./server-events.js";

/** Bounded compatibility features shared by the backend publisher and runtime decoder. */
export const legacySessionEventAllowlist = [
] as const satisfies readonly ServerEvent["type"][];
type LegacyType = typeof legacySessionEventAllowlist[number];

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function isBoundedLegacyValue(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 32_768;
  if (Array.isArray(value)) return value.length <= 256 && value.every(v => isBoundedLegacyValue(v, depth + 1));
  return isRecord(value) && Object.keys(value).length <= 128 && Object.entries(value).every(([key, v]) => key.length <= 128 && (v === undefined || isBoundedLegacyValue(v, depth + 1)));
}

/** No legacy feature remains in Phase 2; keep the decoder until the bridge is removed. */
export function validateLegacySessionEvent(_value: unknown, _sessionId: string): _value is Extract<ServerEvent, { type: LegacyType }> {
  return false;
}
