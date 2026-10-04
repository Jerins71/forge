import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { SessionPlanStore } from '../planning/session-plan-store.js'
import { getSessionPlanHistoryPath, getSessionPlanPath } from '../storage/data-paths.js'

describe('Codex-style session plans', () => {
  it('persists atomic snapshots and increments the revision', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-plan-'))
    const store = new SessionPlanStore({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      now: () => new Date('2026-07-12T00:00:00.000Z'),
    })

    expect(await store.load()).toMatchObject({ revision: 0, updatedAt: null, plan: [] })
    await store.update({ plan: [{ step: 'Inspect', status: 'in_progress' }] })
    const updated = await store.update({
      explanation: 'Inspection complete.',
      plan: [
        { step: 'Inspect', status: 'completed' },
        { step: 'Implement', status: 'in_progress' },
      ],
    })

    expect(updated).toMatchObject({ revision: 2, explanation: 'Inspection complete.' })
    expect(JSON.parse(await readFile(getSessionPlanPath(dataDir, 'profile-1', 'session-1'), 'utf8'))).toEqual(updated)
    await store.clear()
    expect(readJsonl(await readFile(
      getSessionPlanHistoryPath(dataDir, 'profile-1', 'session-1'),
      'utf8',
    ))).toEqual([
      {
        schemaVersion: 1,
        revision: 1,
        updatedAt: '2026-07-12T00:00:00.000Z',
        plan: [{ step: 'Inspect', status: 'in_progress' }],
      },
      updated,
    ])
  })

  it('backs up malformed state and safely returns an empty plan', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-plan-corrupt-'))
    const path = getSessionPlanPath(dataDir, 'profile-1', 'session-1')
    const store = new SessionPlanStore({ dataDir, profileId: 'profile-1', sessionAgentId: 'session-1' })
    await store.update({ plan: [] })
    await writeFile(path, '{broken', 'utf8')

    await expect(store.load()).resolves.toMatchObject({ revision: 0, plan: [] })
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the current plan unchanged when history archival fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-plan-history-failure-'))
    const appendHistory = vi.fn(async () => { throw new Error('history unavailable') })
    const store = new SessionPlanStore({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      appendHistory,
    })

    await store.update({ plan: [{ step: 'Preserve me', status: 'in_progress' }] })
    await expect(store.update({ plan: [{ step: 'Replace me', status: 'in_progress' }] }))
      .rejects.toThrow('history unavailable')

    expect(appendHistory).toHaveBeenCalledWith(store.historyFilePath, expect.objectContaining({
      revision: 1,
      plan: [{ step: 'Preserve me', status: 'in_progress' }],
    }))
    await expect(store.load()).resolves.toMatchObject({
      revision: 1,
      plan: [{ step: 'Preserve me', status: 'in_progress' }],
    })
  })
})

function readJsonl(raw: string): unknown[] {
  return raw.trim().split('\n').map((line) => JSON.parse(line))
}
