import type { ManagerProfile } from './shared-types.js'

export interface ProfilesSnapshotEvent {
  type: 'profiles_snapshot'
  profiles: ManagerProfile[]
}
