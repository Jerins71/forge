import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TerminalMeta } from '@forge/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getTerminalLogPath,
  getTerminalMetaPath,
  getTerminalSnapshotPath,
} from '../../swarm/data-paths.js'
import { TerminalPersistence } from '../terminal-persistence.js'

const createdDirs: string[] = []

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function createMeta(overrides: Partial<TerminalMeta> = {}): TerminalMeta {
  return {
    version: 1,
    terminalId: overrides.terminalId ?? 'terminal-1',
    sessionAgentId: overrides.sessionAgentId ?? 'manager-1',
    profileId: overrides.profileId ?? 'profile-1',
    name: overrides.name ?? 'Terminal 1',
    shell: overrides.shell ?? '/bin/sh',
    shellArgs: overrides.shellArgs ?? ['-i'],
    cwd: overrides.cwd ?? '/tmp',
    cols: overrides.cols ?? 80,
    rows: overrides.rows ?? 24,
    state: overrides.state ?? 'running',
    pid: overrides.pid ?? 123,
    exitCode: overrides.exitCode ?? null,
    exitSignal: overrides.exitSignal ?? null,
    checkpointSeq: overrides.checkpointSeq ?? 0,
    nextSeq: overrides.nextSeq ?? 1,
    recoveredFromPersistence: overrides.recoveredFromPersistence ?? false,
    createdAt: overrides.createdAt ?? '2026-03-25T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-03-25T00:00:00.000Z',
  }
}

async function createPersistence(): Promise<{ dataDir: string; persistence: TerminalPersistence }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'terminal-persistence-'))
  createdDirs.push(dataDir)
  return {
    dataDir,
    persistence: new TerminalPersistence({
      dataDir,
      scrollbackLines: 5_000,
      journalMaxBytes: 1_048_576,
    }),
  }
}

describe('TerminalPersistence', () => {

  it('restores state by replaying snapshot data plus journal delta after checkpointSeq', async () => {
    const source = await createPersistence()
    const restored = await createPersistence()
    const meta = createMeta({ checkpointSeq: 2, nextSeq: 5 })

    source.persistence.createMirror(meta)
    await source.persistence.writeToMirror(meta.terminalId, Buffer.from('snapshot line\r\n', 'utf8'))
    await source.persistence.writeSnapshot(meta)
    await source.persistence.appendJournal(meta, 1, Buffer.from('ignored-before-checkpoint', 'utf8'))
    await source.persistence.appendJournal(meta, 3, Buffer.from('delta a\r\n', 'utf8'))
    await source.persistence.appendJournal(meta, 4, Buffer.from('delta b', 'utf8'))

    const restoredSnapshotPath = getTerminalSnapshotPath(restored.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId)
    const restoredLogPath = getTerminalLogPath(restored.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId)
    await mkdir(dirname(restoredSnapshotPath), { recursive: true })
    await writeFile(restoredSnapshotPath, (await source.persistence.readSnapshot(meta)) ?? '', 'utf8')
    await writeFile(
      restoredLogPath,
      await readFile(getTerminalLogPath(source.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId), 'utf8'),
      'utf8',
    )

    const replayed = await restored.persistence.restoreMirror(meta)
    const text = replayed.replay.toString('utf8')

    expect(text).toContain('snapshot line')
    expect(text).toContain('delta a')
    expect(text).toContain('delta b')
    expect(text).not.toContain('ignored-before-checkpoint')
    expect(replayed.lastSeq).toBe(4)
  })

  it('saves and loads terminal meta round-trip', async () => {
    const { dataDir, persistence } = await createPersistence()
    const meta = createMeta({ terminalId: 'terminal-meta', name: 'Build terminal', nextSeq: 42 })

    await persistence.saveMeta(meta)
    const loaded = await persistence.loadMeta(
      getTerminalMetaPath(dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId),
    )

    expect(loaded).toEqual(meta)
  })

  it('moves persisted terminal data to a new manager scope', async () => {
    const { dataDir, persistence } = await createPersistence()
    const meta = createMeta({ terminalId: 'terminal-move', sessionAgentId: 'session-2' })

    await persistence.saveMeta(meta)
    await writeFile(
      getTerminalSnapshotPath(dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId),
      'snapshot-content',
      'utf8',
    )
    await writeFile(
      getTerminalLogPath(dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId),
      '{"seq":1,"dataBase64":"YQ=="}\n',
      'utf8',
    )

    await persistence.moveTerminalScope(meta, 'profile-1')

    const movedMetaRaw = await readFile(getTerminalMetaPath(dataDir, meta.profileId, 'profile-1', meta.terminalId), 'utf8')
    const movedMeta = JSON.parse(movedMetaRaw) as TerminalMeta

    expect(movedMeta.terminalId).toBe('terminal-move')
    expect(movedMeta.sessionAgentId).toBe('profile-1')
    await expect(
      readFile(getTerminalSnapshotPath(dataDir, meta.profileId, 'profile-1', meta.terminalId), 'utf8'),
    ).resolves.toBe('snapshot-content')
    await expect(
      readFile(getTerminalLogPath(dataDir, meta.profileId, 'profile-1', meta.terminalId), 'utf8'),
    ).resolves.toContain('"seq":1')
    await expect(
      readFile(getTerminalMetaPath(dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
