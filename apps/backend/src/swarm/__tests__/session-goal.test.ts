import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { SessionGoalStore } from '../goals/session-goal-store.js'

const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, total: 150 }

describe('session goals', () => {
  it('persists one active goal and restores it after a restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-goal-'))
    let now = '2026-07-13T10:00:00.000Z'
    const options = {
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      now: () => now,
      randomId: () => 'goal-1',
    }
    const created = await new SessionGoalStore(options).create({
      objective: '  Ship the durable goal system  ',
      tokenBudget: 50_000,
    })

    expect(created).toMatchObject({
      revision: 1,
      goal: {
        id: 'goal-1',
        objective: 'Ship the durable goal system',
        status: 'active',
        tokenBudget: 50_000,
        turnCount: 1,
      },
    })
    await expect(new SessionGoalStore(options).load()).resolves.toEqual(created)
    await expect(new SessionGoalStore(options).create({ objective: 'Competing goal' }))
      .rejects.toThrow('Finish or cancel the current goal')

    now = '2026-07-13T10:00:05.000Z'
    const paused = await new SessionGoalStore(options).control({ action: 'pause' })
    expect(paused.goal).toMatchObject({
      status: 'paused',
      pauseReason: 'user',
      activeElapsedMs: 5_000,
    })
    expect(paused.goal).not.toHaveProperty('activeSince')
  })

  it('does not end the current goal if terminal history cannot be written', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-goal-history-failure-'))
    const appendHistory = vi.fn(async () => { throw new Error('history unavailable') })
    const store = new SessionGoalStore({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      appendHistory,
    })
    await store.create({ objective: 'Preserve me' })

    await expect(store.updateFromAgent('complete', { usage, coverage: 'complete' }))
      .rejects.toThrow('history unavailable')
    await expect(store.load()).resolves.toMatchObject({
      revision: 1,
      goal: { status: 'active', objective: 'Preserve me' },
    })
  })
})
