import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPins, savePins, togglePin } from '../swarm/session/message-pins.js'

describe('message-pins', () => {

  it('saves and toggles pins with content preservation', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'forge-message-pins-'))

    await savePins(sessionDir, { version: 1, pins: {} })
    await togglePin(sessionDir, 'msg-1', true, {
      role: 'user',
      text: 'Keep this exact wording',
      timestamp: '2026-03-27T14:30:00.000Z',
    })

    const registry = await loadPins(sessionDir)
    expect(registry.pins['msg-1']).toMatchObject({
      role: 'user',
      text: 'Keep this exact wording',
      timestamp: '2026-03-27T14:30:00.000Z',
    })

    await togglePin(sessionDir, 'msg-1', false)
    await expect(loadPins(sessionDir)).resolves.toEqual({ version: 1, pins: {} })
  })
})
