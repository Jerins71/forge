import { describe, expect, it } from 'vitest'
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import {
  decodeEnvironmentValue, ProjectSummarySchema, ShellStreamItemSchema,
  RpcClientFrameSchema, rpcRegistry,
} from '../environment-v2.js'

const project = {
  projectId: 'project', title: 'Project', cwd: '/fixture', repository: null,
  isGit: false, defaultBranch: null, updatedAt: '2026-10-04T00:00:00.000Z',
  sortKey: 'project', archived: false,
}
describe('V2 additive compatibility', () => {
  it('lets an older project contract decode a newer defaultModel without changing producer validation', () => {
    const oldProjectSchema = Type.Omit(ProjectSummarySchema, ['defaultModel'])
    const newerProject = { ...project, defaultModel: { provider: 'codex-native', modelId: 'gpt-6-sol', thinkingLevel: 'high' } }
    expect(Value.Check(oldProjectSchema, newerProject)).toBe(false)
    expect(decodeEnvironmentValue(oldProjectSchema, newerProject)).toEqual(project)
    expect(newerProject).toHaveProperty('defaultModel')
  })
  it('cleans strict stream and nested object unions without mutating payloads or schemas', () => {
    const item = { kind: 'event', streamEpoch: '00000000-0000-4000-8000-000000000001', sequence: 1,
      event: { type: 'project.upsert', project: { ...project,
        repository: { canonicalRemote: 'https://fixture.invalid/repo.git', subpath: '', key: 'repo', futureField: 1 },
        futureField: 1 }, futureField: 1 }, futureField: 1 }
    const before = structuredClone(item)
    expect(Value.Check(ShellStreamItemSchema, item)).toBe(false)
    const decoded = decodeEnvironmentValue(ShellStreamItemSchema, item)
    expect(decoded).toEqual({ ...item, futureField: undefined,
      event: { ...item.event, futureField: undefined, project: { ...item.event.project, futureField: undefined,
        repository: { ...item.event.project.repository, futureField: undefined } } } })
    expect(decoded).not.toHaveProperty('futureField')
    expect(item).toEqual(before)
    expect(Value.Check(ShellStreamItemSchema, item)).toBe(false)
    expect(Value.Check(ShellStreamItemSchema, decoded)).toBe(true)
  })
  it('preserves intentionally open legacy response records while cleaning their outer envelope', () => {
    const output = { events: [{ type: 'test', futureField: 'legacy' }], futureField: 'v2' }
    expect(decodeEnvironmentValue(rpcRegistry['legacy.session.operate'].output, output)).toEqual({ events: output.events })
  })
  it('does not repair invalid known fields or accept unknown request methods', () => {
    for (const value of [{ ...project, title: 42, futureField: 1 }, { ...project, projectId: '', futureField: 1 }, { ...project, archived: undefined, futureField: 1 }])
      expect(decodeEnvironmentValue(ProjectSummarySchema, value)).toBeUndefined()
    expect(decodeEnvironmentValue(RpcClientFrameSchema, { type: 'request', requestId: 'test', method: 'future.method', input: {}, futureField: 1 })).toBeUndefined()
  })
})
