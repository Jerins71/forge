import { performance } from 'node:perf_hooks'
import type { BrowserWindow } from 'electron'
import {
  BROWSER_AUTOMATION_MAX_SCREENSHOT_HEIGHT,
  BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH,
  BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS,
  BROWSER_PREVIEW_MANAGED_MAX_HEIGHT,
  BROWSER_PREVIEW_MANAGED_MAX_PNG_BYTES,
  BROWSER_PREVIEW_MANAGED_MAX_WIDTH,
  BROWSER_PREVIEW_MAX_CARDS,
  BROWSER_PREVIEW_TOTAL_IMAGE_BYTES,
  EXTERNAL_CHROME_MAX_SCREENSHOT_BASE64_BYTES,
  type BrowserPreviewDeckSnapshot,
  type BrowserPreviewFrameAvailable,
  type BrowserPreviewFramePayload,
  type BrowserPreviewFramePullRequest,
  type BrowserPreviewOpenRequest,
  type BrowserPreviewScope,
  type BrowserPreviewScopeTab,
  type BrowserPreviewShellCommand,
} from '@forge/protocol'
import type { AutomaticBrowserSnapshotObservation } from './automatic-browser-host.js'
import type { BrowserAutomationManager } from './browser-automation-manager.js'
import { BrowserHostError } from './browser-errors.js'
import { BROWSER_PREVIEW_IPC } from './browser-bridge-contract.js'
import { sendToRendererWindow } from '../renderer-ipc.js'

interface PublishedPreviewScope {
  workspaceEpoch: number
  sessionAgentId: string
  profileId: string
  scope: BrowserPreviewScope
}

interface PreviewFrame {
  sequence: number
  data: string
  width: number
  height: number
  receivedAt: number
  pulled: boolean
}

interface PreviewCard {
  tab: BrowserPreviewScopeTab
  frame: PreviewFrame | null
  state: BrowserPreviewDeckSnapshot['cards'][number]['state']
}

export interface BrowserPreviewHostOptions {
  manager: BrowserAutomationManager
  getWindow(): BrowserWindow | null
  createWindow(): Promise<BrowserWindow>
  promoteManaged(input: { workspaceEpoch: number; sessionAgentId: string; profileId: string; tabId: string }): Promise<void>
  revealChrome(input: { sessionAgentId: string; profileId: string; tabId: string }): Promise<void>
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

const CAPTURE_INTERVAL_MS = 1_000

/** Main-local, RAM-only owner for one read-only Browser Preview deck. */
export class BrowserPreviewHost {
  private readonly manager: BrowserAutomationManager
  private readonly getWindow: BrowserPreviewHostOptions['getWindow']
  private readonly createWindow: BrowserPreviewHostOptions['createWindow']
  private readonly promoteManaged: BrowserPreviewHostOptions['promoteManaged']
  private readonly revealChrome: BrowserPreviewHostOptions['revealChrome']
  private readonly now: () => number
  private readonly setTimer: NonNullable<BrowserPreviewHostOptions['setTimer']>
  private readonly clearTimer: NonNullable<BrowserPreviewHostOptions['clearTimer']>
  private readonly cards = new Map<string, PreviewCard>()
  private scope: PublishedPreviewScope | null = null
  private previewGeneration = 0
  private paused = false
  private hiddenContent = false
  private pinned = false
  private captureTimer: ReturnType<typeof setTimeout> | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private captureInFlight = false
  private captureContentEpoch = 0
  private frameSequence = 0
  private roundRobinIndex = 0
  private disposed = false

  constructor(options: BrowserPreviewHostOptions) {
    this.manager = options.manager
    this.getWindow = options.getWindow
    this.createWindow = options.createWindow
    this.promoteManaged = options.promoteManaged
    this.revealChrome = options.revealChrome
    this.now = options.now ?? (() => performance.now())
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
  }

  publishScope(publication: PublishedPreviewScope | null): void {
    if (this.disposed) return
    if (!publication) {
      this.invalidate(true)
      return
    }
    const previous = this.scope
    const sameAuthority = previous !== null
      && previous.workspaceEpoch === publication.workspaceEpoch
      && previous.sessionAgentId === publication.sessionAgentId
      && previous.profileId === publication.profileId
      && previous.scope.hostGeneration === publication.scope.hostGeneration
    if (sameAuthority && publication.scope.sessionRevision < previous.scope.sessionRevision) return
    const identityChanged = previous !== null && !sameAuthority
    if (identityChanged) this.invalidate(true)
    this.scope = publication
    const members = new Map(publication.scope.tabs.map((tab) => [tab.tabId, tab]))
    let changed = false
    for (const [tabId, card] of this.cards) {
      const tab = members.get(tabId)
      if (!tab || tab.lifecycle === 'closed' || tab.targetAffinity !== card.tab.targetAffinity) {
        this.cards.delete(tabId)
        changed = true
        continue
      }
      if (tab.label !== card.tab.label || tab.lifecycle !== card.tab.lifecycle || tab.presented !== card.tab.presented) {
        card.tab = tab
        card.state = this.resumedState(card)
        changed = true
      }
    }
    this.scheduleExpiry()
    if (this.cards.size === 0) this.closeWindow()
    else {
      if (changed) this.publishSnapshot()
      this.scheduleCapture()
    }
  }

  async open(request: BrowserPreviewOpenRequest): Promise<BrowserPreviewDeckSnapshot> {
    this.assertAlive()
    const scope = this.requireScope(request)
    const tab = scope.scope.tabs.find((candidate) => candidate.tabId === request.tabId && candidate.lifecycle !== 'closed')
    if (!tab) throw new BrowserHostError('tab-not-found', 'Browser preview tab is no longer canonical')
    if (!this.cards.has(tab.tabId)) {
      if (this.cards.size >= BROWSER_PREVIEW_MAX_CARDS) throw new BrowserHostError('invalid-input', `Browser Preview supports at most ${BROWSER_PREVIEW_MAX_CARDS} cards`)
      if (this.cards.size === 0) {
        this.previewGeneration += 1
        this.paused = false
        this.hiddenContent = false
        this.pinned = false
      }
      this.cards.set(tab.tabId, {
        tab,
        frame: null,
        state: tab.targetAffinity === 'external-chrome' ? 'waiting' : tab.presented ? 'delayed' : 'unavailable',
      })
    }
    const openingGeneration = this.previewGeneration
    const window = await this.createWindow()
    if (window.isDestroyed()) throw new BrowserHostError('host-disconnected', 'Browser Preview window could not be opened')
    this.requireScope(request)
    if (this.previewGeneration !== openingGeneration || !this.cards.has(tab.tabId)) {
      throw new BrowserHostError('stale-host-generation', 'Browser Preview changed while its window was opening', true)
    }
    if (window.isMinimized()) window.restore()
    window.setAlwaysOnTop(this.pinned)
    window.showInactive()
    this.publishSnapshot()
    this.scheduleCapture(0)
    return this.snapshot()
  }

  getSnapshot(): BrowserPreviewDeckSnapshot | null {
    return this.cards.size > 0 && this.scope ? this.snapshot() : null
  }

  pullFrame(request: BrowserPreviewFramePullRequest): BrowserPreviewFramePayload | null {
    this.assertGeneration(request.previewGeneration)
    const card = this.cards.get(request.tabId)
    const frame = card?.frame
    if (!card || !frame || frame.sequence !== request.sequence || this.hiddenContent || !this.windowCanReceiveFrames()) return null
    frame.pulled = true
    this.scheduleCapture()
    return {
      previewGeneration: this.previewGeneration,
      tabId: request.tabId,
      sequence: frame.sequence,
      mimeType: 'image/png',
      data: frame.data,
      width: frame.width,
      height: frame.height,
      ageMsAtDelivery: Math.max(0, this.now() - frame.receivedAt),
    }
  }

  async handleCommand(command: BrowserPreviewShellCommand): Promise<void> {
    this.assertGeneration(command.previewGeneration)
    if (command.type === 'remove') {
      this.cards.delete(command.tabId)
      this.scheduleExpiry()
      if (this.cards.size === 0) this.closeWindow()
      else this.publishSnapshot()
      return
    }
    if (command.type === 'set-paused') {
      this.paused = command.paused
      for (const card of this.cards.values()) card.state = command.paused ? 'paused' : this.resumedState(card)
      this.publishSnapshot()
      if (!command.paused) this.scheduleCapture(0)
      return
    }
    if (command.type === 'set-hidden-content') {
      this.hiddenContent = command.hidden
      if (command.hidden) this.clearFrames('paused')
      else {
        for (const card of this.cards.values()) card.state = this.resumedState(card)
        this.publishSnapshot()
        this.scheduleCapture(0)
      }
      return
    }
    if (command.type === 'set-pinned') {
      this.pinned = command.pinned
      const window = this.getWindow()
      if (window && !window.isDestroyed()) window.setAlwaysOnTop(command.pinned)
      this.publishSnapshot()
      return
    }
    const card = this.cards.get(command.tabId)
    const scope = this.scope
    if (!card || !scope) throw new BrowserHostError('tab-not-found', 'Browser preview card is unavailable')
    if (command.type === 'promote') {
      if (card.tab.targetAffinity !== 'managed-electron') throw new BrowserHostError('invalid-input', 'Only a managed Browser card can be opened in Forge')
      await this.promoteManaged({
        workspaceEpoch: scope.workspaceEpoch,
        sessionAgentId: scope.sessionAgentId,
        profileId: scope.profileId,
        tabId: card.tab.tabId,
      })
      return
    }
    if (card.tab.targetAffinity !== 'external-chrome') throw new BrowserHostError('invalid-input', 'Only a Chrome Browser card can be revealed in Chrome')
    await this.revealChrome({ sessionAgentId: scope.sessionAgentId, profileId: scope.profileId, tabId: card.tab.tabId })
  }

  observeExternalSnapshot(observation: AutomaticBrowserSnapshotObservation): void {
    const scope = this.scope
    if (!scope || this.disposed || this.paused || this.hiddenContent || !this.windowCanReceiveFrames()) return
    if (scope.sessionAgentId !== observation.session.sessionAgentId || scope.profileId !== observation.session.profileId
      || scope.scope.hostGeneration !== observation.hostGeneration) return
    const card = this.cards.get(observation.tabId)
    const member = scope.scope.tabs.find((tab) => tab.tabId === observation.tabId)
    const screenshot = observation.screenshot
    if (!card || !member || member.targetAffinity !== 'external-chrome' || card.tab.targetAffinity !== 'external-chrome'
      || screenshot.mimeType !== 'image/png' || screenshot.data.length === 0
      || screenshot.data.length > EXTERNAL_CHROME_MAX_SCREENSHOT_BASE64_BYTES
      || screenshot.width < 1 || screenshot.height < 1
      || screenshot.width > BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH
      || screenshot.height > BROWSER_AUTOMATION_MAX_SCREENSHOT_HEIGHT) return
    this.storeFrame(card, screenshot.data, screenshot.width, screenshot.height)
  }

  handleWindowVisibilityChanged(): void {
    if (this.windowCanReceiveFrames()) {
      this.publishSnapshot()
      this.scheduleCapture(0)
    } else this.stopCaptureTimer()
  }

  handleWindowClosed(): void {
    this.stopCaptureTimer()
    this.stopExpiryTimer()
    this.cards.clear()
    this.previewGeneration += 1
    this.paused = false
    this.hiddenContent = false
    this.pinned = false
  }

  clearSensitiveContent(): void {
    if (this.cards.size === 0) return
    this.hiddenContent = true
    this.clearFrames('paused')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.invalidate(true)
  }

  private requireScope(request: BrowserPreviewOpenRequest): PublishedPreviewScope {
    const scope = this.scope
    if (!scope || !scope.scope.connected || scope.workspaceEpoch !== request.workspaceEpoch
      || scope.sessionAgentId !== request.sessionAgentId || scope.profileId !== request.profileId) {
      throw new BrowserHostError('stale-host-generation', 'Browser preview targets a stale or unavailable workspace', true)
    }
    return scope
  }

  private assertAlive(): void {
    if (this.disposed) throw new BrowserHostError('host-disconnected', 'Browser Preview is shutting down')
  }

  private assertGeneration(generation: number): void {
    this.assertAlive()
    if (!Number.isSafeInteger(generation) || generation !== this.previewGeneration) {
      throw new BrowserHostError('stale-host-generation', 'Browser Preview command belongs to a stale window', true)
    }
  }

  private resumedState(card: PreviewCard): PreviewCard['state'] {
    if (this.paused || this.hiddenContent) return 'paused'
    if (card.tab.targetAffinity === 'external-chrome') return card.frame ? 'updating' : 'waiting'
    if (!card.tab.presented) return card.frame ? 'paused' : 'unavailable'
    return card.frame ? 'updating' : 'delayed'
  }

  private scheduleCapture(delay = CAPTURE_INTERVAL_MS): void {
    if (this.captureTimer || this.captureInFlight || this.paused || this.hiddenContent || !this.windowCanReceiveFrames()
      || this.managedCaptureCandidates().length === 0) return
    this.captureTimer = this.setTimer(() => {
      this.captureTimer = null
      const candidate = this.nextManagedCard()
      if (candidate) void this.capture(candidate.tab.tabId)
    }, Math.max(0, delay))
  }

  private managedCaptureCandidates(): PreviewCard[] {
    return [...this.cards.values()].filter((card) => card.tab.targetAffinity === 'managed-electron'
      && card.tab.presented && card.tab.lifecycle !== 'closed' && (!card.frame || card.frame.pulled))
  }

  private nextManagedCard(): PreviewCard | null {
    const candidates = this.managedCaptureCandidates()
    if (candidates.length === 0) return null
    const card = candidates[this.roundRobinIndex % candidates.length]!
    this.roundRobinIndex = (this.roundRobinIndex + 1) % Math.max(1, candidates.length)
    return card
  }

  private async capture(tabId: string): Promise<void> {
    const card = this.cards.get(tabId)
    if (!card || card.tab.targetAffinity !== 'managed-electron' || !card.tab.presented
      || this.captureInFlight || this.paused || this.hiddenContent || !this.windowCanReceiveFrames()) return
    this.captureInFlight = true
    const contentEpoch = this.captureContentEpoch
    try {
      const result = await this.manager.tryCapturePreviewFrame(tabId)
      const current = this.cards.get(tabId)
      if (current !== card || contentEpoch !== this.captureContentEpoch
        || this.paused || this.hiddenContent || !this.windowCanReceiveFrames()) return
      if (result.status === 'captured') this.storeFrame(card, result.data, result.width, result.height)
      else {
        card.state = result.status === 'busy' ? 'delayed' : 'unavailable'
        this.publishSnapshot()
      }
    } finally {
      this.captureInFlight = false
      this.scheduleCapture()
    }
  }

  private storeFrame(card: PreviewCard, data: string, width: number, height: number): void {
    const nextBytes = Buffer.byteLength(data, 'utf8')
    if (!this.frameWithinSourceBounds(card, nextBytes, width, height)) {
      card.state = 'unavailable'
      this.publishSnapshot()
      return
    }
    const otherBytes = [...this.cards.values()].reduce((total, candidate) => total + (candidate === card ? 0 : Buffer.byteLength(candidate.frame?.data ?? '', 'utf8')), 0)
    if (nextBytes === 0 || nextBytes + otherBytes > BROWSER_PREVIEW_TOTAL_IMAGE_BYTES) {
      card.state = 'unavailable'
      this.publishSnapshot()
      return
    }
    const sequence = ++this.frameSequence
    card.frame = { sequence, data, width, height, receivedAt: this.now(), pulled: false }
    card.state = 'updating'
    this.scheduleExpiry()
    this.publishSnapshot()
    const available: BrowserPreviewFrameAvailable = { previewGeneration: this.previewGeneration, tabId: card.tab.tabId, sequence }
    sendToRendererWindow(this.getWindow(), BROWSER_PREVIEW_IPC.frameAvailable, available)
  }

  private snapshot(): BrowserPreviewDeckSnapshot {
    const scope = this.scope
    if (!scope) throw new BrowserHostError('unavailable-host', 'Browser Preview has no selected workspace')
    return {
      previewGeneration: this.previewGeneration,
      workspaceEpoch: scope.workspaceEpoch,
      sessionAgentId: scope.sessionAgentId,
      profileId: scope.profileId,
      paused: this.paused,
      hiddenContent: this.hiddenContent,
      pinned: this.pinned,
      cards: [...this.cards.values()].map((card) => ({
        tabId: card.tab.tabId,
        targetAffinity: card.tab.targetAffinity,
        label: card.tab.label,
        lifecycle: card.tab.lifecycle,
        presented: card.tab.presented,
        state: card.state,
        frameSequence: card.frame?.sequence ?? 0,
        hasFrame: Boolean(card.frame && !this.hiddenContent),
        width: card.frame?.width ?? null,
        height: card.frame?.height ?? null,
        ageMsAtDelivery: card.frame ? Math.max(0, this.now() - card.frame.receivedAt) : null,
      })),
    }
  }

  private publishSnapshot(): void {
    if (this.cards.size === 0 || !this.scope) return
    sendToRendererWindow(this.getWindow(), BROWSER_PREVIEW_IPC.snapshotChanged, this.snapshot())
  }

  private clearFrames(state: PreviewCard['state']): void {
    this.captureContentEpoch += 1
    this.stopExpiryTimer()
    for (const card of this.cards.values()) {
      card.frame = null
      card.state = state
    }
    this.publishSnapshot()
  }

  private invalidate(close: boolean): void {
    this.stopCaptureTimer()
    this.stopExpiryTimer()
    this.scope = null
    this.cards.clear()
    this.previewGeneration += 1
    if (close) this.closeWindow()
  }

  private closeWindow(): void {
    const window = this.getWindow()
    if (window && !window.isDestroyed()) window.close()
  }

  private stopCaptureTimer(): void {
    if (!this.captureTimer) return
    this.clearTimer(this.captureTimer)
    this.captureTimer = null
  }

  private scheduleExpiry(): void {
    this.stopExpiryTimer()
    if (this.disposed) return
    const now = this.now()
    let nextExpiry: number | null = null
    for (const card of this.cards.values()) {
      if (card.tab.targetAffinity !== 'external-chrome' || !card.frame) continue
      const expiresAt = card.frame.receivedAt + BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS
      nextExpiry = nextExpiry === null ? expiresAt : Math.min(nextExpiry, expiresAt)
    }
    if (nextExpiry === null) return
    this.expiryTimer = this.setTimer(() => {
      this.expiryTimer = null
      this.expireExternalFrames()
    }, Math.max(0, nextExpiry - now))
  }

  private expireExternalFrames(): void {
    if (this.disposed) return
    const now = this.now()
    let changed = false
    for (const card of this.cards.values()) {
      if (card.tab.targetAffinity !== 'external-chrome' || !card.frame
        || now - card.frame.receivedAt < BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS) continue
      card.frame = null
      card.state = 'expired'
      changed = true
    }
    if (changed) this.publishSnapshot()
    this.scheduleExpiry()
  }

  private stopExpiryTimer(): void {
    if (!this.expiryTimer) return
    this.clearTimer(this.expiryTimer)
    this.expiryTimer = null
  }

  private frameWithinSourceBounds(card: PreviewCard, bytes: number, width: number, height: number): boolean {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return false
    if (card.tab.targetAffinity === 'external-chrome') {
      return bytes <= EXTERNAL_CHROME_MAX_SCREENSHOT_BASE64_BYTES
        && width <= BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH
        && height <= BROWSER_AUTOMATION_MAX_SCREENSHOT_HEIGHT
    }
    return bytes <= Math.ceil(BROWSER_PREVIEW_MANAGED_MAX_PNG_BYTES * 4 / 3) + 4
      && width <= BROWSER_PREVIEW_MANAGED_MAX_WIDTH
      && height <= BROWSER_PREVIEW_MANAGED_MAX_HEIGHT
  }

  private windowCanReceiveFrames(): boolean {
    const window = this.getWindow()
    return Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized())
  }
}
