/** Runs the real desktop entry with owned data and synthetic OS credential storage.
 * The key exists only for this process. No real keychain or user credentials are read. */
const { app, safeStorage } = require('electron')
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto')
const { isAbsolute, join } = require('node:path')
const { mkdirSync } = require('node:fs')
const { assertDesktopSmokeIsolation } = require('./desktop-smoke-isolation.cjs')
if (!isAbsolute(process.env.FORGE_E2E_DESKTOP_HOME ?? '') || !process.env.FORGE_E2E_CHECKOUT || !isAbsolute(process.env.FORGE_E2E_DESKTOP_ENTRY ?? '') || !isAbsolute(process.env.FORGE_ELECTRON_USER_DATA_DIR ?? '')) throw new Error('Desktop fixture requires isolated fleet paths')
assertDesktopSmokeIsolation({ root: process.env.FORGE_E2E_DESKTOP_ROOT, env: process.env, cacheRoot: process.env.FORGE_BROWSER_CACHE_DIR })
// Main writes a CLI hint outside userData; isolate its home path as well.
mkdirSync(process.env.FORGE_E2E_DESKTOP_HOME, { recursive: true })
app.setPath('home', process.env.FORGE_E2E_DESKTOP_HOME)
if (process.platform === 'win32') process.env.LOCALAPPDATA = join(process.env.FORGE_E2E_DESKTOP_HOME, 'AppData', 'Local')
app.commandLine.appendSwitch('use-mock-keychain')
app.commandLine.appendSwitch('password-store', 'basic')
const key = randomBytes(32)
const encrypt = text => {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext])
}
const decrypt = encrypted => {
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12))
  decipher.setAuthTag(encrypted.subarray(12, 28))
  return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8')
}
Object.assign(safeStorage, {
  isEncryptionAvailable: () => true,
  isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => 'fixture_encrypted',
  encryptString: encrypt,
  decryptString: decrypt,
  encryptStringAsync: async text => encrypt(text),
  decryptStringAsync: async encrypted => ({ result: decrypt(encrypted), shouldReEncrypt: false }),
})
require(process.env.FORGE_E2E_DESKTOP_ENTRY)
