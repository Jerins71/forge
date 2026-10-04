import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskNotesStore } from '../task-notes-store.js';
const failures = vi.hoisted(() => ({ rename: false }))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (failures.rename) { failures.rename = false; throw new Error('simulated atomic replace failure') }
    return actual.rename(...args)
  } }
})
let dataDir: string
const scope = { profileId: 'project', sessionAgentId: 'task', actorAgentId: 'task' }
const actor = (overrides = {}) => new TaskNotesStore({ dataDir }).forActor({ ...scope, ...overrides })
beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'forge-task-notes-')) })
afterEach(async () => { failures.rename = false; await rm(dataDir, { recursive: true, force: true }) })
describe('task-local notes', () => {
  it('restores exact text, revision and digest after restart separately from durable memory', async () => {
    const receipt = await actor().write({ path: 'checkpoint.md', text: 'Objective: fix navigation.\nNext: test ✨', expectedRevision: 0 })
    expect(await actor().read({ path: 'checkpoint.md' })).toMatchObject({ ...receipt, text: 'Objective: fix navigation.\nNext: test ✨' })
    const hint = await actor().checkpointHint()
    expect(hint).toMatchObject({ ready: true, empty: false, revision: 1, notes: [receipt] })
    expect(hint.hint).toContain('notes.read with path="checkpoint.md"')
  })
  it('serializes parallel appends through independently constructed store clients', async () => {
    await actor().write({ path: 'log.md', text: '' })
    await Promise.all(Array.from({ length: 30 }, (_, i) => actor().append({ path: 'log.md', text: `[${i}]` })))
    const read = await actor().read({ path: 'log.md' })
    expect(read.revision).toBe(31)
    for (let i = 0; i < 30; i++) expect(read.text.split(`[${i}]`)).toHaveLength(2)
  })
  it('keeps the previous snapshot on failed atomic replacement and recovers on retry', async () => {
    const notes = actor()
    await notes.write({ path: 'checkpoint.md', text: 'durable old state' })
    failures.rename = true
    await expect(notes.write({ path: 'checkpoint.md', text: 'uncommitted state' })).rejects.toThrow('replace failure')
    expect((await actor().read({ path: 'checkpoint.md' })).text).toBe('durable old state')
    await notes.append({ path: 'checkpoint.md', text: '\nretry works' })
    expect((await actor().read({ path: 'checkpoint.md' })).revision).toBe(2)
  })
  it.each(['../escape', 'C:/escape'])('rejects unsafe virtual path %j', async path => {
    await expect(actor().write({ path, text: 'denied' })).rejects.toThrow('virtual task note path')
  })
  it('rejects symlink files and directories without modifying their target', async () => {
    const notes = actor(); await notes.write({ path: 'checkpoint.md', text: 'safe' })
    const outside = join(dataDir, 'outside.json'); await writeFile(outside, 'private outside payload')
    await rm(notes.filePath); await symlink(outside, notes.filePath)
    expect((await notes.checkpointHint()).ready).toBe(false)
    await expect(notes.write({ path: 'checkpoint.md', text: 'replacement' })).rejects.toThrow('Unsafe')
    expect(await readFile(outside, 'utf8')).toBe('private outside payload')
    await rm(notes.directory, { recursive: true }); await symlink(dataDir, notes.directory, 'dir')
    await expect(notes.list()).rejects.toThrow('Unsafe')
  })
})
