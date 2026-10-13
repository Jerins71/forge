import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { domainToASCII } from 'node:url'
import { getDomain } from 'tldts'
import type { BrowserCookiePreview, BrowserCookieSource, BrowserCookieTransfer } from '@forge/protocol'
import { writeJsonFileAtomic } from '../../utils/atomic-files.js'
import { getBrowserCookieAuditPath } from '../storage/data-paths.js'
import { ChromeCookieReadError, readChromeDatabase, readRunningChrome, type ImportCookie } from './chrome-cookies.js'
import type { BrowserEngine } from './browser-engine.js'
const TTL = 5 * 60 * 1000
interface Preview { sessionId: string; owner: string; expires: number; cookies: ImportCookie[] }
type Audit = { domains: Array<{ domain: string; importedAt: string; count: number }>; skipped?: Array<{ domain: string; reason: 'expired' | 'unsupported' | 'conflict' | 'failed'; count?: number }> }
/** The only import staging owner. Values live in expiring memory until explicitly
 * selected. The file-backed audit records sites and counts, never values. */
export class BrowserCookieImport {
  private readonly previews = new Map<string, Preview>()
  private readonly received = new Map<string, number>()
  private readonly auditWrites = new Map<string, Promise<unknown>>()
  constructor(private readonly options: { engine: BrowserEngine; dataDir: string; running?: () => Promise<ImportCookie[]>; database?: () => Promise<ImportCookie[]> }) {}
  private prune() { const now = Date.now(); for (const [id, value] of this.previews) if (value.expires <= now) this.previews.delete(id); for (const [id, expires] of this.received) if (expires <= now) this.received.delete(id) }
  async preview(owner: string, sessionId: string, source: BrowserCookieSource): Promise<BrowserCookiePreview> {
    this.options.engine.projectForSession(sessionId); this.prune()
    if (this.previews.size >= 32) return { ok: false, error: { code: 'source-unavailable', message: 'Too many cookie imports are pending. Finish an import or retry after five minutes.' } }
    try {
      const cookies = await (source === 'chrome-running' ? (this.options.running ?? readRunningChrome)() : (this.options.database ?? (() => this.options.engine.desktop.available ? this.options.engine.desktop.readCookies() : readChromeDatabase()))())
      if (Buffer.byteLength(JSON.stringify(cookies)) > 8 * 1024 * 1024) throw new Error('Cookie read exceeds its memory budget.')
      const grouped = new Map<string, { domain: string; count: number; lastUsedAt?: string }>()
      for (const cookie of cookies) { const domain = site(cookie.domain); const entry = grouped.get(domain) ?? { domain, count: 0 }; entry.count++; if (cookie.lastUsedAt && (!entry.lastUsedAt || cookie.lastUsedAt > entry.lastUsedAt)) entry.lastUsedAt = cookie.lastUsedAt; grouped.set(domain, entry) }
      const importId = randomUUID(), expires = Date.now() + TTL; this.previews.set(importId, { sessionId, owner, expires, cookies })
      return { ok: true, importId, source, domains: [...grouped.values()].sort((a, b) => a.domain.localeCompare(b.domain)), expiresAt: new Date(expires).toISOString() }
    } catch (error) { return { ok: false, error: error instanceof ChromeCookieReadError ? error.detail : { code: 'source-unavailable', message: 'Chrome cookies could not be read. Use the inspect toggle, or retry after granting access.' } } }
  }
  private selection(owner: string, sessionId: string, importId: string, domains: string[]) {
    this.options.engine.projectForSession(sessionId); this.prune(); const preview = this.previews.get(importId)
    if (!preview || preview.owner !== owner || preview.sessionId !== sessionId) throw new ChromeCookieReadError({ code: 'import-expired', message: 'This cookie preview expired or belongs to another device. Read Chrome again.' })
    const selected = new Set(domains.map(site)); if (selected.size !== domains.length || domains.some(domain => site(domain) !== domain)) throw new Error('Select exact sites from the cookie preview.')
    const available = new Set(preview.cookies.map(cookie => site(cookie.domain))); if ([...selected].some(domain => !available.has(domain))) throw new Error('A selected site was not in the cookie preview.')
    return preview.cookies.filter(cookie => selected.has(site(cookie.domain)))
  }
  async apply(owner: string, sessionId: string, importId: string, domains: string[]): Promise<Audit> { const cookies = this.selection(owner, sessionId, importId, domains); const result = await this.write(sessionId, cookies); this.previews.delete(importId); return result }
  prepareSend(owner: string, sessionId: string, importId: string, domains: string[]): BrowserCookieTransfer {
    const selected = this.selection(owner, sessionId, importId, domains)
    const cookies = selected.map(({ lastUsedAt: _lastUsedAt, ...cookie }) => cookie)
    const transfer = { transferId: randomUUID(), expiresAt: new Date(Date.now() + TTL).toISOString(), domains, cookies }
    if (cookies.length > 2000 || Buffer.byteLength(JSON.stringify(transfer)) > 800000) throw new Error('Selected cookies exceed the one-time transfer budget. Send fewer sites at once.')
    this.previews.delete(importId); return transfer
  }
  async receive(sessionId: string, transfer: BrowserCookieTransfer): Promise<Audit> {
    this.options.engine.projectForSession(sessionId); this.prune(); const expires = Date.parse(transfer.expiresAt)
    if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + TTL || this.received.has(transfer.transferId)) throw new Error('Cookie transfer expired or was already received.')
    const selected = new Set(transfer.domains.map(site)); if (transfer.cookies.some(cookie => !selected.has(site(cookie.domain)))) throw new Error('Cookie transfer contains an unselected site.')
    this.received.set(transfer.transferId, expires); return this.write(sessionId, transfer.cookies)
  }
  private async write(sessionId: string, cookies: ImportCookie[]): Promise<Audit> {
    const imported = new Map<string, number>(), skipped = new Map<string, NonNullable<Audit['skipped']>[number]>()
    const skip = (domain: string, reason: NonNullable<Audit['skipped']>[number]['reason']) => { const key = `${domain}:${reason}`, entry = skipped.get(key) ?? { domain, reason, count: 0 }; entry.count = (entry.count ?? 0) + 1; skipped.set(key, entry) }
    await this.options.engine.withCookieContext(sessionId, async context => {
      for (const cookie of cookies) {
        const domain = site(cookie.domain)
        if (cookie.expires > 0 && cookie.expires <= Date.now() / 1000) { skip(domain, 'expired'); continue }
        if (cookie.name.length > 4096 || cookie.value.length > 16384 || cookie.domain.length > 253 || !cookie.path.startsWith('/')) { skip(domain, 'unsupported'); continue }
        try { const { lastUsedAt: _lastUsedAt, partitionHasCrossSiteAncestor, ...value } = cookie; await context.addCookies([{ ...value, ...(value.partitionKey ? { _crHasCrossSiteAncestor: partitionHasCrossSiteAncestor ?? true } : {}) }]); imported.set(domain, (imported.get(domain) ?? 0) + 1) }
        catch { skip(domain, 'failed') }
      }
    })
    const project = this.options.engine.projectForSession(sessionId), previous = this.auditWrites.get(project) ?? Promise.resolve()
    const work = previous.catch(() => {}).then(async () => {
      const audit = await this.audit(sessionId); const entries = new Map(audit.domains.map(entry => [entry.domain, entry])); const importedAt = new Date().toISOString()
      for (const [domain, count] of imported) entries.set(domain, { domain, count, importedAt })
      audit.domains = [...entries.values()].sort((a, b) => a.domain.localeCompare(b.domain)); await writeJsonFileAtomic(getBrowserCookieAuditPath(this.options.dataDir, project), audit, { mode: 0o600 }); return { ...audit, ...(skipped.size ? { skipped: [...skipped.values()] } : {}) }
    }); this.auditWrites.set(project, work)
    try { return await work } finally { if (this.auditWrites.get(project) === work) this.auditWrites.delete(project) }
  }
  async audit(sessionId: string): Promise<Audit> { const project = this.options.engine.projectForSession(sessionId); try { const value = JSON.parse(await readFile(getBrowserCookieAuditPath(this.options.dataDir, project), 'utf8')) as Audit; return { domains: value.domains } } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { domains: [] }; throw error } }
  async forget(sessionId: string, domain: string): Promise<Audit> {
    if (site(domain) !== domain) throw new Error('Forget site requires the exact site domain.')
    await this.options.engine.withCookieContext(sessionId, async context => { const cookies = await context.cookies(); for (const cookie of cookies) if (site(cookie.domain) === domain) await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path }) })
    const audit = await this.audit(sessionId); audit.domains = audit.domains.filter(entry => entry.domain !== domain)
    await writeJsonFileAtomic(getBrowserCookieAuditPath(this.options.dataDir, this.options.engine.projectForSession(sessionId)), audit, { mode: 0o600 }); return audit
  }
  releaseSession(sessionId: string) { for (const [id, preview] of this.previews) if (preview.sessionId === sessionId) this.previews.delete(id) }
  shutdown() { this.previews.clear(); this.received.clear() }
}
function site(domain: string) { const host = domainToASCII(domain.replace(/^\./, '').toLowerCase()); if (!host || host.includes('/') || host.includes(':') || host.length > 253) throw new Error('Cookie domain is invalid.'); return getDomain(host, { allowPrivateDomains: true }) ?? host }
