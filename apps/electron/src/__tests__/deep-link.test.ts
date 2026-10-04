import { describe, expect, it } from 'vitest'
import { buildCommandCenterRouteUrl, parseCommandCenterDeepLink, parseSkillImportDeepLink } from '../deep-link.js'

describe('skill import deep links', () => {

  it('rejects unsupported actions and unsafe embedded URLs', () => {
    expect(parseSkillImportDeepLink('forge://settings?url=https%3A%2F%2Fforgeskills.radops.ai%2Fs%2Ftoken')).toBeNull()
    expect(parseSkillImportDeepLink('forge://skill-import?url=file%3A%2F%2F%2Ftmp%2Fskill.json')).toBeNull()
    expect(parseSkillImportDeepLink('not a url')).toBeNull()
  })
})

describe('Command Center deep links', () => {
  it('projects only allowlisted Stream Deck destinations into the renderer URL', () => {
    const link = 'forge://open?agent=manager--s2&surface=builder&deckPanel=terminal&evil=file%3A%2F%2Fsecret'
    expect(parseCommandCenterDeepLink(link)?.get('agent')).toBe('manager--s2')
    expect(buildCommandCenterRouteUrl('app://forge/index.html', link)).toBe(
      'app://forge/index.html?agent=manager--s2&surface=builder&deckPanel=terminal',
    )
  })
})
