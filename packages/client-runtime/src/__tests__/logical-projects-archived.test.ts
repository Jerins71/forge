import { expect, it } from 'vitest'
import type { ProjectSummary } from '@forge/protocol/environment-v2'
import { LogicalProjects } from '../logical-projects.js'

const repository = { verifiedForSync: true, canonicalRemote: 'github.com/a-mart/forge', subpath: '', key: 'repo-key' }
const project = (projectId: string, title: string, archived: boolean) =>
  ({ projectId, title, archived, repository, cwd: '/repo', isGit: true }) as unknown as ProjectSummary

function attach(projects: ProjectSummary[]) {
  const grouping = new LogicalProjects({ loadGrouping: async () => ({}), saveGrouping: async () => {} } as never)
  let snapshot = { projects: new Map(projects.map((p) => [p.projectId, p])) }
  const listeners: (() => void)[] = []
  grouping.attach({
    environmentId: 'env-1',
    shell: { getSnapshot: () => snapshot, subscribe: (_s: unknown, listener: () => void) => { listeners.push(listener); return () => {} } },
  } as never)
  return { grouping, update(next: ProjectSummary[]) { snapshot = { projects: new Map(next.map((p) => [p.projectId, p])) }; listeners.forEach((l) => l()) } }
}

it('keeps an archived project out of the live group for its repository, even when it was added first', () => {
  const { grouping } = attach([project('cortex', 'Cortex · Forge 1 (read-only)', true), project('forge', 'Forge', false)])
  const live = grouping.getSnapshot().get('repo-key')!
  expect(live.title).toBe('Forge')
  expect(live.members.map((m) => m.projectId)).toEqual(['forge'])
})

it('rejoins the repository group when the project is restored', () => {
  const { grouping, update } = attach([project('forge', 'Forge', false), project('old', 'Old', true)])
  update([project('forge', 'Forge', false), project('old', 'Old', false)])
  expect(grouping.getSnapshot().get('repo-key')!.members.map((m) => m.projectId).sort()).toEqual(['forge', 'old'])
})
