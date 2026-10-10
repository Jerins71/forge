import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { setupFiles: [fileURLToPath(new URL('../../scripts/test-installation-state.mjs', import.meta.url))] },
  resolve: {
    alias: [
      {
        find: /^@forge\/protocol\/choices$/u,
        replacement: fileURLToPath(new URL('../protocol/src/choices.ts', import.meta.url)),
      },
      {
        find: /^@forge\/protocol\/cli$/u,
        replacement: fileURLToPath(new URL('../protocol/src/cli.ts', import.meta.url)),
      },
      {
        find: /^@forge\/protocol$/u,
        replacement: fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
      },
    ],
  },
})
