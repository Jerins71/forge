import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentClient } from '@forge/client-runtime'
import type { CodexCatalogSnapshot } from '@forge/protocol'
import { fetchCodexCatalogWithCache, getCachedCodexCatalog, subscribeCodexCatalog } from './codex-catalog-cache'

// Ways a partial catalog can go wrong, each covered below:
// 1. The picker keeps the partial list until the user reopens it.
// 2. A server that keeps answering "not finished" is polled forever.
// 3. A finished catalog is fetched again for nothing.
// 4. The second fetch lands but an open picker is never told.
// 5. A partial snapshot is treated as fresh, so the next open does not ask again.

const plugin = (selector: string) => ({ selector, displayName: selector })
const snapshot = (selectors: string[], complete?: false): CodexCatalogSnapshot =>
  ({ apps: [], plugins: selectors.map(plugin), tools: [], fetchedAt: new Date().toISOString(), ...(complete === false ? { complete } : {}) })

let environment = 0
/** A client whose catalog answers come from a queue; the last answer repeats. */
function clientReturning(answers: CodexCatalogSnapshot[]) {
  const codexCatalog = vi.fn(async () => answers.length > 1 ? answers.shift()! : answers[0]!)
  const client = { environmentId: `env-${++environment}`, features: { sessions: { codexCatalog } } } as unknown as EnvironmentClient
  return { client, codexCatalog }
}

describe('codex catalog cache: partial answers', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('asks once more after a partial answer and tells subscribers when the rest arrives', async () => {
    const { client, codexCatalog } = clientReturning([snapshot([], false), snapshot(['fireflies'])])
    const seen: number[] = []
    const unsubscribe = subscribeCodexCatalog(client, 'manager', (value) => seen.push(value.plugins.length))
    const first = await fetchCodexCatalogWithCache(client, 'manager')
    expect(first).toMatchObject({ status: 'ok', snapshot: { plugins: [], complete: false } })
    expect(codexCatalog).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(codexCatalog).toHaveBeenCalledTimes(2)
    expect(getCachedCodexCatalog(client, 'manager')?.plugins.map((value) => value.selector)).toEqual(['fireflies'])
    expect(seen).toEqual([0, 1])
    unsubscribe()
  })

  it('does not keep polling a server that stays unfinished', async () => {
    const { client, codexCatalog } = clientReturning([snapshot(['a'], false)])
    await fetchCodexCatalogWithCache(client, 'manager')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(codexCatalog).toHaveBeenCalledTimes(2)
  })

  it('does not ask again after a finished answer', async () => {
    const { client, codexCatalog } = clientReturning([snapshot(['a'])])
    await fetchCodexCatalogWithCache(client, 'manager')
    // A fresh finished snapshot is served from the cache.
    await fetchCodexCatalogWithCache(client, 'manager')
    expect(codexCatalog).toHaveBeenCalledTimes(1)
    // And nothing is scheduled behind it.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(codexCatalog).toHaveBeenCalledTimes(1)
  })

  it('never serves a partial snapshot as fresh', async () => {
    const { client, codexCatalog } = clientReturning([snapshot([], false), snapshot([], false), snapshot(['a'])])
    await fetchCodexCatalogWithCache(client, 'manager')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(codexCatalog).toHaveBeenCalledTimes(2)
    // Still partial after the one automatic retry: the next open asks the server instead of trusting it.
    const next = await fetchCodexCatalogWithCache(client, 'manager')
    expect(codexCatalog).toHaveBeenCalledTimes(3)
    expect(next).toMatchObject({ status: 'ok', snapshot: { plugins: [{ selector: 'a' }] } })
  })
})
