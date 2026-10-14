/**
 * Failure modes: favorites set on one client do not reach another; a malformed or oversized body is
 * stored; a missing or corrupt file breaks reads; concurrent writes interleave into invalid JSON.
 */
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { getSharedModelFavoritesPath } from '../swarm/storage/data-paths.js'
import { readModelFavorites, writeModelFavorites } from '../ws/http/routes/model-favorites-routes.js'

describe('model favorites', () => {
  it('round-trips an ordered, de-duplicated list and starts empty', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'favorites-'))
    expect(await readModelFavorites(dataDir)).toEqual({ favorites: [] })
    await writeModelFavorites(dataDir, { favorites: ['codex-native::gpt-6.1-sol', 'claude-native::claude-opus-5-5', 'codex-native::gpt-6.1-sol'] })
    expect(await readModelFavorites(dataDir)).toEqual({ favorites: ['codex-native::gpt-6.1-sol', 'claude-native::claude-opus-5-5'] })
  })

  it('rejects malformed keys and oversized lists, and reads a corrupt file as empty', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'favorites-'))
    await expect(writeModelFavorites(dataDir, { favorites: ['no-separator'] })).rejects.toThrow(/provider::modelId/)
    await expect(writeModelFavorites(dataDir, { favorites: Array.from({ length: 65 }, (_, i) => `p::m${i}`) })).rejects.toThrow(/at most 64/)
    await expect(writeModelFavorites(dataDir, { nope: true })).rejects.toThrow()
    const path = getSharedModelFavoritesPath(dataDir)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{not json')
    expect(await readModelFavorites(dataDir)).toEqual({ favorites: [] })
  })
})
