import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
let readChromeDatabase: typeof import('../browser-automation/chrome-cookies.js').readChromeDatabase
// The safety setup imports this reader to latch fixture-only access. Re-import
// after installing the crypto observer; native access remains disabled.
beforeAll(async () => { vi.resetModules(); ({ readChromeDatabase } = await import('../browser-automation/chrome-cookies.js')) })
const derived = vi.hoisted(() => [] as Buffer[])
vi.mock('node:crypto', async original => {
  const crypto = await original<typeof import('node:crypto')>()
  return { ...crypto, pbkdf2Sync: (...args: Parameters<typeof crypto.pbkdf2Sync>) => { const key = crypto.pbkdf2Sync(...args); derived.push(key); return key } }
})
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); derived.length = 0 })
async function database(encrypted: Buffer) {
  const root = await mkdtemp(join(tmpdir(), 'forge-cookie-key-')); roots.push(root)
  await mkdir(join(root, 'Default'), { recursive: true })
  const db = new DatabaseSync(join(root, 'Default', 'Cookies'))
  db.exec("CREATE TABLE meta(key TEXT,value TEXT);INSERT INTO meta VALUES('version','24');CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER)")
  db.prepare('INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?,?)').run('.example.test', 'session', '', encrypted, '/', 0, 1, 1, 1); db.close()
  return root
}
describe('Chrome database derived keys', () => {
  it.each(['darwin', 'linux'] as const)('zeroes all derived keys after successful %s import', async platform => {
    const key = pbkdf2Sync('synthetic-passphrase', 'saltysalt', platform === 'darwin' ? 1003 : 1, 16, 'sha1')
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
    const encrypted = Buffer.concat([Buffer.from(platform === 'darwin' ? 'v10' : 'v11'), cipher.update(Buffer.concat([createHash('sha256').update('.example.test').digest(), Buffer.from('synthetic-only')])), cipher.final()])
    derived.length = 0
    const userDataDir = await database(encrypted)
    expect(await readChromeDatabase({ userDataDir, platform, passphrase: async () => 'synthetic-passphrase' })).toMatchObject([{ value: 'synthetic-only', httpOnly: true }])
    expect(derived.length).toBeGreaterThanOrEqual(2)
    for (const buffer of derived) expect(buffer.equals(Buffer.alloc(buffer.length))).toBe(true)
  })
  it.each(['v20unsupported', 'v10invalid-ciphertext', 'v11invalid-ciphertext'])('zeroes all derived keys when import rejects %s', async encrypted => {
    const userDataDir = await database(Buffer.from(encrypted))
    await expect(readChromeDatabase({ userDataDir, platform: 'linux', passphrase: async () => 'synthetic-passphrase' })).rejects.toThrow()
    expect(derived.length).toBeGreaterThanOrEqual(2)
    for (const buffer of derived) expect(buffer.equals(Buffer.alloc(buffer.length))).toBe(true)
  })
})
