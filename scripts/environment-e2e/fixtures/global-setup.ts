import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { repositoryRoot, readManifest, verifyFleetHealth } from '../launch.js';
export default async function globalSetup() {
  if (process.env.FORGE_E2E_MANIFEST) await verifyFleetHealth(await readManifest(process.env.FORGE_E2E_MANIFEST));
  // Fleet backends load dist; build the shared contract before any suite starts.
  execFileSync('pnpm', ['--filter', '@forge/protocol', 'build'], { cwd: repositoryRoot, stdio: 'inherit' });
  process.env.FORGE_E2E_RUN_ID = randomUUID();
}
