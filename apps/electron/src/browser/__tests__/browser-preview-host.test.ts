import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS,
  BROWSER_PREVIEW_MAX_CARDS,
  type BrowserPreviewScope,
} from '@forge/protocol'
import type { AutomaticBrowserControlObservation } from '../automatic-browser-host.js'
import { BROWSER_PREVIEW_IPC } from '../browser-bridge-contract.js'
import { BrowserPreviewHost } from '../browser-preview-host.js'

class FakeWindow {
  destroyed = false
  visible = true
  minimized = false
  send = vi.fn()
  readonly webContents = {
    id: Math.floor(Math.random() * 10_000),
    isDestroyed: () => this.destroyed,
    isLoadingMainFrame: () => false,
    mainFrame: { detached: false, isDestroyed: () => this.destroyed, send: this.send },
  }
  isDestroyed(): boolean { return this.destroyed }
  isVisible(): boolean { return this.visible }
  isMinimized(): boolean { return this.minimized }
}

const identity = { workspaceEpoch: 7, sessionAgentId: 'session-1', profileId: 'profile-1' }

function scope(tabs: BrowserPreviewScope['tabs'], overrides: Partial<BrowserPreviewScope> = {}) {
  return {
    ...identity,
    scope: { hostGeneration: 3, sessionRevision: 4, connected: true, tabs, ...overrides },
  }
}

function managed(tabId: string, presented = true): BrowserPreviewScope['tabs'][number] {
  return { tabId, targetAffinity: 'managed-electron', lifecycle: 'ready', label: `Managed ${tabId}`, presented }
}

function chrome(tabId: string): BrowserPreviewScope['tabs'][number] {
  return { tabId, targetAffinity: 'external-chrome', lifecycle: 'ready', label: null, presented: false }
}

function control(
  tabId: string,
  targetAffinity: 'managed-electron' | 'external-chrome',
  state: 'active' | 'idle' = 'active',
): AutomaticBrowserControlObservation {
  return {
    session: { sessionAgentId: identity.sessionAgentId, profileId: identity.profileId },
    tabId,
    hostGeneration: 3,
    targetAffinity,
    state,
  }
}

function release(tabId: string | null = null): AutomaticBrowserControlObservation {
  return {
    session: { sessionAgentId: identity.sessionAgentId, profileId: identity.profileId },
    tabId,
    hostGeneration: null,
    targetAffinity: tabId ? 'managed-electron' : null,
    state: 'released',
    reason: 'turn-ended',
  }
}

function observation(tabId: string, overrides: Record<string, unknown> = {}) {
  return {
    session: { sessionAgentId: identity.sessionAgentId, profileId: identity.profileId },
    tabId,
    hostGeneration: 3,
    contentEpoch: 0,
    screenshot: { mimeType: 'image/png' as const, data: 'eA==', width: 1, height: 1 },
    ...overrides,
  }
}

function setup(now = { value: 0 }) {
  const windows: FakeWindow[] = [new FakeWindow()]
  const manager = {
    tryCapturePreviewFrame: vi.fn(async () => ({ status: 'captured' as const, data: 'eA==', width: 640, height: 360 })),
  }
  const host = new BrowserPreviewHost({
    manager: manager as never,
    getWindow: () => windows[0] as never,
    now: () => now.value,
  })
  return { host, manager, windows, now }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserPreviewHost', () => {
  it('automatically admits only exact controlled tabs, enforces capacity, and applies managed pull backpressure', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    const tabs = Array.from({ length: BROWSER_PREVIEW_MAX_CARDS + 1 }, (_, index) => managed(`managed-${index + 1}`, index === 0))
    fixture.host.publishScope(scope(tabs))
    expect(fixture.host.getSnapshot()).toBeNull()

    fixture.host.observeAgentControl(control('fabricated', 'managed-electron'))
    expect(fixture.host.getSnapshot()).toBeNull()
    fixture.host.observeAgentControl(release('fabricated'))

    fixture.host.observeAgentControl(control('managed-1', 'managed-electron'))
    const opened = fixture.host.getSnapshot()!
    expect(opened).toMatchObject({ previewGeneration: 1, cards: [{ tabId: 'managed-1', state: 'delayed' }] })
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(fixture.manager.tryCapturePreviewFrame).toHaveBeenCalledTimes(1)
    const captured = fixture.host.getSnapshot()!
    expect(captured.cards[0]).toMatchObject({ hasFrame: true, frameSequence: 1, width: 640, height: 360, state: 'updating' })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(fixture.manager.tryCapturePreviewFrame).toHaveBeenCalledTimes(1)
    expect(fixture.host.pullFrame({ previewGeneration: captured.previewGeneration, tabId: 'managed-1', sequence: 1 }))
      .toMatchObject({ data: 'eA==', sequence: 1 })
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(fixture.manager.tryCapturePreviewFrame).toHaveBeenCalledTimes(2)

    fixture.host.observeAgentControl(control('managed-1', 'managed-electron', 'idle'))
    for (let index = 2; index <= BROWSER_PREVIEW_MAX_CARDS; index += 1) {
      fixture.host.observeAgentControl(control(`managed-${index}`, 'managed-electron'))
      fixture.host.observeAgentControl(control(`managed-${index}`, 'managed-electron', 'idle'))
    }
    fixture.host.observeAgentControl(control(`managed-${BROWSER_PREVIEW_MAX_CARDS + 1}`, 'managed-electron'))
    expect(fixture.host.getSnapshot()?.cards).toHaveLength(BROWSER_PREVIEW_MAX_CARDS)
    expect(fixture.host.getSnapshot()?.cards.map((card) => card.tabId)).toContain(`managed-${BROWSER_PREVIEW_MAX_CARDS + 1}`)
    expect(fixture.host.getSnapshot()?.cards.map((card) => card.tabId)).not.toContain('managed-1')
    expect(fixture.windows[0]?.send).toHaveBeenCalledWith(
      BROWSER_PREVIEW_IPC.snapshotChanged,
      expect.objectContaining({ cards: expect.arrayContaining([expect.objectContaining({ tabId: `managed-${BROWSER_PREVIEW_MAX_CARDS + 1}` })]) }),
    )
  })

  it('holds a bounded control signal until canonical scope catches up', () => {
    const fixture = setup()
    fixture.host.publishScope(scope([], { sessionRevision: 1 }))
    fixture.host.observeAgentControl(control('managed-late', 'managed-electron'))
    expect(fixture.host.getSnapshot()).toBeNull()

    fixture.host.publishScope(scope([managed('managed-late')], { sessionRevision: 2 }))
    expect(fixture.host.getSnapshot()).toMatchObject({
      cards: [{ tabId: 'managed-late', targetAffinity: 'managed-electron' }],
    })
  })

  it('retains the first exact Chrome snapshot until canonical scope catches up', () => {
    const fixture = setup()
    fixture.host.publishScope(scope([], { sessionRevision: 1 }))
    fixture.host.observeAgentControl(control('chrome-late', 'external-chrome'))
    fixture.host.observeExternalSnapshot(observation('chrome-late') as never)
    expect(fixture.host.getSnapshot()).toBeNull()

    fixture.host.publishScope(scope([chrome('chrome-late')], { sessionRevision: 2 }))
    const admitted = fixture.host.getSnapshot()!
    expect(admitted).toMatchObject({
      cards: [{ tabId: 'chrome-late', targetAffinity: 'external-chrome', state: 'updating', hasFrame: true }],
    })
    expect(fixture.host.pullFrame({
      previewGeneration: admitted.previewGeneration,
      tabId: 'chrome-late',
      sequence: admitted.cards[0]!.frameSequence,
    })).toMatchObject({ data: 'eA==', ageMsAtDelivery: 0 })
  })

  it('expires a pending Chrome snapshot from its original receipt time', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    fixture.host.publishScope(scope([], { sessionRevision: 1 }))
    fixture.host.observeAgentControl(control('chrome-late', 'external-chrome'))
    fixture.host.observeExternalSnapshot(observation('chrome-late') as never)

    fixture.now.value = BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS
    await vi.advanceTimersByTimeAsync(BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS)
    fixture.host.publishScope(scope([chrome('chrome-late')], { sessionRevision: 2 }))
    expect(fixture.host.getSnapshot()).toBeNull()
  })

  it('admits only a bounded exact Chrome snapshot and removes the card when pixels expire', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    fixture.host.publishScope(scope([chrome('chrome-1')]))
    fixture.host.observeAgentControl(control('chrome-1', 'external-chrome'))
    expect(fixture.host.getSnapshot()).toBeNull()

    fixture.host.observeExternalSnapshot(observation('chrome-1', {
      session: { sessionAgentId: 'other-session', profileId: identity.profileId },
    }) as never)
    expect(fixture.host.getSnapshot()).toBeNull()
    fixture.host.observeExternalSnapshot(observation('chrome-1') as never)
    expect(fixture.host.getSnapshot()?.cards[0]).toMatchObject({ state: 'updating', hasFrame: true, frameSequence: 1 })

    fixture.now.value = BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS
    await vi.advanceTimersByTimeAsync(BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS)
    expect(fixture.host.getSnapshot()).toBeNull()
  })

  it('blocks previews admitted while locked and resumes automatically after unlock', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    fixture.host.publishScope(scope([managed('managed-1'), chrome('chrome-1')]))
    fixture.host.clearSensitiveContent()
    fixture.host.observeAgentControl(control('managed-1', 'managed-electron'))
    fixture.host.observeAgentControl(control('chrome-1', 'external-chrome'))
    fixture.host.observeExternalSnapshot(observation('chrome-1') as never)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(fixture.manager.tryCapturePreviewFrame).not.toHaveBeenCalled()
    expect(fixture.host.getSnapshot()).toMatchObject({
      hiddenContent: true,
      cards: [{ tabId: 'managed-1', hasFrame: false }],
    })

    fixture.host.restoreSensitiveContent()
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(fixture.manager.tryCapturePreviewFrame).toHaveBeenCalledOnce()
    expect(fixture.host.getSnapshot()).toMatchObject({ hiddenContent: false })
  })

  it('drops external pixels captured before a privacy clear even after content is restored', () => {
    const fixture = setup()
    fixture.host.publishScope(scope([chrome('chrome-1')]))
    fixture.host.observeAgentControl(control('chrome-1', 'external-chrome'))
    const preClearEpoch = fixture.host.currentContentEpoch

    fixture.host.clearSensitiveContent()
    fixture.host.restoreSensitiveContent()
    fixture.host.observeExternalSnapshot(observation('chrome-1', { contentEpoch: preClearEpoch }) as never)
    expect(fixture.host.getSnapshot()).toBeNull()

    fixture.host.observeExternalSnapshot(observation('chrome-1', {
      contentEpoch: fixture.host.currentContentEpoch,
    }) as never)
    expect(fixture.host.getSnapshot()?.cards[0]).toMatchObject({ hasFrame: true, state: 'updating' })
  })

  it('discards a managed capture across the lock boundary and resumes automatically after unlock', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    const capture = Promise.withResolvers<{ status: 'captured'; data: string; width: number; height: number }>()
    fixture.manager.tryCapturePreviewFrame.mockImplementationOnce(() => capture.promise)
    fixture.host.publishScope(scope([managed('managed-1')]))
    fixture.host.observeAgentControl(control('managed-1', 'managed-electron'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.manager.tryCapturePreviewFrame).toHaveBeenCalledTimes(1)

    fixture.host.clearSensitiveContent()
    expect(fixture.host.getSnapshot()).toMatchObject({ hiddenContent: true, cards: [{ hasFrame: false, state: 'paused' }] })
    capture.resolve({ status: 'captured', data: 'eA==', width: 640, height: 360 })
    await flush()
    expect(fixture.host.getSnapshot()?.cards[0]).toMatchObject({ hasFrame: false })

    fixture.host.restoreSensitiveContent()
    expect(fixture.host.getSnapshot()).toMatchObject({ hiddenContent: false, cards: [{ state: 'delayed' }] })
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(fixture.manager.tryCapturePreviewFrame).toHaveBeenCalledTimes(2)
    expect(fixture.host.getSnapshot()?.cards[0]).toMatchObject({ frameSequence: 1, hasFrame: true })
  })

  it('ignores stale scope revisions and removes confirmed cards when canonical scope closes them', () => {
    const fixture = setup()
    fixture.host.publishScope(scope([managed('managed-1')], { sessionRevision: 6 }))
    fixture.host.observeAgentControl(control('managed-1', 'managed-electron'))
    fixture.host.publishScope(scope([{ ...managed('managed-1'), label: 'Newest label' }], { sessionRevision: 7 }))
    fixture.host.publishScope(scope([], { sessionRevision: 6 }))
    expect(fixture.host.getSnapshot()?.cards).toEqual([
      expect.objectContaining({ tabId: 'managed-1', label: 'Newest label' }),
    ])

    fixture.host.publishScope(scope([], { sessionRevision: 8 }))
    expect(fixture.host.getSnapshot()).toBeNull()
  })

  it('clears the automatic deck at turn end without closing the main window', () => {
    const fixture = setup()
    fixture.host.publishScope(scope([managed('managed-1'), chrome('chrome-1')]))
    fixture.host.observeAgentControl(control('managed-1', 'managed-electron', 'idle'))
    fixture.host.observeAgentControl(control('chrome-1', 'external-chrome', 'idle'))
    fixture.host.observeExternalSnapshot(observation('chrome-1') as never)
    expect(fixture.host.getSnapshot()?.cards).toHaveLength(2)
    fixture.windows[0]!.send.mockClear()

    fixture.host.observeAgentControl(release())

    expect(fixture.host.getSnapshot()).toBeNull()
    expect(fixture.windows[0]!.send).toHaveBeenCalledWith(BROWSER_PREVIEW_IPC.snapshotChanged, null)
    expect(fixture.windows[0]!.destroyed).toBe(false)
  })
})
