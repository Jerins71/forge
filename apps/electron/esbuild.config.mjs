import { build } from 'esbuild'

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
