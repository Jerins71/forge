import { test as base } from '@playwright/test';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { launchFleet, readManifest, verifyFleetHealth, repositoryRoot } from '../launch.js';

/** Suite options force separate workers: destructive slice scenarios cannot contaminate UI/load. */
export const test = base.extend<{ environmentFailure: void }, { environmentSuite: string; environmentManifest: string }>({
  environmentSuite: ['', { scope: 'worker', option: true }],
  environmentManifest: [async ({ environmentSuite }, use, worker) => {
    if (process.env.FORGE_E2E_MANIFEST) {
      await verifyFleetHealth(await readManifest(process.env.FORGE_E2E_MANIFEST));
      await use(process.env.FORGE_E2E_MANIFEST);
      return; // Explicit attachment never takes ownership of another launcher's fleet.
    }
    if (!['slice', 'ui', 'load', 'cli'].includes(environmentSuite)) throw new Error('Environment suite must select its fleet');
    const out = join(repositoryRoot, `.internal/forge-v2-remote/e2e-manifest-${process.env.FORGE_E2E_RUN_ID}-${worker.workerIndex}-${environmentSuite}.json`);
    const fleet = await launchFleet({ environments: Number(process.env.FORGE_E2E_ENVIRONMENTS ?? (environmentSuite === 'load' ? 8 : 3)), out });
    process.env.FORGE_E2E_MANIFEST = fleet.manifestPath;
    try { await use(fleet.manifestPath); }
    finally {
      let failed = false;
      try { await readFile(join(fleet.manifest.artifactRoot, 'test-failure.json')); failed = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await fleet.stop(failed);
      delete process.env.FORGE_E2E_MANIFEST;
    }
  }, { scope: 'worker', auto: true, timeout: 180_000 }],
  environmentFailure: [async ({ environmentManifest }, use, info) => {
    await use();
    if (info.status === info.expectedStatus) return;
    const manifest = await readManifest(environmentManifest);
    await writeFile(join(manifest.artifactRoot, 'test-failure.json'), JSON.stringify({ status: info.status }));
  }, { auto: true }],
});
