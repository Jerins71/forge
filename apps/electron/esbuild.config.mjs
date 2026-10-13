import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

const sharedOptions = {
  bundle: true,
  external: ['@napi-rs/keyring', 'koffi', 'electron', 'electron-updater', 'playwright-core', 'tsx'],
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  outdir: 'dist',
  logLevel: 'info',
}

// Packaging includes dist wholesale; removed browser hosts must not survive a rebuild.
await rm(new URL('./dist/', import.meta.url), { recursive: true, force: true })

await Promise.all([
  build({ ...sharedOptions, entryPoints: [{ in: 'src/browser/browser-engine-fixture-main.ts', out: 'browser-engine-fixture-main' }] }),
  build({
    ...sharedOptions,
    entryPoints: ['src/main.ts'],
  }),
  build({
    ...sharedOptions,
    entryPoints: ['src/preload.ts'],
  }),
])
