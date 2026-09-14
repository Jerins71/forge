import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  BROWSER_PREVIEW_CARD_STATES,
  BROWSER_PREVIEW_DELAYED_AFTER_MS,
  BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS,
  BROWSER_PREVIEW_MANAGED_MAX_HEIGHT,
  BROWSER_PREVIEW_MANAGED_MAX_PNG_BYTES,
  BROWSER_PREVIEW_MANAGED_MAX_WIDTH,
  BROWSER_PREVIEW_MAX_CARDS,
  BROWSER_PREVIEW_TOTAL_IMAGE_BYTES,
  type BrowserPreviewDeckSnapshot,
  type BrowserPreviewFramePayload,
} from '../index.js'

describe('browser preview desktop-local contract', () => {
  it('exports the reviewed resource, freshness, and privacy bounds through the root barrel', () => {
    expect(BROWSER_PREVIEW_MAX_CARDS).toBe(4)
    expect([BROWSER_PREVIEW_MANAGED_MAX_WIDTH, BROWSER_PREVIEW_MANAGED_MAX_HEIGHT]).toEqual([640, 360])
    expect(BROWSER_PREVIEW_MANAGED_MAX_PNG_BYTES).toBe(512 * 1_024)
    expect(BROWSER_PREVIEW_TOTAL_IMAGE_BYTES).toBe(2 * 1_024 * 1_024)
    expect(BROWSER_PREVIEW_DELAYED_AFTER_MS).toBe(3_000)
    expect(BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS).toBe(5 * 60_000)
    expect(BROWSER_PREVIEW_CARD_STATES).toEqual(['waiting', 'updating', 'paused', 'delayed', 'unavailable', 'expired'])
  })

  it('keeps pixels out of automatic membership snapshots', () => {
    expectTypeOf<BrowserPreviewDeckSnapshot>().not.toMatchTypeOf<{ data: string }>()
    expectTypeOf<BrowserPreviewFramePayload>().toMatchTypeOf<{
      mimeType: 'image/png'; data: string; ageMsAtDelivery: number
    }>()
  })
})
