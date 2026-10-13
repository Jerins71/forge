import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: ['browser-engine.spec.ts', 'slice.spec.ts', 'ui.spec.ts', 'lineage-ui.spec.ts', 'ux.spec.ts', 'activity.spec.ts', 'polish.spec.ts', 'load.spec.ts', 'cli.spec.ts'],
  globalSetup: fixture('global-setup.ts'),
  fullyParallel: false, workers: 1, retries: 0, timeout: 60_000,
  outputDir: '../../.internal/forge-v2-remote/e2e/playwright',
  reporter: [['list'], [fixture('artifact-reporter.ts')]],
  // Sensitive exchange is done through the in-memory platform bridge once A/D
  // land. UI spec enables trace only around noncredential interaction, and must
  // strip credential-bearing network metadata before adding it to artifact index.
  use: { trace: 'off', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
