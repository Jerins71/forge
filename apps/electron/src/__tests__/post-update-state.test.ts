import { describe, expect, it } from 'vitest'
import {
  RECOMMENDED_DEFAULTS_PROMPT_ID,
  resolvePostUpdateState,
} from '../post-update-state.js'

describe('post-update state', () => {
  it('records a first install without presenting an update or later defaults migration', () => {
    const first = resolvePostUpdateState('1.0.0', null)
    expect(first.info).toBeNull()
    expect(first.next).toEqual({
      version: '1.0.0',
      seenPromptIds: [RECOMMENDED_DEFAULTS_PROMPT_ID],
    })
    expect(resolvePostUpdateState('1.1.0', first.next).info).toMatchObject({
      offerRecommendedDefaults: false,
    })
  })

  it('offers recommended defaults once to an existing installation after update', () => {
    const updated = resolvePostUpdateState('1.1.0', { version: '1.0.0' })
    expect(updated.info).toEqual({
      previousVersion: '1.0.0',
      currentVersion: '1.1.0',
      offerRecommendedDefaults: true,
    })
    expect(resolvePostUpdateState('1.2.0', updated.next).info).toMatchObject({
      offerRecommendedDefaults: false,
    })
  })
})
