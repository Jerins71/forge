import { Value } from '@sinclair/typebox/value';
import { RecoverySnapshotSchema, type RecoverySnapshot } from '@forge/protocol/environment-v2';
import type { SwarmManager } from '../../swarm/swarm-manager.js';
import { TypeCompiler } from "@sinclair/typebox/compiler";
import {
  DetailItemSchema, DetailStreamItemSchema, ShellStreamItemSchema, StreamCursorSchema,
  type DetailStreamItem, type ShellStreamItem, type UnknownStreamItem,
} from "@forge/protocol/environment-v2";
import { encodedBytes, EVENT_BYTES, StreamFault } from "./stream-budget.js";
import type { DetailItem } from "./stream-types.js";

const detailCheck = TypeCompiler.Compile(DetailStreamItemSchema);
const shellCheck = TypeCompiler.Compile(ShellStreamItemSchema);
const itemCheck = TypeCompiler.Compile(DetailItemSchema);
const cursorCheck = TypeCompiler.Compile(StreamCursorSchema);
const shellTypes = new Set(["recovery.upsert", "project.upsert", "project.remove", "session.upsert", "session.remove"]);
const detailTypes = new Set(["lineage.upsert", "plan.upsert", "goal.upsert", "recovery.upsert", "item.upsert", "worker.upsert", "worker.remove", "choice.upsert", "receipt.upsert", "session.upsert", "detail.reset"]);

/** Pure client-copyable decoder: an invalid known event must never become unknown. */
export function decodeStreamItem(topic: "shell", value: unknown): ShellStreamItem | UnknownStreamItem;
export function decodeStreamItem(topic: "detail", value: unknown): DetailStreamItem | UnknownStreamItem;
export function decodeStreamItem(topic: "shell" | "detail", value: unknown): ShellStreamItem | DetailStreamItem | UnknownStreamItem {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (v.kind === "event" && cursorCheck.Check({ streamEpoch: v.streamEpoch, afterSequence: v.sequence }) &&
      Object.keys(v).length === 4 && v.event && typeof v.event === "object" &&
      typeof (v.event as Record<string, unknown>).type === "string") {
      const eventType = (v.event as { type: string }).type;
      if (!(topic === "shell" ? shellTypes : detailTypes).has(eventType)) {
        return { kind: "unknown", streamEpoch: v.streamEpoch as string, sequence: v.sequence as number, eventType };
      }
    }
  }
  const validator = topic === "shell" ? shellCheck : detailCheck;
  if (!validator.Check(value)) throw new StreamFault("RESYNC_REQUIRED", "Malformed stream item.");
  return value as ShellStreamItem | DetailStreamItem;
}

/** Full text remains at the authenticated content owner, referenced by item ID. */
export function projectDetailItem(item: DetailItem, maxBytes = EVENT_BYTES - 2048): DetailItem {
  const projected = { ...item, text: item.text.slice(0, 8192) };
  if (projected.text !== item.text) projected.contentRef ??= item.itemId;
  while (encodedBytes(projected) > maxBytes && projected.text.length > 0) {
    projected.text = projected.text.slice(0, Math.floor(projected.text.length / 2));
    projected.contentRef ??= item.itemId;
  }
  if (!itemCheck.Check(projected) || encodedBytes(projected) > maxBytes) {
    throw new StreamFault("PAYLOAD_TOO_LARGE", "Detail metadata exceeds the wire budget.");
  }
  return projected;
}

export function recoveryProjection(swarm: Pick<SwarmManager, 'getRestartRecoverySnapshot'>): RecoverySnapshot | null {
  return projectRecoverySnapshot(swarm.getRestartRecoverySnapshot());
}
export function projectRecoverySnapshot(snapshot: RecoverySnapshot | null): RecoverySnapshot | null {
  if (!snapshot) return null;
  const result = { ...snapshot };
  if (!Value.Check(RecoverySnapshotSchema, result)) throw new StreamFault('PAYLOAD_TOO_LARGE', 'Recovery presentation exceeds its bounds');
  return result;
}
