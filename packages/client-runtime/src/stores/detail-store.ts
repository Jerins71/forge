import type { Static } from '@sinclair/typebox'
import type {
  DetailSnapshotSchema,
  StreamCursor,
} from '@forge/protocol/environment-v2'
export interface DetailState {
  projection: Static<typeof DetailSnapshotSchema> | null
  cursor: StreamCursor | null
  freshness: 'cached' | 'synchronizing' | 'live' | 'unavailable'
  transient: ReadonlyMap<string, unknown>
}
