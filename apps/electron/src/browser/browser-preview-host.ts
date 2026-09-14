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
  type BrowserPreviewScope,
  type BrowserPreviewScopeTab,
} from '@forge/protocol'
import type { AutomaticBrowserControlObservation, AutomaticBrowserSnapshotObservation } from './automatic-browser-host.js'
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

interface PendingExternalFrame {
  data: string
  width: number
  height: number
  receivedAt: number
}

interface PreviewCard {
  tab: BrowserPreviewScopeTab
  frame: PreviewFrame | null
  state: BrowserPreviewDeckSnapshot['cards'][number]['state']
}

interface PreviewControl {
  tabId: string
  targetAffinity: BrowserPreviewScopeTab['targetAffinity']
  state: 'active' | 'idle'
  sequence: number
  confirmed: boolean
}

export interface BrowserPreviewHostOptions {
  manager: BrowserAutomationManager
  /** Authoritative main renderer that owns the embedded preview surface. */
  getWindow(): BrowserWindow | null
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

const CAPTURE_INTERVAL_MS = 1_000

/** Main-local, RAM-only owner for one read-only Browser Preview deck. */
export class BrowserPreviewHost {
  private readonly manager: BrowserAutomationManager
  private readonly getWindow: BrowserPreviewHostOptions['getWindow']
  private readonly now: () => number
  private readonly setTimer: NonNullable<BrowserPreviewHostOptions['setTimer']>
  private readonly clearTimer: NonNullable<BrowserPreviewHostOptions['clearTimer']>
  private readonly cards = new Map<string, PreviewCard>()
  private readonly controls = new Map<string, PreviewControl>()
  private readonly pendingExternalFrames = new Map<string, PendingExternalFrame>()
  private scope: PublishedPreviewScope | null = null
  private previewGeneration = 0
  private hiddenContent = false
  private captureTimer: ReturnType<typeof setTimeout> | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private captureInFlight = false
  private captureContentEpoch = 0
  private frameSequence = 0
  private roundRobinIndex = 0
  private controlSequence = 0
  private disposed = false

  constructor(options: BrowserPreviewHostOptions) {
    this.manager = options.manager
    this.getWindow = options.getWindow
    this.now = options.now ?? (() => performance.now())
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
  }

  publishScope(publication: PublishedPreviewScope | null): void {
    if (this.disposed) return
    if (!publication) {
      this.invalidate()
      return
    }
    const previous = this.scope
    const sameAuthority = previous !== null
      && previous.workspaceEpoch === publication.workspaceEpoch
      && previous.sessionAgentId === publication.sessionAgentId
      && previous.profileId === publication.profileId
      && previous.scope.hostGeneration === publication.scope.hostGeneration
    if (sameAuthority && publication.scope.sessionRevision < previous.scope.sessionRevision) return
    if (previous !== null && !sameAuthority) this.invalidate()
    this.scope = publication
    if (!publication.scope.connected) {
      this.controls.clear()
      this.pendingExternalFrames.clear()
    }
    this.reconcileCards()
  }

  observeAgentControl(observation: AutomaticBrowserControlObservation): void {
    const scope = this.scope
    if (!scope || this.disposed
      || scope.sessionAgentId !== observation.session.sessionAgentId
      || scope.profileId !== observation.session.profileId) return
    if (observation.state === 'released') {
      if (observation.tabId === null) {
        this.controls.clear()
        this.pendingExternalFrames.clear()
      } else {
        this.controls.delete(observation.tabId)
        this.pendingExternalFrames.delete(observation.tabId)
      }
      this.reconcileCards()
      return
    }
    if (!scope.scope.connected || scope.scope.hostGeneration !== observation.hostGeneration) return
    const existing = this.controls.get(observation.tabId)
    if (!existing && this.controls.size >= BROWSER_PREVIEW_MAX_CARDS) {
      const oldestIdle = [...this.controls.values()]
        .filter((control) => control.state === 'idle')
        .sort((left, right) => left.sequence - right.sequence)[0]
      if (!oldestIdle) return
      this.controls.delete(oldestIdle.tabId)
      this.pendingExternalFrames.delete(oldestIdle.tabId)
    }
    const member = scope.scope.tabs.find((tab) => tab.tabId === observation.tabId
      && tab.targetAffinity === observation.targetAffinity && tab.lifecycle !== 'closed')
    this.controls.set(observation.tabId, {
      tabId: observation.tabId,
      targetAffinity: observation.targetAffinity,
      state: observation.state,
      sequence: observation.state === 'active' || !existing ? ++this.controlSequence : existing.sequence,
      confirmed: existing?.confirmed === true || Boolean(member),
    })
    this.reconcileCards()
  }

  get currentContentEpoch(): number {
    return this.captureContentEpoch
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

  observeExternalSnapshot(observation: AutomaticBrowserSnapshotObservation): void {
    const scope = this.scope
    if (!scope || this.disposed || this.hiddenContent || observation.contentEpoch !== this.captureContentEpoch
      || !this.windowCanReceiveFrames()) return
    if (scope.sessionAgentId !== observation.session.sessionAgentId || scope.profileId !== observation.session.profileId
      || scope.scope.hostGeneration !== observation.hostGeneration) return
    const card = this.cards.get(observation.tabId)
    const member = scope.scope.tabs.find((tab) => tab.tabId === observation.tabId)
    const screenshot = observation.screenshot
    if (screenshot.mimeType !== 'image/png' || !this.externalFrameWithinBounds(
      screenshot.data,
      screenshot.width,
      screenshot.height,
    )) return
    if (card && member?.targetAffinity === 'external-chrome' && card.tab.targetAffinity === 'external-chrome') {
      this.storeFrame(card, screenshot.data, screenshot.width, screenshot.height)
      return
    }
    const control = this.controls.get(observation.tabId)
    const eligibleMember = member?.targetAffinity === 'external-chrome' && member.lifecycle !== 'closed'
    if (!card && control?.targetAffinity === 'external-chrome'
      && (eligibleMember || (!member && !control.confirmed))) {
      this.storePendingExternalFrame(observation.tabId, screenshot.data, screenshot.width, screenshot.height)
      this.reconcileCards()
    }
  }

  handleWindowVisibilityChanged(): void {
    if (this.windowCanReceiveFrames()) {
      this.publishSnapshot()
      this.scheduleCapture(0)
    } else this.stopCaptureTimer()
  }

  clearSensitiveContent(): void {
    this.hiddenContent = true
    this.clearFrames('paused')
  }

  restoreSensitiveContent(): void {
    if (!this.hiddenContent) return
    this.hiddenContent = false
    for (const card of this.cards.values()) card.state = this.resumedState(card)
    this.publishSnapshot()
    this.scheduleCapture(0)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.invalidate()
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

  private reconcileCards(): void {
    const scope = this.scope
    const previousOrder = [...this.cards.keys()]
    const wasEmpty = this.cards.size === 0
    const members = new Map(scope?.scope.tabs.map((tab) => [tab.tabId, tab]) ?? [])
    const eligible: Array<{ control: PreviewControl; tab: BrowserPreviewScopeTab }> = []
    if (scope?.scope.connected) {
      for (const [tabId, control] of this.controls) {
        const tab = members.get(tabId)
        if (!tab || tab.lifecycle === 'closed' || tab.targetAffinity !== control.targetAffinity) {
          if (control.confirmed) {
            this.controls.delete(tabId)
            this.pendingExternalFrames.delete(tabId)
          }
          continue
        }
        control.confirmed = true
        if (tab.targetAffinity === 'external-chrome') {
          const existingFrame = this.cards.get(tabId)?.frame
          const pendingFrame = this.pendingExternalFrames.get(tabId)
          const hasFreshFrame = Boolean(existingFrame)
            || Boolean(pendingFrame && this.now() - pendingFrame.receivedAt < BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS)
          if (!hasFreshFrame) continue
        }
        eligible.push({ control, tab })
      }
    }
    eligible.sort((left, right) => {
      if (left.control.state !== right.control.state) return left.control.state === 'active' ? -1 : 1
      return right.control.sequence - left.control.sequence
    })

    const nextCards = new Map<string, PreviewCard>()
    let changed = false
    for (const { tab } of eligible.slice(0, BROWSER_PREVIEW_MAX_CARDS)) {
      const existing = this.cards.get(tab.tabId)
      if (!existing || existing.tab.targetAffinity !== tab.targetAffinity) {
        const pending = tab.targetAffinity === 'external-chrome'
          ? this.takePendingExternalFrame(tab.tabId)
          : null
        nextCards.set(tab.tabId, {
          tab,
          frame: pending ? { ...pending, sequence: ++this.frameSequence, pulled: false } : null,
          state: pending ? 'updating' : 'delayed',
        })
        changed = true
        continue
      }
      if (tab.label !== existing.tab.label || tab.lifecycle !== existing.tab.lifecycle || tab.presented !== existing.tab.presented) {
        existing.tab = tab
        existing.state = this.resumedState(existing)
        changed = true
      }
      nextCards.set(tab.tabId, existing)
    }
    if (nextCards.size !== this.cards.size) changed = true
    const nextOrder = [...nextCards.keys()]
    if (!changed && previousOrder.some((tabId, index) => tabId !== nextOrder[index])) changed = true
    this.cards.clear()
    for (const [tabId, card] of nextCards) this.cards.set(tabId, card)

    if (wasEmpty && this.cards.size > 0) {
      this.previewGeneration += 1
      changed = true
    }
    if (this.cards.size === 0) this.stopCaptureTimer()
    this.scheduleExpiry()
    if (changed) this.publishSnapshot()
    if (this.cards.size > 0) this.scheduleCapture(changed ? 0 : CAPTURE_INTERVAL_MS)
  }

  private resumedState(card: PreviewCard): PreviewCard['state'] {
    if (this.hiddenContent) return 'paused'
    if (card.tab.targetAffinity === 'external-chrome') return 'updating'
    return card.frame ? 'updating' : 'delayed'
  }

  private scheduleCapture(delay = CAPTURE_INTERVAL_MS): void {
    if (this.captureTimer || this.captureInFlight || this.hiddenContent || !this.windowCanReceiveFrames()
      || this.managedCaptureCandidates().length === 0) return
    this.captureTimer = this.setTimer(() => {
      this.captureTimer = null
      const candidate = this.nextManagedCard()
      if (candidate) void this.capture(candidate.tab.tabId)
    }, Math.max(0, delay))
  }

  private managedCaptureCandidates(): PreviewCard[] {
    return [...this.cards.values()].filter((card) => card.tab.targetAffinity === 'managed-electron'
      && card.tab.lifecycle !== 'closed' && (!card.frame || card.frame.pulled))
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
    if (!card || card.tab.targetAffinity !== 'managed-electron'
      || this.captureInFlight || this.hiddenContent || !this.windowCanReceiveFrames()) return
    this.captureInFlight = true
    const contentEpoch = this.captureContentEpoch
    try {
      const result = await this.manager.tryCapturePreviewFrame(tabId)
      const current = this.cards.get(tabId)
      if (current !== card || contentEpoch !== this.captureContentEpoch
        || this.hiddenContent || !this.windowCanReceiveFrames()) return
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

  private storePendingExternalFrame(tabId: string, data: string, width: number, height: number): void {
    const nextBytes = Buffer.byteLength(data, 'utf8')
    if (!this.externalFrameWithinBounds(data, width, height)
      || nextBytes + this.retainedImageBytes(tabId) > BROWSER_PREVIEW_TOTAL_IMAGE_BYTES) return
    this.pendingExternalFrames.set(tabId, { data, width, height, receivedAt: this.now() })
    this.scheduleExpiry()
  }

  private takePendingExternalFrame(tabId: string): PendingExternalFrame | null {
    const pending = this.pendingExternalFrames.get(tabId)
    this.pendingExternalFrames.delete(tabId)
    if (!pending || this.now() - pending.receivedAt >= BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS) return null
    return pending
  }

  private storeFrame(card: PreviewCard, data: string, width: number, height: number): void {
    const nextBytes = Buffer.byteLength(data, 'utf8')
    if (!this.frameWithinSourceBounds(card, nextBytes, width, height)) {
      card.state = 'unavailable'
      this.publishSnapshot()
      return
    }
    if (nextBytes === 0 || nextBytes + this.retainedImageBytes(card.tab.tabId) > BROWSER_PREVIEW_TOTAL_IMAGE_BYTES) {
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
      hiddenContent: this.hiddenContent,
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
    const snapshot = this.cards.size > 0 && this.scope ? this.snapshot() : null
    sendToRendererWindow(this.getWindow(), BROWSER_PREVIEW_IPC.snapshotChanged, snapshot)
  }

  private clearFrames(state: PreviewCard['state']): void {
    this.captureContentEpoch += 1
    this.stopExpiryTimer()
    this.pendingExternalFrames.clear()
    for (const [tabId, card] of this.cards) {
      if (card.tab.targetAffinity === 'external-chrome') {
        this.cards.delete(tabId)
        continue
      }
      card.frame = null
      card.state = state
    }
    this.publishSnapshot()
  }

  private invalidate(): void {
    this.stopCaptureTimer()
    this.stopExpiryTimer()
    this.captureContentEpoch += 1
    this.scope = null
    this.controls.clear()
    this.pendingExternalFrames.clear()
    this.cards.clear()
    this.previewGeneration += 1
    this.publishSnapshot()
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
    for (const frame of this.pendingExternalFrames.values()) {
      const expiresAt = frame.receivedAt + BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS
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
    let cardExpired = false
    for (const card of this.cards.values()) {
      if (card.tab.targetAffinity !== 'external-chrome' || !card.frame
        || now - card.frame.receivedAt < BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS) continue
      card.frame = null
      cardExpired = true
    }
    for (const [tabId, frame] of this.pendingExternalFrames) {
      if (now - frame.receivedAt >= BROWSER_PREVIEW_EXTERNAL_EXPIRE_MS) this.pendingExternalFrames.delete(tabId)
    }
    if (cardExpired) this.reconcileCards()
    else this.scheduleExpiry()
  }

  private stopExpiryTimer(): void {
    if (!this.expiryTimer) return
    this.clearTimer(this.expiryTimer)
    this.expiryTimer = null
  }

  private externalFrameWithinBounds(data: string, width: number, height: number): boolean {
    return data.length > 0
      && Buffer.byteLength(data, 'utf8') <= EXTERNAL_CHROME_MAX_SCREENSHOT_BASE64_BYTES
      && Number.isSafeInteger(width) && Number.isSafeInteger(height)
      && width >= 1 && height >= 1
      && width <= BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH
      && height <= BROWSER_AUTOMATION_MAX_SCREENSHOT_HEIGHT
  }

  private retainedImageBytes(excludingTabId: string): number {
    let total = 0
    for (const card of this.cards.values()) {
      if (card.tab.tabId !== excludingTabId) total += Buffer.byteLength(card.frame?.data ?? '', 'utf8')
    }
    for (const [tabId, frame] of this.pendingExternalFrames) {
      if (tabId !== excludingTabId) total += Buffer.byteLength(frame.data, 'utf8')
    }
    return total
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
