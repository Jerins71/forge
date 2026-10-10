/** Real Mac Desktop, production host IPC and native Browser RPC acceptance.
 * Failure modes: private authority leaks to remote grants, duplicate open after
 * restart, live/bootstrap divergence, recording/reparent destroys the guest.
 * Every browser observation/action has a 15-second budget. */
import { _electron as electron, expect as baseExpect, type ElectronApplication } from '@playwright/test';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { mkdir, writeFile, stat, cp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { launchFleet, controlEnvironment, repositoryRoot, sanitizedEnvironment, type BootstrapSession } from './launch.js';
import { seedUiEnvironment, serveBuiltUi } from './fixtures/ui-fleet.js';
import { fixtureRpcOnce, until } from './fixtures/rpc-client.js';
import { getEnvironmentDbPath } from '../../apps/backend/src/swarm/storage/data-paths.js';
import type { BrowserSessionSnapshot } from '../../packages/protocol/src/browser-automation.js';
const expect = baseExpect.configure({ timeout: 15000 });
const fleet = await launchFleet({ environments: 1, out: join(repositoryRoot, '.internal/forge-v2-p2b6/browser-manifest.json') });
let application: ElectronApplication | undefined;
let ui: Awaited<ReturnType<typeof serveBuiltUi>> | undefined;
const report: Record<string, any> = { passed: false, platform: process.platform, windows: 'untested', testedCommit: fleet.manifest.testedCommit, node: process.version, launches: [] };
try {
  const environment = fleet.manifest.environments[0]!;
  const bootstrap = await controlEnvironment<BootstrapSession>(fleet.manifest, environment.name, 'bootstrap');
  const seeded = await seedUiEnvironment(environment, bootstrap);
  await controlEnvironment(fleet.manifest, environment.name, 'stop');
  ui = await serveBuiltUi(join(repositoryRoot, 'apps/ui/.output/public'), '', { port: fleet.manifest.uiPort });
  const userData = join(fleet.manifest.root, 'browser-electron-user-data');
  await mkdir(join(fleet.manifest.artifactRoot, 'browser'), { recursive: true });
  const env = { ...sanitizedEnvironment(), FORGE_DATA_DIR: environment.dataDir, FORGE_INSTALLATION_STATE_DIR: environment.installationStateDir,
    FORGE_ELECTRON_USER_DATA_DIR: userData, FORGE_ELECTRON_DEV_SERVER_URL: ui.url, FORGE_UI_PORT: String(fleet.manifest.uiPort), FORGE_HOST: '127.0.0.1', FORGE_PORT: String(environment.port),
    FORGE_CWD_ALLOWLIST_ROOTS: environment.checkout, CODEX_BIN: join(repositoryRoot, 'scripts/environment-e2e/fake-codex.mjs'), FORGE_TELEMETRY: 'false', OTEL_SDK_DISABLED: 'true' };
  const snapshot = () => fixtureRpcOnce<BrowserSessionSnapshot>(environment.baseUrl, bootstrap, 'browser.get', { sessionId: seeded.sessionId });
  let retainedTab = '';
  let firstOpen: Record<string, any> | undefined;
  const backendRequire = createRequire(join(repositoryRoot, 'apps/backend/package.json'));
  const Database = backendRequire('better-sqlite3');
  const receipts = () => {
    const database = new Database(getEnvironmentDbPath(environment.dataDir), { readonly: true });
    try { return database.prepare("SELECT c.command_id,c.method,c.normalized_json,r.state,r.receipt_json FROM commands c JOIN command_receipts r USING(command_id) WHERE c.method LIKE 'browser.%' ORDER BY c.created_at").all() as Array<Record<string, any>>; }
    finally { database.close(); }
  };
  for (const stage of ['startup', 'restart']) {
    application = await electron.launch({ args: [join(repositoryRoot, 'apps/electron/dist/main.js')], cwd: join(repositoryRoot, 'apps/electron'), env, timeout: 15000 });
    const page = await application.firstWindow({ timeout: 15000 });
    page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByTestId('rooms-mode-switch').filter({ visible: true })).toBeVisible();
    await page.goto(`${ui.url}/?agent=${seeded.sessionId}&deckPanel=browser`);
    const workspace = page.getByRole('region', { name: 'Browser workspace', exact: true });
    await expect(workspace).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'New browser tab', exact: true })).toBeEnabled();
    if (stage === 'startup') await workspace.getByRole('button', { name: 'Open a tab', exact: true }).click();
    await expect(workspace.getByRole('tab')).toHaveCount(1);
    const before = await until(snapshot, value => value.tabs.length === 1 && value.tabs[0]!.live);
    if (stage === 'startup') {
      retainedTab = before.tabs[0]!.tabId;
      firstOpen = receipts().find(value => value.method === 'browser.tab.open');
      expect(firstOpen).toBeTruthy();
      await workspace.getByRole('button', { name: 'New browser tab', exact: true }).click();
      await expect(workspace.getByRole('tab')).toHaveCount(2);
      await workspace.getByRole('tab').first().click();
      await until(snapshot, value => value.activeTabId === retainedTab);
      await workspace.getByRole('button', { name: /^Close / }).last().click();
      await expect(workspace.getByRole('tab')).toHaveCount(1);
      await workspace.getByRole('spinbutton', { name: 'Viewport width' }).fill('800');
      await workspace.getByRole('spinbutton', { name: 'Viewport height' }).fill('600');
      await workspace.getByRole('button', { name: 'Resize', exact: true }).click();
      await until(snapshot, value => value.tabs[0]?.viewportSetting.mode === 'freeform' && value.tabs[0].viewportSetting.width === 800);
      await workspace.getByRole('button', { name: 'Start recording', exact: true }).click();
      await expect(workspace.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
      const guestIds = () => application!.evaluate(({ BrowserWindow, webContents }) => { const windows = BrowserWindow.getAllWindows().map(window => window.webContents.id); return webContents.getAllWebContents().filter(value => !windows.includes(value.id)).map(value => value.id).sort(); });
      const beforeReparent = await guestIds(); expect(beforeReparent).toHaveLength(1);
      await workspace.getByRole('button', { name: 'Open Automatic Browser in a separate window', exact: true }).click();
      const popout = await until(() => application!.windows().find(window => window !== page && window.url().startsWith(ui!.url)), value => value !== undefined);
      if (!popout) throw new Error('Native pop-out did not load');
      popout.setDefaultTimeout(15000);
      await expect(popout.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
      await popout.getByRole('button', { name: 'Stop recording', exact: true }).click();
      await expect(popout.getByRole('button', { name: 'Start recording', exact: true })).toBeVisible();
      await popout.getByRole('button', { name: 'Dock Automatic Browser in main window', exact: true }).click();
      await expect(workspace.getByRole('button', { name: 'Start recording', exact: true })).toBeVisible();
      const native = await application.evaluate(({ webContents }) => webContents.getAllWebContents().map(value => ({ id: value.id, type: value.getType(), url: value.getURL() })));
      const recordingReceipt = receipts().find(value => value.method === 'browser.recording.stop');
      const recording = JSON.parse(recordingReceipt!.receipt_json).result.browserRecording;
      expect((await stat(recording.path)).size).toBeGreaterThan(0);
      const savedRecording = join(fleet.manifest.artifactRoot, 'browser', `recording.${recording.extension}`); await cp(recording.path, savedRecording);
      report.recording = { mimeType: recording.mimeType, sizeBytes: recording.sizeBytes, path: savedRecording };
      expect(await guestIds()).toEqual(beforeReparent);
      report.recordingDuringReparent = true; report.nativeGuests = native.filter(value => beforeReparent.includes(value.id));
      for (const method of ['browser.host.attach', 'browser.tab.open']) {
        const denied = await fixtureRpcOnce(environment.baseUrl, bootstrap, method, method.endsWith('attach') ? {} : { sessionId: seeded.sessionId, commandId: randomUUID() }).then(() => false, error => error.code === 'FORBIDDEN');
        expect(denied).toBe(true);
      }
      report.remoteDenied = true;
      const after = await snapshot(); expect(after.tabs.map(value => value.tabId)).toEqual([retainedTab]);
      const opened = receipts().filter(value => value.method === 'browser.tab.open'); expect(opened).toHaveLength(2);
      expect(receipts().some(value => value.method === 'browser.tab.resize')).toBe(false);
      report.ephemeralResize = true;
    } else {
      expect(before.tabs.map(value => value.tabId)).toEqual([retainedTab]);
      const openCount = receipts().filter(value => value.method === 'browser.tab.open').length;
      // Send the same durable identity on the Desktop's own socket through the
      // credential port. Receipt replay succeeds without another physical open.
      const replay = await page.evaluate(async ({ commandId, input }) => {
        const bridge = (window as any).electronBridge.environmentCredentials;
        const primary = (await bridge.primary()).value;
        const ticket = await bridge.wsTicket(primary.environmentId, 'rpc', 2); if (!ticket.ok) throw new Error(ticket.error.message);
        const target = (window as any).electronBridge.backendWsUrl.replace(/\/$/, '') + '/api/v2/rpc';
        const ws = new WebSocket(target, ['forge.v2', `ticket.${ticket.value.ticket}`]);
        await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('Receipt replay socket failed')); });
        const result = new Promise<any>((resolve, reject) => { const timer = setTimeout(() => { ws.close(); reject(new Error('Receipt replay exceeded 15s')); }, 15000); ws.onmessage = event => { const frame = JSON.parse(event.data); if (frame.requestId !== 'browser-replay') return; clearTimeout(timer); ws.close(); if (frame.type === 'result') resolve(frame.output); else reject(new Error(frame.error.message)); }; });
        ws.send(JSON.stringify({ type: 'request', requestId: 'browser-replay', method: 'browser.tab.open', input: { ...input, commandId } }));
        return result;
      }, { commandId: firstOpen!.command_id, input: JSON.parse(firstOpen!.normalized_json) });
      expect(replay.state).toBe('succeeded'); expect(receipts().filter(value => value.method === 'browser.tab.open')).toHaveLength(openCount);
      expect((await snapshot()).tabs.map(value => value.tabId)).toEqual([retainedTab]);
      report.canonicalRestart = true; report.receiptReplayNoDuplicate = true;
    }
    await page.screenshot({ path: join(fleet.manifest.artifactRoot, 'browser', `${stage}.png`) });
    const native = await application.evaluate(({ app }) => ({ userData: app.getPath('userData'), electron: process.versions.electron, pid: process.pid }));
    expect(native.userData).toBe(userData); expect(errors).toEqual([]);
    report.launches.push({ stage, ...native });
    await application.close(); application = undefined;
    await expect.poll(() => fetch(`${environment.baseUrl}/api/v2/environment`).then(() => true, () => false)).toBe(false);
  }
  report.receipts = receipts().map(value => ({ commandId: value.command_id, method: value.method, state: value.state }));
  report.passed = true;
} catch (error) {
  const page = application?.windows()[0];
  if (page) { report.page = await page.locator('body').innerText().catch(() => 'Unavailable'); await page.screenshot({ path: join(fleet.manifest.artifactRoot, 'browser/failure.png') }).catch(() => undefined); }
  report.failure = error instanceof Error ? error.stack : String(error); throw error;
}
finally {
  await application?.close(); await ui?.stop();
  await writeFile(join(fleet.manifest.artifactRoot, 'browser-smoke.json'), JSON.stringify(report, null, 2));
  // Require a durable report even when the fixture root is disposed.
  await writeFile(join(repositoryRoot, '.internal/forge-v2-p2b6/browser-smoke.json'), JSON.stringify({ artifactRoot: fleet.manifest.artifactRoot, ...report }, null, 2));
  console.log(JSON.stringify({ artifactRoot: fleet.manifest.artifactRoot, ...report }, null, 2));
  await fleet.stop(!report.passed);
}
