import type { BrowserCookieError, BrowserCookieSource, BrowserCookieTransfer } from '@forge/protocol'
import type { EnvironmentClient } from '@forge/client-runtime'
import { normalizeBrowserAddress } from '@/components/browser-panel/browser-address'

/** One machine's browser setup. */
export interface BrowserSetupStatus {
  state: 'ready' | 'missing' | 'installing' | 'failed'
  message?: string
}

/** A site a project's browser has sign-ins for. */
export interface BrowserSite { domain: string; importedAt: string; count: number }

/** A site Chrome has cookies for, offered for import. */
export interface BrowserImportableSite { domain: string; count: number; lastUsedAt?: string }

export type BrowserImportPreview =
  | { ok: true; importId: string; source: BrowserCookieSource; domains: BrowserImportableSite[]; expiresAt: string }
  | { ok: false; error: BrowserCookieError }

export interface BrowserSkippedSite { domain: string; reason: 'expired' | 'unsupported' | 'conflict' | 'failed'; count?: number }

export interface BrowserImportResult { sites: BrowserSite[]; skipped: BrowserSkippedSite[] }

/**
 * What Settings → Browser needs from one machine's browser engine. Cookie values never pass through
 * here except inside a one-time transfer, which callers hold only for the duration of one send.
 */
export interface BrowserSettingsEngine {
  /** The machine's setup state. */
  status(): Promise<BrowserSetupStatus>
  setup(): Promise<BrowserSetupStatus>
  audit(sessionId: string): Promise<BrowserSite[]>
  forget(sessionId: string, domain: string): Promise<BrowserSite[]>
  preview(sessionId: string, source: BrowserCookieSource): Promise<BrowserImportPreview>
  apply(sessionId: string, importId: string, domains: string[]): Promise<BrowserImportResult>
  prepareSend(sessionId: string, importId: string, domains: string[]): Promise<BrowserCookieTransfer>
  receive(sessionId: string, transfer: BrowserCookieTransfer): Promise<BrowserImportResult>
  openTab(sessionId: string, url: string): Promise<void>
}

type AuditOutput = { domains: BrowserSite[]; skipped?: BrowserSkippedSite[] }

/** The engine over an environment-v2 client. Fields the contract adds later are read when present. */
export function createBrowserSettingsEngine(client: EnvironmentClient): BrowserSettingsEngine {
  const engine = client.features.browserEngine
  const result = (output: AuditOutput, requested: string[]): BrowserImportResult => ({
    sites: sortSites(output.domains),
    skipped: output.skipped ?? requested.filter((domain) => !output.domains.some((site) => site.domain === domain)).map((domain) => ({ domain, reason: 'failed' as const })),
  })
  return {
    async status() {
      const status = await engine.request('browser.engine.status', {})
      return { state: status.state, ...(status.message ? { message: status.message } : {}) }
    },
    async setup() {
      const status = await engine.request('browser.engine.setup', {})
      return { state: status.browserEngineState, ...(status.browserEngineMessage ? { message: status.browserEngineMessage } : {}) }
    },
    audit: async (sessionId) => sortSites((await engine.request('browser.cookies.audit', { sessionId })).domains),
    forget: async (sessionId, domain) => sortSites((await engine.request('browser.cookies.forget', { sessionId, domain })).domains),
    preview: (sessionId, source) => engine.request('browser.cookies.preview', { sessionId, source }),
    apply: async (sessionId, importId, domains) => result(await engine.request('browser.cookies.apply', { sessionId, importId, domains }), domains),
    prepareSend: (sessionId, importId, domains) => engine.request('browser.cookies.prepareSend', { sessionId, importId, domains }),
    receive: async (sessionId, transfer) => result(await engine.request('browser.cookies.receive', { sessionId, transfer }), transfer.domains),
    async openTab(sessionId, url) { await engine.request('browser.tabs.open', { sessionId, url: normalizeBrowserAddress(url), activate: true }) },
  }
}

export function sortSites(sites: BrowserSite[]): BrowserSite[] {
  return [...sites].sort((a, b) => a.domain.localeCompare(b.domain))
}
