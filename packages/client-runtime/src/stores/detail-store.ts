import type { Static } from '@sinclair/typebox'
import type {
  DetailSnapshotSchema,
  StreamCursor,
} from '@forge/protocol/environment-v2'
export type DetailTransientEvent = import('@forge/protocol/environment-v2').DetailFeatureEvent
export interface DetailState {
  browser: import('@forge/protocol').BrowserSessionSnapshot | null
  projection: Static<typeof DetailSnapshotSchema> | null
  cursor: StreamCursor | null
  freshness: 'cached' | 'synchronizing' | 'live' | 'unavailable'
  transient: ReadonlyMap<string, DetailTransientEvent>
}
