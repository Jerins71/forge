/** Every Vitest worker owns installation state outside the real host registry. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
const root = mkdtempSync(join(tmpdir(), 'forge-test-installation-'))
process.env.FORGE_INSTALLATION_STATE_DIR = root
afterAll(() => rmSync(root, { recursive: true, force: true }))
