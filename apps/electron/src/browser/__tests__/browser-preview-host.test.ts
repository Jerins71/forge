import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS,
  BROWSER_PREVIEW_MAX_CARDS,
  type BrowserPreviewScope,
} from '@forge/protocol'
import { BROWSER_PREVIEW_IPC } from '../browser-bridge-contract.js'
import { BrowserPreviewHost } from '../browser-preview-host.js'

class FakeWindow {
  destroyed = false
  visible = true
  minimized = false
  alwaysOnTop = false
  close = vi.fn(() => { this.destroyed = true; this.visible = false })
  showInactive = vi.fn(() => { this.visible = true })
  restore = vi.fn(() => { this.minimized = false })
  setAlwaysOnTop = vi.fn((value: boolean) => { this.alwaysOnTop = value })
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

function observation(tabId: string, overrides: Record<string, unknown> = {}) {
  return {
    session: { sessionAgentId: identity.sessionAgentId, profileId: identity.profileId },
    tabId,
    hostGeneration: 3,
    screenshot: { mimeType: 'image/png' as const, data: 'eA==', width: 1, height: 1 },
    ...overrides,
  }
}

function setup(now = { value: 0 }) {
  const windows: FakeWindow[] = [new FakeWindow()]
  const manager = {
    tryCapturePreviewFrame: vi.fn(async () => ({ status: 'captured' as const, data: 'eA==', width: 640, height: 360 })),
  }
  const promoteManaged = vi.fn(async () => undefined)
  const revealChrome = vi.fn(async () => undefined)
  const host = new BrowserPreviewHost({
    manager: manager as never,
    getWindow: () => windows[0] as never,
    promoteManaged,
    revealChrome,
    now: () => now.value,
  })
  return { host, manager, windows, promoteManaged, revealChrome, now }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserPreviewHost', () => {
  it('opens only canonical cards, enforces capacity, and applies managed pull backpressure', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    const tabs = Array.from({ length: BROWSER_PREVIEW_MAX_CARDS + 1 }, (_, index) => managed(`managed-${index + 1}`, index === 0))
    fixture.host.publishScope(scope(tabs))

    await expect(fixture.host.open({ ...identity, tabId: 'fabricated' })).rejects.toMatchObject({ code: 'tab-not-found' })
    const opened = await fixture.host.open({ ...identity, tabId: 'managed-1' })
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
    await vi.advanceTimersByTimeAsync(999)
    expect(fixture.manager.tryCapturePreviewFrame).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(fixture.manager.tryCapturePreviewFrame).toHaveBeenCalledTimes(2)

    for (let index = 2; index <= BROWSER_PREVIEW_MAX_CARDS; index += 1) {
      await fixture.host.open({ ...identity, tabId: `managed-${index}` })
    }
    await expect(fixture.host.open({ ...identity, tabId: `managed-${BROWSER_PREVIEW_MAX_CARDS + 1}` }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    expect(fixture.windows).toHaveLength(1)
    expect(fixture.windows[0]?.send).toHaveBeenCalledWith(
      BROWSER_PREVIEW_IPC.snapshotChanged,
      expect.objectContaining({ cards: expect.arrayContaining([expect.objectContaining({ tabId: 'managed-1' })]) }),
    )
  })

  it('mirrors only bounded exact Chrome snapshots, ignores them while paused, and expires retained pixels', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    fixture.host.publishScope(scope([chrome('chrome-1')]))
    const opened = await fixture.host.open({ ...identity, tabId: 'chrome-1' })

    fixture.host.observeExternalSnapshot(observation('chrome-1', {
      session: { sessionAgentId: 'other-session', profileId: identity.profileId },
    }) as never)
    expect(fixture.host.getSnapshot()?.cards[0]).toMatchObject({ state: 'waiting', hasFrame: false })
    fixture.host.observeExternalSnapshot(observation('chrome-1') as never)
    expect(fixture.host.getSnapshot()?.cards[0]).toMatchObject({ state: 'updating', hasFrame: true, frameSequence: 1 })

    await fixture.host.handleCommand({ type: 'set-paused', previewGeneration: opened.previewGeneration, paused: true })
    fixture.host.observeExternalSnapshot(observation('chrome-1', {
      screenshot: { mimeType: 'image/png', data: 'eQ==', width: 1, height: 1 },
    }) as never)
    expect(fixture.host.getSnapshot()?.cards[0]).toMatchObject({ state: 'paused', frameSequence: 1 })
    await fixture.host.handleCommand({ type: 'set-paused', previewGeneration: opened.previewGeneration, paused: false })

    fixture.now.value = BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS
    await vi.advanceTimersByTimeAsync(BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS)
    expect(fixture.host.getSnapshot()?.cards[0]).toMatchObject({ state: 'expired', hasFrame: false, frameSequence: 0 })
    expect(fixture.windows[0]?.send).toHaveBeenCalledWith(
      BROWSER_PREVIEW_IPC.snapshotChanged,
      expect.objectContaining({ cards: [expect.objectContaining({ state: 'expired', hasFrame: false })] }),
    )
  })

  it('never reuses external frame identities across privacy clears or card recreation', async () => {
    const fixture = setup()
    fixture.host.publishScope(scope([chrome('chrome-1'), chrome('chrome-2')]))
    const opened = await fixture.host.open({ ...identity, tabId: 'chrome-1' })
    await fixture.host.open({ ...identity, tabId: 'chrome-2' })

    fixture.host.observeExternalSnapshot(observation('chrome-1') as never)
    expect(fixture.host.getSnapshot()?.cards.find((card) => card.tabId === 'chrome-1'))
      .toMatchObject({ frameSequence: 1, hasFrame: true })

    await fixture.host.handleCommand({ type: 'set-hidden-content', previewGeneration: opened.previewGeneration, hidden: true })
    await fixture.host.handleCommand({ type: 'set-hidden-content', previewGeneration: opened.previewGeneration, hidden: false })
    fixture.host.observeExternalSnapshot(observation('chrome-1') as never)
    expect(fixture.host.getSnapshot()?.cards.find((card) => card.tabId === 'chrome-1'))
      .toMatchObject({ frameSequence: 2, hasFrame: true })

    await fixture.host.handleCommand({ type: 'remove', previewGeneration: opened.previewGeneration, tabId: 'chrome-1' })
    const reopened = await fixture.host.open({ ...identity, tabId: 'chrome-1' })
    fixture.host.observeExternalSnapshot(observation('chrome-1') as never)
    expect(reopened.previewGeneration).toBe(opened.previewGeneration)
    expect(fixture.host.getSnapshot()?.cards.find((card) => card.tabId === 'chrome-1'))
      .toMatchObject({ frameSequence: 3, hasFrame: true })
  })

  it('discards a managed capture that crosses a hide and show privacy boundary', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    const capture = Promise.withResolvers<{ status: 'captured'; data: string; width: number; height: number }>()
    fixture.manager.tryCapturePreviewFrame.mockImplementationOnce(() => capture.promise)
    fixture.host.publishScope(scope([managed('managed-1')]))
    const opened = await fixture.host.open({ ...identity, tabId: 'managed-1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.manager.tryCapturePreviewFrame).toHaveBeenCalledTimes(1)

    await fixture.host.handleCommand({ type: 'set-hidden-content', previewGeneration: opened.previewGeneration, hidden: true })
    await fixture.host.handleCommand({ type: 'set-hidden-content', previewGeneration: opened.previewGeneration, hidden: false })
    capture.resolve({ status: 'captured', data: 'eA==', width: 640, height: 360 })
    await flush()

    expect(fixture.host.getSnapshot()).toMatchObject({
      hiddenContent: false,
      cards: [{ frameSequence: 0, hasFrame: false, state: 'delayed' }],
    })
    expect(fixture.manager.tryCapturePreviewFrame).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(fixture.manager.tryCapturePreviewFrame).toHaveBeenCalledTimes(2)
    expect(fixture.host.getSnapshot()?.cards[0]).toMatchObject({ frameSequence: 1, hasFrame: true })
  })

  it('captures a managed card after its source leaves the Browser workspace', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    fixture.host.publishScope(scope([managed('managed-hidden', false)]))
    const opened = await fixture.host.open({ ...identity, tabId: 'managed-hidden' })
    expect(opened.cards[0]).toMatchObject({ presented: false, state: 'delayed' })

    await vi.advanceTimersByTimeAsync(0)
    await flush()

    expect(fixture.manager.tryCapturePreviewFrame).toHaveBeenCalledWith('managed-hidden')
    expect(fixture.host.getSnapshot()?.cards[0])
      .toMatchObject({ presented: false, hasFrame: true, state: 'updating' })
  })

  it('clears sensitive frames and prevents a late prior-generation capture from reappearing or overlapping', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    const capture = Promise.withResolvers<{ status: 'captured'; data: string; width: number; height: number }>()
    fixture.manager.tryCapturePreviewFrame.mockImplementationOnce(() => capture.promise)
    fixture.host.publishScope(scope([managed('managed-1')]))
    const first = await fixture.host.open({ ...identity, tabId: 'managed-1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.manager.tryCapturePreviewFrame).toHaveBeenCalledTimes(1)

    fixture.host.clearSensitiveContent()
    expect(fixture.host.getSnapshot()).toMatchObject({ hiddenContent: true, cards: [{ hasFrame: false, state: 'paused' }] })
    fixture.host.publishScope({ ...scope([managed('managed-1')]), workspaceEpoch: 8 })
    await fixture.host.open({ ...identity, workspaceEpoch: 8, tabId: 'managed-1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.manager.tryCapturePreviewFrame).toHaveBeenCalledTimes(1)

    capture.resolve({ status: 'captured', data: 'eA==', width: 640, height: 360 })
    await flush()
    expect(fixture.host.getSnapshot()?.cards[0]).toMatchObject({ hasFrame: false })
    await vi.advanceTimersByTimeAsync(999)
    expect(fixture.manager.tryCapturePreviewFrame).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(fixture.manager.tryCapturePreviewFrame).toHaveBeenCalledTimes(2)
    expect(first.previewGeneration).not.toBe(fixture.host.getSnapshot()?.previewGeneration)
  })

  it('ignores stale session revisions from the same workspace authority', async () => {
    const fixture = setup()
    fixture.host.publishScope(scope([managed('managed-1')], { sessionRevision: 6 }))
    await fixture.host.open({ ...identity, tabId: 'managed-1' })
    fixture.host.publishScope(scope([{ ...managed('managed-1'), label: 'Newest label' }], { sessionRevision: 7 }))
    fixture.host.publishScope(scope([], { sessionRevision: 6 }))

    expect(fixture.host.getSnapshot()?.cards).toEqual([
      expect.objectContaining({ tabId: 'managed-1', label: 'Newest label' }),
    ])
    expect(fixture.windows[0]?.close).not.toHaveBeenCalled()
  })

  it('publishes a null snapshot instead of closing the main window when the final card is removed', async () => {
    const fixture = setup()
    fixture.host.publishScope(scope([chrome('chrome-1')]))
    const opened = await fixture.host.open({ ...identity, tabId: 'chrome-1' })
    fixture.windows[0]!.send.mockClear()

    await fixture.host.handleCommand({ type: 'remove', previewGeneration: opened.previewGeneration, tabId: 'chrome-1' })

    expect(fixture.host.getSnapshot()).toBeNull()
    expect(fixture.windows[0]!.send).toHaveBeenCalledWith(BROWSER_PREVIEW_IPC.snapshotChanged, null)
    expect(fixture.windows[0]!.close).not.toHaveBeenCalled()
  })

  it('routes shell actions through exact source-specific callbacks without mutating tab ownership', async () => {
    const fixture = setup()
    fixture.host.publishScope(scope([managed('managed-1'), chrome('chrome-1')]))
    const opened = await fixture.host.open({ ...identity, tabId: 'managed-1' })
    await fixture.host.open({ ...identity, tabId: 'chrome-1' })

    await fixture.host.handleCommand({ type: 'promote', previewGeneration: opened.previewGeneration, tabId: 'managed-1' })
    await fixture.host.handleCommand({ type: 'reveal', previewGeneration: opened.previewGeneration, tabId: 'chrome-1' })
    expect(fixture.promoteManaged).toHaveBeenCalledWith({ ...identity, tabId: 'managed-1' })
    expect(fixture.revealChrome).toHaveBeenCalledWith({ sessionAgentId: identity.sessionAgentId, profileId: identity.profileId, tabId: 'chrome-1' })
    await expect(fixture.host.handleCommand({ type: 'reveal', previewGeneration: opened.previewGeneration, tabId: 'managed-1' }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    expect(fixture.host.getSnapshot()?.cards).toHaveLength(2)
  })
})
