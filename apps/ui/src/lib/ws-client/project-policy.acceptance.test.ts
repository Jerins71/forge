import { expect, it, vi } from 'vitest'
import { ManagerWsClient } from '../ws-client'
import type { EnvironmentClient } from '@forge/client-runtime'
import { projectShell } from './environment-projection'

it('addresses project mutations without a selected session and gates unsupported peers', async () => {
  const request = vi.fn(async (method, input) => ({ commandId: input.commandId, method, sessionId: null, state: 'succeeded', result: { projectId: input.projectId }, delivery: 'none' }))
  const facade = Object.create(ManagerWsClient.prototype) as ManagerWsClient
  Object.assign(facade, { environmentClient: { descriptor: () => ({ capabilities: { projectPolicy: true } }), request } as unknown as EnvironmentClient, intentCommandIds: new Map() })
  await facade.renameProfile('project-1', 'New title')
  expect(request).toHaveBeenCalledWith('project.update', expect.objectContaining({ projectId: 'project-1', patch: { title: 'New title' } }))
  Object.assign(facade, { environmentClient: { descriptor: () => ({ capabilities: {} }), request } as unknown as EnvironmentClient })
  await expect(facade.renameProfile('project-1', 'Other')).rejects.toThrow(/update/i)
  expect(request).toHaveBeenCalledTimes(1)
})
it('projects default-session identity, order and exact policy on bootstrap and live replacement', () => {
  const projects = new Map([['p', { projectId: 'p', title: 'Project', cwd: '/fixture', updatedAt: '2026-10-10T00:00:00Z', sortKey: '3', archived: false, repository: null, isGit: false, defaultBranch: null, defaultSessionId: 'default', delegationDefaults: { managerPosture: 'hands_on', rosterId: 'roster' }, contextMode: 'fresh' as const }]])
  const shell = { projects, sessions: new Map(), sessionIdsByProject: new Map(), complete: true } as unknown as Parameters<typeof projectShell>[0]
  const first = projectShell(shell, []).profiles[0]
  expect(first).toMatchObject({ defaultSessionAgentId: 'default', defaultContextMode: 'fresh', defaultManagerPosture: 'hands_on', defaultDelegationRosterId: 'roster', sortOrder: 3 })
  expect(projectShell(shell, [], [first]).profiles[0]).toEqual(first)
})
