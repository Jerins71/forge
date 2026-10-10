import { launchFleet, controlEnvironment, repositoryRoot, sanitizedEnvironment, type BootstrapSession } from './launch.js';
import { seedUiEnvironment } from './fixtures/ui-fleet.js';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const electronRequire = createRequire(join(repositoryRoot, 'apps/electron/package.json'));
const backendRequire = createRequire(join(repositoryRoot, 'apps/backend/package.json'));
const fleet = await launchFleet({ environments: 1, out: join(repositoryRoot, '.internal/forge-v2-remote/electron-manifest.json') });
let failed = true;
try {
  const environment = fleet.manifest.environments[0]!;
  const session = await controlEnvironment<BootstrapSession>(fleet.manifest, environment.name, 'bootstrap');
  const seeded = await seedUiEnvironment(environment, session);
  await writeFile(join(environment.checkout, 'preview.pdf'), new Uint8Array([0, 127, 128, 255]));
  await controlEnvironment(fleet.manifest, environment.name, 'stop');
  const inputPath = join(fleet.manifest.root, 'electron-fixture.json');
  const reportPath = join(fleet.manifest.artifactRoot, 'electron-smoke.json');
  await writeFile(inputPath, JSON.stringify({ root: fleet.manifest.root, environment, repositoryRoot, nativeNode: process.execPath, tsx: backendRequire.resolve('tsx'), reportPath,
    binaryPath: `/api/files/raw?agentId=${encodeURIComponent(seeded.sessionId)}&path=preview.pdf`,
    backendEnv: { ...sanitizedEnvironment(), FORGE_DATA_DIR: environment.dataDir, FORGE_HOST: '127.0.0.1', FORGE_PORT: String(environment.port), FORGE_E2E_CHECKOUT: environment.checkout,
      FORGE_INSTALLATION_STATE_DIR: environment.installationStateDir, FORGE_ENVIRONMENT_BOOTSTRAP_PARENT: '1', FORGE_ALLOWED_CLIENT_ORIGINS: 'app://forge', CODEX_BIN: join(repositoryRoot, 'scripts/environment-e2e/fake-codex.mjs') },
  }), { mode: 0o600 });
  const main = join(fleet.manifest.artifactRoot, 'electron-main.cjs');
  const { build } = electronRequire('esbuild') as { build(options: Record<string, unknown>): Promise<unknown> };
  await build({ entryPoints: [join(repositoryRoot, 'apps/electron/src/environment-fixture-main.ts')], outfile: main, bundle: true, external: ['electron'], platform: 'node', format: 'cjs', target: 'node22' });
  const child = spawn(electronRequire('electron'), [main], { cwd: join(repositoryRoot, 'apps/electron'), env: { ...sanitizedEnvironment(), FORGE_ELECTRON_ENVIRONMENT_FIXTURE: inputPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.resume(); let stderr = ''; child.stderr!.on('data', chunk => { if (stderr.length < 16000) stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Real Electron acceptance exceeded 120 seconds')); }, 120000); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
  await writeFile(join(fleet.manifest.artifactRoot, 'electron-stderr.log'), stderr);
  const report = JSON.parse(await readFile(reportPath, 'utf8').catch(() => JSON.stringify({ passed: false, error: `Electron exited (${code}) before the acceptance entry ran; see electron-stderr.log` })));
  console.log(JSON.stringify({ artifactRoot: fleet.manifest.artifactRoot, ...report }, null, 2));
  if (code !== 0 || report.passed !== true) throw new Error('Real Electron bootstrap/restart/revoke smoke failed; see electron-smoke.json');
  failed = false;
} finally { await fleet.stop(failed); }
