import type { BrowserCookieError, BrowserCookieSource } from '@forge/protocol'
import type { MockBrowserPanelPort } from '@/components/browser-panel/mock-browser-panel-port'
import type { BrowserImportableSite, BrowserSettingsEngine, BrowserSetupStatus, BrowserSite } from './browser-settings-engine'
import { sortSites } from './browser-settings-engine'

/** Test-controlled state behind the mock settings engine, per machine. E2E platform builds only. */
export interface MockBrowserSettingsState {
  status: Record<string, BrowserSetupStatus>
  sites: Record<string, BrowserSite[]>
  /** What Chrome offers for import. */
  chrome: BrowserImportableSite[]
  /** A source that fails, and how. */
  previewErrors: Partial<Record<BrowserCookieSource, BrowserCookieError>>
  /** Domains the engine skips on import. */
  skip: string[]
  calls: Array<{ environmentId: string; method: string; domains?: string[] }>
  /** False models a pairing without Change settings. */
  canImport?: boolean
}

const DAY = 86_400_000

export function defaultMockBrowserSettingsState(): MockBrowserSettingsState {
  const used = (days: number) => new Date(Date.now() - days * DAY).toISOString()
  return {
    status: {},
    sites: {},
    chrome: [
      { domain: 'github.com', count: 14, lastUsedAt: used(0) },
      { domain: 'google.com', count: 41, lastUsedAt: used(0) },
      { domain: 'linear.app', count: 9, lastUsedAt: used(1) },
      { domain: 'vercel.com', count: 7, lastUsedAt: used(3) },
      { domain: 'stripe.com', count: 12, lastUsedAt: used(6) },
      { domain: 'figma.com', count: 6, lastUsedAt: used(12) },
      { domain: 'notion.so', count: 11, lastUsedAt: used(30) },
      { domain: 'atlassian.net', count: 5, lastUsedAt: used(64) },
      { domain: 'old-forum.example', count: 2, lastUsedAt: used(400) },
    ],
    previewErrors: {},
    skip: [],
    calls: [],
  }
}

/** Settings → Browser over the in-page mock engine, so its flows run before the engine's cookie APIs do. */
export function createMockBrowserSettingsEngine(port: MockBrowserPanelPort, environmentId: string): BrowserSettingsEngine {
  const state = (port.settings ??= defaultMockBrowserSettingsState())
  const log = (method: string, domains?: string[]) => { state.calls.push({ environmentId, method, ...(domains ? { domains } : {}) }) }
  const sitesOf = () => (state.sites[environmentId] ??= [])
  const write = (domains: string[]) => {
    const now = new Date().toISOString()
    const imported = domains.filter((domain) => !state.skip.includes(domain))
    const kept = sitesOf().filter((site) => !imported.includes(site.domain))
    state.sites[environmentId] = sortSites([...kept, ...imported.map((domain) => ({ domain, importedAt: now, count: state.chrome.find((site) => site.domain === domain)?.count ?? 1 }))])
    return {
      sites: state.sites[environmentId]!,
      skipped: domains.filter((domain) => state.skip.includes(domain)).map((domain) => ({ domain, reason: 'expired' as const, count: state.chrome.find((site) => site.domain === domain)?.count })),
    }
  }
  const wait = <T>(value: T, ms = 250) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))
  return {
    async status() { return state.status[environmentId] ?? { state: 'ready' } },
    async setup() {
      log('setup')
      state.status[environmentId] = { state: 'installing', message: 'Downloading the Forge browser…' }
      setTimeout(() => { state.status[environmentId] = { state: 'ready' } }, 600)
      return state.status[environmentId]!
    },
    async audit() { return wait(sitesOf(), 100) },
    async forget(_sessionId, domain) {
      log('forget', [domain])
      state.sites[environmentId] = sitesOf().filter((site) => site.domain !== domain)
      return wait(state.sites[environmentId]!)
    },
    async preview(_sessionId, source) {
      log(`preview:${source}`)
      const error = state.previewErrors[source]
      if (error) return wait({ ok: false as const, error }, 400)
      return wait({ ok: true as const, importId: `mock-import-${Date.now()}`, source, domains: state.chrome, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }, 400)
    },
    async apply(_sessionId, _importId, domains) { log('apply', domains); return wait(write(domains), 500) },
    async prepareSend(_sessionId, _importId, domains) {
      log('prepareSend', domains)
      return { transferId: `mock-transfer-${Date.now()}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), domains, cookies: [] }
    },
    async receive(_sessionId, transfer) { log('receive', transfer.domains); return wait(write(transfer.domains)) },
    async cancel(_sessionId, importId) { log('cancel', [importId]) },
    get canImport() { return state.canImport !== false },
    async openTab(_sessionId, url) { log('openTab'); await port.open(url) },
  }
}
