import type { BrowserTabLifecycle, BrowserTargetAffinity } from './browser-automation.js'

export const BROWSER_PREVIEW_MAX_CARDS = 4
export const BROWSER_PREVIEW_MANAGED_MAX_WIDTH = 640
export const BROWSER_PREVIEW_MANAGED_MAX_HEIGHT = 360
export const BROWSER_PREVIEW_MANAGED_MAX_PNG_BYTES = 512 * 1_024
export const BROWSER_PREVIEW_TOTAL_IMAGE_BYTES = 2 * 1_024 * 1_024
export const BROWSER_PREVIEW_DELAYED_AFTER_MS = 3_000
export const BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS = 5 * 60_000

export const BROWSER_PREVIEW_CARD_STATES = [
  'waiting',
  'updating',
  'paused',
  'delayed',
  'unavailable',
  'expired',
] as const
export type BrowserPreviewCardState = (typeof BROWSER_PREVIEW_CARD_STATES)[number]

/** Main-renderer membership published atomically with the selected local browser workspace. */
export interface BrowserPreviewScope {
  hostGeneration: number | null
  sessionRevision: number
  connected: boolean
  tabs: BrowserPreviewScopeTab[]
}

export interface BrowserPreviewScopeTab {
  tabId: string
  targetAffinity: BrowserTargetAffinity
  lifecycle: BrowserTabLifecycle
  /** Sanitized display label. External Chrome titles must remain null. */
  label: string | null
  /** True only for the one managed WebContentsView currently presented by Forge. */
  presented: boolean
}

export interface BrowserPreviewDeckSnapshot {
  previewGeneration: number
  workspaceEpoch: number
  sessionAgentId: string
  profileId: string
  hiddenContent: boolean
  cards: BrowserPreviewCardSnapshot[]
}

export interface BrowserPreviewCardSnapshot {
  tabId: string
  targetAffinity: BrowserTargetAffinity
  label: string | null
  lifecycle: BrowserTabLifecycle
  presented: boolean
  state: BrowserPreviewCardState
  frameSequence: number
  hasFrame: boolean
  width: number | null
  height: number | null
  /** Monotonic age calculated by main at snapshot delivery. */
  ageMsAtDelivery: number | null
}

export interface BrowserPreviewFrameAvailable {
  previewGeneration: number
  tabId: string
  sequence: number
}

export interface BrowserPreviewFramePullRequest extends BrowserPreviewFrameAvailable {}

export interface BrowserPreviewFramePayload extends BrowserPreviewFrameAvailable {
  mimeType: 'image/png'
  data: string
  width: number
  height: number
  /** Monotonic age calculated by main at frame delivery. */
  ageMsAtDelivery: number
}
