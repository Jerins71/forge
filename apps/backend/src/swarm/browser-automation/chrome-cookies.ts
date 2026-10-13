/** Cookie reads happen only after explicit import intent. Native consent stays
 * in the calling Forge process. Decrypted rows and keys never touch disk. */
import { readFile, open, access, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createDecipheriv, pbkdf2Sync, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'
import type { BrowserCookieError, BrowserCookieTransfer } from '@forge/protocol'
export type ImportCookie = BrowserCookieTransfer['cookies'][number] & { lastUsedAt?: string }
export class ChromeCookieReadError extends Error {
  constructor(readonly detail: BrowserCookieError) { super(detail.message) }
}
const fail = (code: BrowserCookieError['code'], message: string): never => { throw new ChromeCookieReadError({ code, message }) }
export function chromeUserDataDir(platform = process.platform) {
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
  if (platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'google-chrome')
}
// Fixture entrypoints explicitly set this policy before any browser work. Capture
// inherited test mode as well for Electron's bundled main and standalone test hosts.
// Once enabled it cannot be undone by suite teardown or environment sanitization.
let fixtureOnly = !!(process.env.FORGE_E2E || process.env.FORGE_E2E_CHECKOUT || process.env.FORGE_E2E_MANIFEST || process.env.FORGE_E2E_RUN_ID || process.env.FORGE_BROWSER_FIXTURE_REPO || process.env.VITEST)
export function restrictChromeCookieImportsToFixtures(): void { fixtureOnly = true }
async function sourceProfile(explicit: string | undefined, platform = process.platform) {
  const configured = explicit ?? process.env.FORGE_BROWSER_TEST_CHROME_PROFILE
  if (!fixtureOnly) return configured ?? chromeUserDataDir(platform)
  if (!configured) return fail('source-unavailable', 'Chrome import in a test fleet requires an explicit isolated test profile. Real Chrome and Keychain access are disabled.')
  const selected = await realpath(resolve(configured)).catch(() => resolve(configured))
  const realDefault = resolve(chromeUserDataDir(platform)), rel = relative(realDefault, selected)
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) return fail('source-unavailable', 'Test fleets cannot read the user’s real Chrome profile.')
  return selected
}
export async function readRunningChrome(userDataDir?: string): Promise<ImportCookie[]> {
  userDataDir = await sourceProfile(userDataDir)
  let endpoint: string
  try {
    const source = await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8'); const [port, path] = source.trim().split(/\r?\n/)
    if (!/^\d+$/.test(port ?? '') || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(path ?? '')) return fail('chrome-not-running', 'Enable remote debugging in Chrome 144+ at chrome://inspect/#remote-debugging, then retry Import from Chrome.')
    endpoint = `ws://127.0.0.1:${port}${path}`
  } catch { return fail('chrome-not-running', 'Chrome is not sharing its browser connection. In Chrome 144+, enable remote debugging at chrome://inspect/#remote-debugging and retry.') }
  // Cookie import is a read-only browser-level command. Playwright's CDP
  // connection also attaches to every page, which import does not need.
  const socket = new WebSocket(endpoint, { maxPayload: 8 * 1024 * 1024 })
  let connected = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    type SourceCookie = Omit<ImportCookie, 'partitionKey'> & { partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean }; partitionKeyOpaque?: boolean }
    const cookies = await new Promise<SourceCookie[]>((resolve, reject) => {
      const disconnected = () => reject(new ChromeCookieReadError({ code: connected ? 'chrome-disconnected' : 'chrome-consent-required', message: connected ? 'Chrome disconnected while reading cookies. Keep Chrome open and retry.' : 'Allow Forge in Chrome’s remote-debugging consent dialog, then retry. Keep Chrome open with the inspect toggle enabled.' }))
      timer = setTimeout(disconnected, 150000)
      socket.once('open', () => { connected = true; socket.send(JSON.stringify({ id: 1, method: 'Storage.getCookies', params: {} })) })
      socket.once('error', disconnected); socket.once('close', disconnected)
      socket.on('message', raw => {
        try {
          const response = JSON.parse(raw.toString()) as { id?: number; result?: { cookies?: SourceCookie[] }; error?: unknown }
          if (response.id !== 1) return
          if (response.error || !Array.isArray(response.result?.cookies)) { disconnected(); return }
          resolve(response.result.cookies)
        } catch { disconnected() }
      })
    })
    if (cookies.some(cookie => cookie.partitionKeyOpaque)) return fail('source-unavailable', 'Chrome contains opaque cookie partitions that cannot be imported safely.')
    return cookies.map(cookie => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, expires: cookie.expires, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite ?? 'Lax', ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey.topLevelSite, partitionHasCrossSiteAncestor: cookie.partitionKey.hasCrossSiteAncestor } : {}) }))
  } finally { clearTimeout(timer); socket.removeAllListeners(); socket.on('error', () => {}); socket.close() }
}

async function macPassphrase(): Promise<string> {
  try { const { Entry } = await import('@napi-rs/keyring'); const value = new Entry('Chrome Safe Storage', 'Chrome').getPassword(); if (value) return value }
  catch { return fail('keychain-denied', 'Allow Forge to read Chrome Safe Storage in the macOS Keychain prompt, then retry.') }
  return fail('keychain-denied', 'Chrome Safe Storage was not found in Keychain. Open Chrome or use its inspect toggle to import cookies.')
}
/** Chromium uses this libsecret schema and application attribute. DONT_MATCH_NAME
 * also admits older Chromium keyring entries. Binding runs in-process. */
async function linuxPassphrase(): Promise<string> {
  try {
    const koffi = await import('koffi'); const secret = koffi.load('libsecret-1.so.0'); const glib = koffi.load('libglib-2.0.so.0')
    glib.func('void g_set_application_name(const char *name)')('Forge')
    const create = secret.func('void *secret_schema_new(const char *name, int flags, ...)')
    const schema = create('chrome_libsecret_os_crypt_password_v2', 2, 'str', 'application', 'int', 0, 'void *', null)
    const lookup = secret.func('void *secret_password_lookup_sync(const void *schema, void *cancellable, _Out_ void **error, ...)')
    const error: unknown[] = [null]
    try {
      const pointer = await new Promise<unknown>((resolve, reject) => lookup.async(schema, null, error, 'str', 'application', 'str', 'chrome', 'void *', null, (cause: Error | null, value: unknown) => cause ? reject(cause) : resolve(value)))
      if (error[0]) { glib.func('void g_error_free(void *error)')(error[0]); return fail('keychain-denied', 'The Linux secret service denied Chrome cookie access. Unlock your keyring and retry.') }
      if (!pointer) return fail('secret-service-unavailable', 'Chrome’s secret-service key was not found. Open Chrome with the keyring unlocked, or use Chrome’s inspect toggle.')
      try { return koffi.decode(pointer, 'char', -1) as string }
      finally { secret.func('void secret_password_free(void *password)')(pointer) }
    } finally { secret.func('void secret_schema_unref(void *schema)')(schema) }
  } catch (error) { if (error instanceof ChromeCookieReadError) throw error; return fail('secret-service-unavailable', 'Install libsecret-1-0 and unlock your Linux secret service, or use Chrome’s inspect toggle.') }
}
export async function readChromeDatabase(options: { userDataDir?: string; platform?: NodeJS.Platform; passphrase?: () => Promise<string> } = {}): Promise<ImportCookie[]> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return fail('unsupported-platform', 'On Windows, use Chrome 144+ with remote debugging enabled at chrome://inspect/#remote-debugging. Cookie database import is not supported.')
  if (platform !== 'darwin' && platform !== 'linux') return fail('unsupported-platform', 'Cookie database import is supported on macOS and Linux only.')
  const root = await sourceProfile(options.userDataDir, platform)
  let databasePath = join(root, 'Default', 'Network', 'Cookies')
  try { await access(databasePath) } catch (error) { if (platform === 'darwin' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new ChromeCookieReadError({ code: 'files-folders-denied', message: 'Allow Forge to read Chrome cookies in System Settings → Privacy & Security → Files & Folders, then retry.', settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders' }); databasePath = join(root, 'Default', 'Cookies') }
  try { const file = await open(databasePath, 'r'); await file.close() }
  catch (error) {
    if (platform === 'darwin' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new ChromeCookieReadError({ code: 'files-folders-denied', message: 'Allow Forge to read Chrome cookies in System Settings → Privacy & Security → Files & Folders, then retry.', settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders' })
    return fail('source-unavailable', 'Chrome’s cookie database could not be read. Open Chrome or use the inspect toggle.')
  }
  const database = new DatabaseSync(databasePath, { readOnly: true })
  let key: Buffer | undefined, v11: Buffer | undefined, empty: Buffer | undefined
  try {
    const schema = Number((database.prepare("SELECT value FROM meta WHERE key='version'").get() as { value?: string } | undefined)?.value ?? 0)
    const columns = new Set((database.prepare('PRAGMA table_info(cookies)').all() as Array<{ name: string }>).map(column => column.name))
    const lastUsed = columns.has('last_access_utc') && columns.has('creation_utc') ? '(CASE WHEN last_access_utc > 0 THEN last_access_utc ELSE creation_utc END)/1000000.0 - 11644473600' : columns.has('creation_utc') ? 'creation_utc/1000000.0 - 11644473600' : 'NULL'
    const partition = columns.has('top_frame_site_key') ? 'top_frame_site_key' : "''", crossSite = columns.has('has_cross_site_ancestor') ? 'has_cross_site_ancestor' : '1'
    const rows = database.prepare(`SELECT ${partition} AS partition_key,${crossSite} AS cross_site,${lastUsed} AS last_used,host_key,name,value,encrypted_value,path,CASE WHEN expires_utc > 0 THEN expires_utc/1000000.0 - 11644473600 ELSE -1 END AS expires,is_secure,is_httponly,samesite FROM cookies LIMIT 20001`).all() as unknown as Array<{ host_key: string; name: string; value: string; encrypted_value: Uint8Array; path: string; expires: number; is_secure: number; is_httponly: number; samesite: number; last_used: number | null; partition_key: string; cross_site: number }>
    if (rows.length > 20000) return fail('source-unavailable', 'Chrome has too many cookies for one import. Use its inspect toggle or remove unused sites first.')
    const needsKey = rows.some(row => row.encrypted_value.length > 0 && (platform === 'darwin' || Buffer.from(row.encrypted_value).subarray(0, 3).toString() === 'v11'))
    if (needsKey && fixtureOnly && !options.passphrase) return fail('source-unavailable', 'Native Keychain and secret-service reads are disabled in test fleets. Inject a synthetic fixture key provider.')
    const passphrase = needsKey ? await (options.passphrase ?? (platform === 'darwin' ? macPassphrase : linuxPassphrase))() : ''
    key = pbkdf2Sync(platform === 'darwin' ? passphrase : 'peanuts', 'saltysalt', platform === 'darwin' ? 1003 : 1, 16, 'sha1')
    v11 = platform === 'linux' && needsKey ? pbkdf2Sync(passphrase, 'saltysalt', 1, 16, 'sha1') : undefined
    empty = pbkdf2Sync('', 'saltysalt', 1, 16, 'sha1')
    const cookies: ImportCookie[] = []
    for (const row of rows) {
      if (row.expires > 0 && row.expires <= Date.now() / 1000) continue
      let value = row.value
      if (row.encrypted_value.length) {
        const encrypted = Buffer.from(row.encrypted_value), prefix = encrypted.subarray(0, 3).toString()
        if (prefix !== 'v10' && prefix !== 'v11') return fail('source-unavailable', 'Chrome’s cookie encryption format is not supported. Use its inspect toggle to import these cookies.')
        const selectedKey = prefix === 'v11' ? v11 : key
        if (!selectedKey) return fail('secret-service-unavailable', 'Unlock the Chrome keyring and retry cookie import.')
        let decrypted = false
        for (const candidate of platform === 'linux' ? [selectedKey, empty] : [selectedKey]) {
          let decoded: Buffer | undefined
          try {
            const decipher = createDecipheriv('aes-128-cbc', candidate, Buffer.alloc(16, 0x20))
            decoded = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()])
            if (schema >= 24 && !decoded.subarray(0, 32).equals(createHash('sha256').update(row.host_key).digest())) continue
            value = (schema >= 24 ? decoded.subarray(32) : decoded).toString('utf8'); decrypted = true; break
          } catch { /* Try Chromium's documented empty-key fallback. */ }
          finally { decoded?.fill(0) }
        }
        if (!decrypted) return fail('source-unavailable', 'Chrome cookies could not be decrypted with the approved key. Use its inspect toggle instead.')
      }
      cookies.push({ ...(row.partition_key ? { partitionKey: row.partition_key, partitionHasCrossSiteAncestor: !!row.cross_site } : {}), name: row.name, value, domain: row.host_key, path: row.path, expires: row.expires, secure: !!row.is_secure, httpOnly: !!row.is_httponly, sameSite: row.samesite === 0 ? 'None' : row.samesite === 2 ? 'Strict' : 'Lax', ...(row.last_used && row.last_used > 0 ? { lastUsedAt: new Date(row.last_used * 1000).toISOString() } : {}) })
    }
    return cookies
  } finally { key?.fill(0); v11?.fill(0); empty?.fill(0); database.close() }
}
