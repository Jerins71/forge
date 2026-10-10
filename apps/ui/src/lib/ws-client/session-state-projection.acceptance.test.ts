import { expect, it } from 'vitest'
import { projectItems, projectSession } from './environment-projection'
import { defaultFixtureSeeds } from '@forge/client-runtime'

it('renders sidebar ordering metadata and message pins from fresh and live projections', () => {
  const seed = defaultFixtureSeeds()[0]
  const session = { ...seed.shell!.sessions[0], pinnedAt: '2026-10-08T00:00:00.000Z', lastUsedAt: '2026-10-09T00:00:00.000Z', createdAt: '2026-10-07T00:00:00.000Z' }
  const shell = { projects: new Map(seed.shell!.projects.map(p => [p.projectId, p])) } as unknown as Parameters<typeof projectSession>[1]
  const fresh = projectSession(session, shell)
  expect(fresh).toMatchObject({ pinnedAt: session.pinnedAt, lastUserMessageAt: session.lastUsedAt, createdAt: session.createdAt })
  expect(projectSession({ ...session, pinnedAt: null }, shell, fresh).pinnedAt).toBeUndefined()
  const item = { ...seed.details![session.sessionId].items[0], pinned: true }
  expect(projectItems([item], session.sessionId)[0].pinned).toBe(true)
  expect(projectItems([{ ...item, pinned: false }], session.sessionId)[0].pinned).toBe(false)
})
