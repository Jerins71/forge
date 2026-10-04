import { describe, expect, it } from 'vitest'
import { LeaseManager } from '../src/runtime/lease-manager.js'
import { FakeStorage, fakeChrome } from './fakes.js'

const tab = (id: number, active = false) => ({ id, windowId: 1, active, title: `Tab ${id}`, url: `https://tab-${id}.invalid/` })

describe('per-tab compare-and-set authority', () => {

  it('persists an opaque exact release receipt across payload and full browser restart', async () => {
    const session = new FakeStorage()
    const local = new FakeStorage()
    const tabs = [tab(1)]
    const first = new LeaseManager(fakeChrome({ tabs, session, local }), 'payload-a')
    await first.acquire({ tabId: 1, ownerId: 'owner', ownerEpoch: 4, sessionAgentId: 'session', expectedOwnerEpoch: 0 })
    await expect(first.releaseOwner('owner', 4)).resolves.toEqual([1])
    expect(first.all()).toEqual([])
    expect(JSON.stringify(local.values)).not.toMatch(/https:|Tab 1|session/u)

    // A full Chrome restart clears storage.session but preserves storage.local.
    const restarted = new LeaseManager(fakeChrome({ tabs, session: new FakeStorage(), local }), 'payload-b')
    await restarted.recover()
    expect(restarted.all()).toEqual([])
    expect(restarted.releaseScope('owner', 4)).toEqual([1])
    await expect(restarted.releaseOwner('owner', 4)).resolves.toEqual([1])
    expect(restarted.all()).toEqual([])
  })

  it('does not forget authority or acknowledge release when durable receipt storage fails', async () => {
    class FailingStorage extends FakeStorage {
      failNextSet = true
      override async set(items: Record<string, unknown>): Promise<void> {
        if (this.failNextSet) { this.failNextSet = false; throw new Error('durable write failed') }
        await super.set(items)
      }
    }
    const session = new FakeStorage()
    const local = new FailingStorage()
    const manager = new LeaseManager(fakeChrome({ tabs: [tab(1)], session, local }), 'payload')
    await manager.acquire({ tabId: 1, ownerId: 'owner', ownerEpoch: 4, sessionAgentId: 'session', expectedOwnerEpoch: 0 })

    await expect(manager.releaseOwner('owner', 4)).rejects.toThrow('durable write failed')
    expect(manager.all()).toEqual([expect.objectContaining({ tabId: 1, ownerId: 'owner' })])
    expect(manager.releaseScope('owner', 4)).toEqual([1])
    await expect(manager.releaseOwner('owner', 4)).resolves.toEqual([1])
    expect(manager.all()).toEqual([])
  })

  it('excludes tabs leased to another session while retaining this session and unleased tabs', async () => {
    const tabs = [{ ...tab(1, true), lastAccessed: 30 }, { ...tab(2), lastAccessed: 20 }, { ...tab(3), lastAccessed: 10 }]
    const chrome = fakeChrome({ tabs, windows: [{ id: 1, focused: false, type: 'normal', tabs }] })
    const manager = new LeaseManager(chrome, 'payload')
    await manager.acquire({ tabId: 1, ownerId: 'owner-a', ownerEpoch: 1, sessionAgentId: 'session-a', expectedOwnerEpoch: 0 })
    await manager.acquire({ tabId: 2, ownerId: 'owner-b', ownerEpoch: 1, sessionAgentId: 'session-b', expectedOwnerEpoch: 0 })

    await expect(manager.eligibleTabs('session-a')).resolves.toMatchObject({ tabs: [{ tabId: 1 }, { tabId: 3 }] })
    await expect(manager.eligibleTabs('session-b')).resolves.toMatchObject({ tabs: [{ tabId: 2 }, { tabId: 3 }] })
  })

  it('blocks ordinary restricted tabs without exact Forge-created neutral authority', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 1, windowId: 1, active: true, url: 'about:blank' }] })
    const manager = new LeaseManager(chrome, 'payload')
    await expect(manager.acquire({
      tabId: 1, ownerId: 'owner', ownerEpoch: 1, sessionAgentId: 'session', expectedOwnerEpoch: 0,
    })).rejects.toMatchObject({ code: 'restricted-target' })
    expect(manager.all()).toEqual([])
  })
})
