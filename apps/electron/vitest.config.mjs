import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { setupFiles: [fileURLToPath(new URL('../../scripts/test-installation-state.mjs', import.meta.url))] },
})
