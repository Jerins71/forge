import type { Static } from "@sinclair/typebox";
import type { DetailItemSchema, DetailSnapshotSchema, ShellEventSchema, DetailEventSchema, WorkerSummarySchema, ChoiceSummarySchema } from "@forge/protocol/environment-v2";

export type DetailItem = Static<typeof DetailItemSchema>;
export type DetailSnapshot = Static<typeof DetailSnapshotSchema>;
export type ShellEvent = Static<typeof ShellEventSchema>;
export type DetailEvent = Static<typeof DetailEventSchema>;
export type WorkerSummary = Static<typeof WorkerSummarySchema>;
export type ChoiceSummary = Static<typeof ChoiceSummarySchema>;
