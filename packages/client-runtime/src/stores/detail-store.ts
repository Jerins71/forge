import type { Static } from '@sinclair/typebox'
import type {
  DetailSnapshotSchema,
  StreamCursor,
} from '@forge/protocol/environment-v2'
export type DetailTransientEvent = import('@forge/protocol/environment-v2').DetailFeatureEvent | Extract<import('@forge/protocol').ServerEvent, { type: 'browser_session_snapshot' | 'browser_session_changed' }>
export interface DetailState {
  projection: Static<typeof DetailSnapshotSchema> | null
  cursor: StreamCursor | null
  freshness: 'cached' | 'synchronizing' | 'live' | 'unavailable'
  transient: ReadonlyMap<string, DetailTransientEvent>
}
