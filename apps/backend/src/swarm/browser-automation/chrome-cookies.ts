/** Cookie reads happen only after explicit import intent. Native consent stays
 * in the calling Forge process. Decrypted rows and keys never touch disk. */
import { readFile, open, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createDecipheriv, pbkdf2Sync, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chromium } from 'playwright-core'
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
export async function readRunningChrome(userDataDir = chromeUserDataDir()): Promise<ImportCookie[]> {
  let endpoint: string
  try {
    const source = await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8'); const [port, path] = source.trim().split(/\r?\n/)
    if (!/^\d+$/.test(port ?? '') || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(path ?? '')) return fail('chrome-not-running', 'Enable remote debugging in Chrome 144+ at chrome://inspect/#remote-debugging, then retry Import from Chrome.')
    endpoint = `ws://127.0.0.1:${port}${path}`
  } catch { return fail('chrome-not-running', 'Chrome is not sharing its browser connection. In Chrome 144+, enable remote debugging at chrome://inspect/#remote-debugging and retry.') }
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>
  try { browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 }) }
  catch { return fail('chrome-consent-required', 'Allow Forge in Chrome’s remote-debugging consent dialog, then retry. If Chrome is closed, reopen it and enable the inspect toggle.') }
  try {
    const cdp = await browser.newBrowserCDPSession(); const response = await cdp.send('Storage.getCookies')
    return response.cookies.map(cookie => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, expires: cookie.expires, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite ?? 'Lax' }))
  } catch { return fail('chrome-disconnected', 'Chrome disconnected while reading cookies. Keep Chrome open and retry.') }
  finally { await browser.close() }
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
  const root = options.userDataDir ?? chromeUserDataDir(platform)
  let databasePath = join(root, 'Default', 'Network', 'Cookies')
  try { await access(databasePath) } catch (error) { if (platform === 'darwin' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new ChromeCookieReadError({ code: 'files-folders-denied', message: 'Allow Forge to read Chrome cookies in System Settings → Privacy & Security → Files & Folders, then retry.', settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders' }); databasePath = join(root, 'Default', 'Cookies') }
  try { const file = await open(databasePath, 'r'); await file.close() }
  catch (error) {
    if (platform === 'darwin' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new ChromeCookieReadError({ code: 'files-folders-denied', message: 'Allow Forge to read Chrome cookies in System Settings → Privacy & Security → Files & Folders, then retry.', settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders' })
    return fail('source-unavailable', 'Chrome’s cookie database could not be read. Open Chrome or use the inspect toggle.')
  }
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const schema = Number((database.prepare("SELECT value FROM meta WHERE key='version'").get() as { value?: string } | undefined)?.value ?? 0)
    const columns = new Set((database.prepare('PRAGMA table_info(cookies)').all() as Array<{ name: string }>).map(column => column.name))
    const lastUsed = columns.has('last_access_utc') && columns.has('creation_utc') ? '(CASE WHEN last_access_utc > 0 THEN last_access_utc ELSE creation_utc END)/1000000.0 - 11644473600' : columns.has('creation_utc') ? 'creation_utc/1000000.0 - 11644473600' : 'NULL'
    const rows = database.prepare(`SELECT ${lastUsed} AS last_used,host_key,name,value,encrypted_value,path,CASE WHEN expires_utc > 0 THEN expires_utc/1000000.0 - 11644473600 ELSE -1 END AS expires,is_secure,is_httponly,samesite FROM cookies LIMIT 20001`).all() as unknown as Array<{ host_key: string; name: string; value: string; encrypted_value: Uint8Array; path: string; expires: number; is_secure: number; is_httponly: number; samesite: number; last_used: number | null }>
    if (rows.length > 20000) return fail('source-unavailable', 'Chrome has too many cookies for one import. Use its inspect toggle or remove unused sites first.')
    const needsKey = rows.some(row => row.encrypted_value.length > 0 && (platform === 'darwin' || Buffer.from(row.encrypted_value).subarray(0, 3).toString() === 'v11'))
    const passphrase = needsKey ? await (options.passphrase ?? (platform === 'darwin' ? macPassphrase : linuxPassphrase))() : ''
    const key = pbkdf2Sync(platform === 'darwin' ? passphrase : 'peanuts', 'saltysalt', platform === 'darwin' ? 1003 : 1, 16, 'sha1')
    const v11 = platform === 'linux' && needsKey ? pbkdf2Sync(passphrase, 'saltysalt', 1, 16, 'sha1') : undefined
    const empty = pbkdf2Sync('', 'saltysalt', 1, 16, 'sha1')
    const cookies: ImportCookie[] = []
    for (const row of rows) {
      if (row.expires > 0 && row.expires <= Date.now() / 1000) continue
      let value = row.value
      if (row.encrypted_value.length) {
        const encrypted = Buffer.from(row.encrypted_value), prefix = encrypted.subarray(0, 3).toString()
        if (prefix !== 'v10' && prefix !== 'v11') return fail('source-unavailable', 'Chrome’s cookie encryption format is not supported. Use its inspect toggle to import these cookies.')
        const selectedKey = prefix === 'v11' ? v11 : key
        if (!selectedKey) return fail('secret-service-unavailable', 'Unlock the Chrome keyring and retry cookie import.')
        let plaintext: Buffer | undefined
        for (const candidate of platform === 'linux' ? [selectedKey, empty] : [selectedKey]) {
          try { const decipher = createDecipheriv('aes-128-cbc', candidate, Buffer.alloc(16, 0x20)); const decoded = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]); if (schema >= 24 && !decoded.subarray(0, 32).equals(createHash('sha256').update(row.host_key).digest())) continue; plaintext = schema >= 24 ? decoded.subarray(32) : decoded; break } catch { /* Try Chromium's documented empty-key fallback. */ }
        }
        if (!plaintext) return fail('source-unavailable', 'Chrome cookies could not be decrypted with the approved key. Use its inspect toggle instead.')
        value = plaintext.toString('utf8')
      }
      cookies.push({ name: row.name, value, domain: row.host_key, path: row.path, expires: row.expires, secure: !!row.is_secure, httpOnly: !!row.is_httponly, sameSite: row.samesite === 0 ? 'None' : row.samesite === 2 ? 'Strict' : 'Lax', ...(row.last_used && row.last_used > 0 ? { lastUsedAt: new Date(row.last_used * 1000).toISOString() } : {}) })
    }
    return cookies
  } finally { database.close() }
}
