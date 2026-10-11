/**
 * The one timeline item model for tool and reasoning activity. Live rows travel
 * on the ephemeral detail-feature stream with bounded inline content; replayed
 * rows travel as durable detail items that carry the same metadata and fetch
 * their persisted content by reference. A stable `itemId` lets both converge.
 */
import { Type, type Static } from '@sinclair/typebox'

/** Bounds for content persisted in canonical history and sent on live rows. */
export const ACTIVITY_SUMMARY_MAX_CHARS = 512
export const ACTIVITY_INPUT_MAX_CHARS = 2048
export const ACTIVITY_DETAIL_MAX_CHARS = 6000
/** A streaming assistant reply is live only; its canonical message replaces it, so it may be longer. */
export const ACTIVITY_LIVE_MESSAGE_MAX_CHARS = 24_000

export const TIMELINE_ACTIVITY_KINDS = [
  'reasoning', 'command', 'file_read', 'file_edit', 'search', 'web', 'agent', 'tool',
  // One row per turn for provider retries and the provider error that ended it.
  'status',
  // Assistant text while it streams. Live only: the canonical message takes its place.
  'message',
] as const
export type TimelineActivityKind = (typeof TIMELINE_ACTIVITY_KINDS)[number]

const id = Type.String({ minLength: 1, maxLength: 256 })
const time = Type.String({ maxLength: 32 })
const literals = <T extends string>(items: readonly T[]) => Type.Union(items.map(item => Type.Literal(item)))

export const TimelineActivitySchema = Type.Object({
  itemId: id,
  /** Session (manager) timeline that shows the row. */
  sessionId: id,
  /** Agent that performed the activity: the manager itself or one of its workers. */
  actorId: id,
  /** Run/turn that produced the activity, when the runtime reported one. */
  runId: Type.Optional(id),
  kind: literals(TIMELINE_ACTIVITY_KINDS),
  status: literals(['running', 'completed', 'failed'] as const),
  startedAt: time,
  completedAt: Type.Optional(time),
  /** One collapsed line: the command, the file, or the first line of the reasoning. */
  summary: Type.String({ maxLength: ACTIVITY_SUMMARY_MAX_CHARS }),
  toolName: Type.Optional(Type.String({ maxLength: 128 })),
  /** What was asked: the full command line or tool arguments. */
  input: Type.Optional(Type.String({ maxLength: ACTIVITY_INPUT_MAX_CHARS })),
  /** What came back: streamed output, tool result, or reasoning text. */
  detail: Type.Optional(Type.String({ maxLength: ACTIVITY_LIVE_MESSAGE_MAX_CHARS })),
  /** `input` or `detail` was cut to its bound. */
  truncated: Type.Optional(Type.Boolean()),
  /** Reasoning the provider encrypts or withholds: shown as "Thinking…" with no content. */
  hidden: Type.Optional(Type.Boolean()),
  exitCode: Type.Optional(Type.Integer()),
}, { additionalProperties: false })
export type TimelineActivity = Static<typeof TimelineActivitySchema>

/** Ephemeral live upsert of one running or just-finished activity row. */
export interface TimelineActivityEvent {
  type: 'timeline_activity'
  sessionAgentId: string
  item: TimelineActivity
}

/** Bounded content persisted with a canonical activity summary so replay matches the live row. */
export const PersistedActivityDetailSchema = Type.Pick(
  TimelineActivitySchema, ['kind', 'startedAt', 'input', 'detail', 'truncated', 'hidden', 'exitCode'],
  // Canonical history outlives a release: later additions must still read.
  { additionalProperties: true },
)
export type PersistedActivityDetail = Static<typeof PersistedActivityDetailSchema>

/** The persisted content of a row as one expandable text, in the same shape live rows render. */
export function formatActivityContent(activity: Pick<TimelineActivity, 'input' | 'detail'>): string {
  return [activity.input, activity.detail].filter(Boolean).join('\n\n')
}
