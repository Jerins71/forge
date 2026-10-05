import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchFleet, readManifest, verifyFleetHealth } from '../launch.js';
import { writeInfrastructureArtifacts } from '../assert-artifacts.js';
export default async function globalSetup() {
  if (process.env.FORGE_E2E_MANIFEST) {
    await verifyFleetHealth(await readManifest(process.env.FORGE_E2E_MANIFEST));
    return; // Attaching to a long-lived fleet never takes ownership of its PIDs.
  }
  // Fleet backends load @forge/protocol from dist; a stale build silently runs old contracts.
  execFileSync('pnpm', ['--filter', '@forge/protocol', 'build'], { stdio: 'inherit' });
  const isLoad = process.argv.some(arg => arg.includes('load.spec'));
  const fleet = await launchFleet({ environments: Number(process.env.FORGE_E2E_ENVIRONMENTS ?? (isLoad ? 8 : 3)), out: join(process.cwd(), `.internal/forge-v2-remote/e2e-manifest-${process.pid}.json`) });
  process.env.FORGE_E2E_MANIFEST = fleet.manifestPath;
  return async () => {
    let failed = false;
    try { await readFile(join(fleet.manifest.artifactRoot, 'test-failure.json')); failed = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await fleet.stop(failed);
    await writeInfrastructureArtifacts(fleet.manifest, fleet.manifestPath);
  };
}
