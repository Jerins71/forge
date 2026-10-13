import { describe, expect, it } from 'vitest'
import type { EnvironmentRegistry } from '@forge/client-runtime'
import { sharedProjects } from './config-sync'
// Failure modes: manual sidebar merges impersonating repo identity, duplicate clones, and forks.
function registry(projects: Record<string, { projectId: string; repository: { canonicalRemote: string; subpath: string; key: string; verifiedForSync?: boolean } | null }[]>): EnvironmentRegistry {
  return {
    get: (id: string) => ({ shell: { getSnapshot: () => ({ projects: new Map(projects[id]!.map(p => [p.projectId, p])) }) } }),
    logicalProjects: { getSnapshot: () => new Map([['manual', { key: 'manual', members: Object.entries(projects).flatMap(([environmentId, list]) => list.map(p => ({ environmentId, projectId: p.projectId }))) }]]) },
  } as unknown as EnvironmentRegistry
}
const repo = (canonicalRemote: string) => ({ canonicalRemote, subpath: '', key: canonicalRemote, verifiedForSync: true })
describe('sync project authority', () => {
  it('manual grouping never shares projects with missing or unverified remotes', () => {
    expect([...sharedProjects(registry({ a: [{ projectId: 'p', repository: null }], b: [{ projectId: 'q', repository: null }] }), ['a', 'b']).values()].every(map => !map.size)).toBe(true)
  })
  it('matches verified repository identities independently of sidebar grouping, distinguishes forks and rejects duplicate clones', () => {
    const r = registry({ a: [{ projectId: 'p', repository: repo('github.com/owner/repo') }], b: [{ projectId: 'q', repository: repo('github.com/owner/repo') }], c: [{ projectId: 'r', repository: repo('github.com/fork/repo') }] })
    const mapped = sharedProjects(r, ['a', 'b', 'c']); expect(mapped.get('a')!.get('p')).toBe(mapped.get('b')!.get('q')); expect(mapped.get('c')!.size).toBe(0)
    const duplicate = registry({ a: [{ projectId: 'p', repository: repo('github.com/owner/repo') }, { projectId: 'p2', repository: repo('github.com/owner/repo') }], b: [{ projectId: 'q', repository: repo('github.com/owner/repo') }] })
    expect([...sharedProjects(duplicate, ['a', 'b']).values()].every(map => !map.size)).toBe(true)
  })
})
