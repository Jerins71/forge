/** Test-only preflight shared by the launcher and its Electron entry. No paths are created. */
const { realpathSync } = require('node:fs')
const { homedir } = require('node:os')
const { dirname, isAbsolute, join, relative, resolve } = require('node:path')
const within = (root, value) => { const part = relative(root, value); return !part || part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part) }
function canonical(value) {
  try { return realpathSync.native(value) }
  catch (error) { if (error.code !== 'ENOENT') throw error; const parent = dirname(value); if (parent === value) throw error; return join(canonical(parent), relative(parent, value)) }
}
function assertDesktopSmokeIsolation({ root, env, cacheRoot }, realHome = homedir()) {
  const protectedRoot = resolve(realHome, '.forge')
  const rejectReal = value => { if (within(protectedRoot, value)) throw new Error('Desktop smoke must not resolve to real Forge data') }
  const owned = (name, value, owner) => {
    if (!value || !isAbsolute(value)) throw new Error(`Desktop smoke ${name} requires an absolute owned path`)
    const selected = resolve(value); rejectReal(selected)
    if (!within(resolve(owner), selected)) throw new Error(`Desktop smoke ${name} is outside its owned root`)
    const resolved = canonical(selected); rejectReal(resolved)
    if (!within(canonical(resolve(owner)), resolved)) throw new Error(`Desktop smoke ${name} escapes its owned root`)
  }
  // Reject direct real-home destinations before any filesystem lookup.
  for (const value of [root, cacheRoot, env.FORGE_DATA_DIR, env.FORGE_INSTALLATION_STATE_DIR, env.FORGE_ELECTRON_USER_DATA_DIR, env.FORGE_BROWSER_CACHE_DIR]) if (value && isAbsolute(value)) rejectReal(resolve(value))
  if (env.FORGE_E2E_DESKTOP_HOME) rejectReal(resolve(env.FORGE_E2E_DESKTOP_HOME, '.forge', 'cli', 'install-hint'))
  owned('fleet root', root, root)
  owned('browser cache root', cacheRoot, cacheRoot)
  for (const name of ['FORGE_E2E_DESKTOP_HOME', 'FORGE_ELECTRON_USER_DATA_DIR', 'FORGE_DATA_DIR', 'FORGE_INSTALLATION_STATE_DIR']) owned(name, env[name], root)
  owned('session data', join(env.FORGE_ELECTRON_USER_DATA_DIR, 'session-data'), root)
  owned('CLI install hint', join(env.FORGE_E2E_DESKTOP_HOME, '.forge', 'cli', 'install-hint'), root)
  owned('browser cache', env.FORGE_BROWSER_CACHE_DIR, cacheRoot)
}
module.exports = { assertDesktopSmokeIsolation }
