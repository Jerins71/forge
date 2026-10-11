// Failure case: before the environment's catalog has loaded (the new-thread composer), the model chip
// shows the raw model ID instead of the model's name.
import { describe, expect, it } from 'vitest'
import { catalogModelLabel } from './manager-selection-catalog'

describe('catalogModelLabel', () => {
  it('names a known model before the catalog has loaded', () => {
    expect(catalogModelLabel(null, 'codex-native', 'gpt-6-sol')).toMatch(/^GPT-6 Sol/)
    expect(catalogModelLabel(undefined, 'codex-native', 'gpt-6-sol')).not.toBe('gpt-6-sol')
  })
  it('falls back to the ID only for a model no catalog knows', () => {
    expect(catalogModelLabel(null, 'codex-native', 'not-a-model')).toBe('not-a-model')
  })
})
