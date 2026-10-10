/** Full development Desktop entry, real preload/renderer/backend, and whole-process relaunch. */
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { launchFleet, controlEnvironment, repositoryRoot, sanitizedEnvironment, type BootstrapSession } from './launch.js';
import { seedUiEnvironment, serveBuiltUi } from './fixtures/ui-fleet.js';

const fleet = await launchFleet({ environments: 1, out: join(repositoryRoot, '.internal/forge-v2-remote/desktop-manifest.json') });
const report: Record<string, any> = { passed: false, packaged: false, platform: process.platform, arch: process.arch, node: process.version, testedCommit: fleet.manifest.testedCommit, launches: [] };
let application: ElectronApplication | undefined;
let ui: Awaited<ReturnType<typeof serveBuiltUi>> | undefined;
try {
  const environment = fleet.manifest.environments[0]!;
  const bootstrap = await controlEnvironment<BootstrapSession>(fleet.manifest, environment.name, 'bootstrap');
  const seeded = await seedUiEnvironment(environment, bootstrap);
  await controlEnvironment(fleet.manifest, environment.name, 'stop');
  ui = await serveBuiltUi(join(repositoryRoot, 'apps/ui/.output/public'), '', { port: fleet.manifest.uiPort });
  const userData = join(fleet.manifest.root, 'desktop-user-data');
  await mkdir(join(fleet.manifest.artifactRoot, 'ui'), { recursive: true });
  const env = { ...sanitizedEnvironment(), FORGE_DATA_DIR: environment.dataDir, FORGE_INSTALLATION_STATE_DIR: environment.installationStateDir,
    FORGE_ELECTRON_USER_DATA_DIR: userData, FORGE_ELECTRON_DEV_SERVER_URL: ui.url, FORGE_HOST: '127.0.0.1', FORGE_PORT: String(environment.port),
    FORGE_CWD_ALLOWLIST_ROOTS: environment.checkout, CODEX_BIN: join(repositoryRoot, 'scripts/environment-e2e/fake-codex.mjs'), FORGE_TELEMETRY: 'false', OTEL_SDK_DISABLED: 'true' };
  for (const stage of ['startup', 'relaunch']) {
    const started = Date.now();
    application = await electron.launch({ args: [join(repositoryRoot, 'apps/electron/dist/main.js')], cwd: join(repositoryRoot, 'apps/electron'), env, timeout: 60000 });
    const page = await application.firstWindow({ timeout: 60000 });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByTestId('rooms-mode-switch').filter({ visible: true })).toBeVisible({ timeout: 60000 });
    await page.goto(`${ui.url}/?agent=${seeded.sessionId}`);
    await expect(page).toHaveURL(new RegExp(`agent=${seeded.sessionId}`));
    const composer = page.getByRole('combobox', { name: /^(Message |Send another message to )/ });
    await expect(composer).toBeEnabled({ timeout: 60000 });
    const publicState = await page.evaluate(async () => {
      const primary = await (window as any).electronBridge.environmentCredentials.primary();
      if (!primary.ok) throw new Error(primary.error.code);
      return { environmentId: primary.value.environmentId, deviceSessionId: primary.value.deviceSessionId };
    });
    expect(publicState.environmentId).toBe(seeded.environmentId);
    if (stage === 'startup') {
      await composer.fill('Desktop relaunch synthetic marker');
      await composer.press('Enter');
    }
    await expect(page.locator('[data-chat-transcript-surface]').filter({ visible: true }).first()).toContainText('Desktop relaunch synthetic marker', { timeout: 30000 });
    await page.screenshot({ path: join(fleet.manifest.artifactRoot, 'ui', `desktop-${stage}.png`), fullPage: true });
    const native = await application.evaluate(({ app }) => ({ userData: app.getPath('userData'), electron: process.versions.electron, node: process.versions.node, pid: process.pid }));
    expect(native.userData).toBe(userData);
    expect(errors).toEqual([]);
    report.launches.push({ stage, ...publicState, ...native, durationMs: Date.now() - started, transcriptPersisted: true });
    await application.close(); application = undefined;
    await expect.poll(async () => fetch(`${environment.baseUrl}/api/v2/environment`).then(() => true, () => false), { timeout: 15000 }).toBe(false);
  }
  expect(report.launches[1].pid).not.toBe(report.launches[0].pid);
  expect(report.launches[1].deviceSessionId).toBe(report.launches[0].deviceSessionId);
  const installationManifest = JSON.parse(await readFile(join(environment.installationStateDir, 'manifest.json'), 'utf8'));
  expect(installationManifest.backendEntry).toBe(join(repositoryRoot, 'apps/backend/src/index.ts'));
  report.installationIsolated = true; report.identityStable = true; report.encryptedCredentialReload = true; report.passed = true;
} catch (error) {
  const page = application?.windows()[0];
  if (page) { await page.screenshot({ path: join(fleet.manifest.artifactRoot, 'ui/desktop-failure.png') }).catch(() => undefined); report.page = await page.locator('body').innerText().catch(() => 'Unavailable'); }
  report.failure = error instanceof Error ? error.message : String(error); throw error; }
finally {
  await application?.close(); await ui?.stop();
  await writeFile(join(fleet.manifest.artifactRoot, 'desktop-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ artifactRoot: fleet.manifest.artifactRoot, ...report }, null, 2));
  await fleet.stop(!report.passed);
}
