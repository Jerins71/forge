/**
 * Mobile Expo push registration and device-delivery contracts.
 *
 * A push token belongs to the paired device session that registered it. The
 * server pushes only while that device session is active, so revoking or
 * expiring a device stops its notifications. Push data names the environment
 * and session; it never carries credentials or URLs.
 */

export const MOBILE_PUSH_DATA_VERSION = 2 as const
export const MOBILE_PUSH_ANDROID_CHANNEL_ID = 'agent-updates'

export const MOBILE_PUSH_PLATFORMS = ['ios', 'android', 'unknown'] as const
export type MobilePushPlatform = (typeof MOBILE_PUSH_PLATFORMS)[number]

/** `attention`: a session newly entered Needs you; `eventId` is its attention ID. */
export const MOBILE_PUSH_NOTIFICATION_TYPES = ['attention', 'test'] as const
export type MobilePushNotificationType = (typeof MOBILE_PUSH_NOTIFICATION_TYPES)[number]

export interface MobilePushRegisterRequest {
  token: string
  platform: MobilePushPlatform
  deviceName?: string
  enabled?: boolean
}

export interface MobilePushUnregisterRequest {
  token: string
}

export interface MobilePushDevice {
  token: string
  platform: MobilePushPlatform
  deviceName: string
  registeredAt: string
  enabled: boolean
  /** The paired device session that registered this token. Absent only on Forge 1 records, which never receive pushes. */
  deviceSessionId?: string
  updatedAt?: string
  disabledAt?: string
  disabledReason?: string
}

/** Expo `data` payload. A type alias so it is assignable to Expo's record type. */
export type MobilePushData = {
  v: typeof MOBILE_PUSH_DATA_VERSION
  type: MobilePushNotificationType
  environmentId: string
  projectId?: string
  sessionId?: string
  eventId?: string
}
