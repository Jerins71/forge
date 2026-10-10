/** Real hidden-window acceptance entry; never part of the Desktop production entry. */
import { app, BrowserWindow, ipcMain, protocol, safeStorage } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createEnvironmentCredentialService, installEnvironmentCredentialsIpc } from './environment-credentials-ipc.js'
import { ensurePrimaryEnvironmentSession } from './environment-bootstrap-ipc.js'

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
const fixturePath = process.env.FORGE_ELECTRON_ENVIRONMENT_FIXTURE!
const input = JSON.parse(readFileSync(fixturePath, 'utf8'))
mkdirSync(join(input.root, 'electron-user-data'), { recursive: true })
app.setPath('userData', join(input.root, 'electron-user-data'))
writeFileSync(input.reportPath, JSON.stringify({ passed: false, stage: 'entry', realElectron: process.versions.electron }))
let child: ChildProcess | undefined
let window: BrowserWindow | undefined
async function stopBackend() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const owned = child
  await new Promise<void>(resolve => { const timer = setTimeout(() => owned.kill('SIGKILL'), 10000); owned.once('exit', () => { clearTimeout(timer); resolve() }); owned.send({ type: 'shutdown' }) })
}
async function startBackend() {
  child = spawn(input.nativeNode, ['--import', input.tsx, join(input.repositoryRoot, 'scripts/environment-e2e/fixtures/backend-process.ts')], { cwd: input.environment.checkout, env: input.backendEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  child.stdout!.resume(); child.stderr!.resume()
  const owned = child
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Electron-owned backend readiness timed out')), 30000); owned.once('exit', () => { clearTimeout(timer); reject(new Error('Electron-owned backend exited')) }); owned.on('message', value => { if ((value as { type?: string }).type === 'ready') { clearTimeout(timer); resolve() } }) })
  return owned
}
void app.whenReady().then(async () => {
  writeFileSync(input.reportPath, JSON.stringify({ passed: false, stage: 'ready', realElectron: process.versions.electron }))
  const report: Record<string, unknown> = { passed: false, realElectron: process.versions.electron, steps: [] }
  try {
    ipcMain.on('forge:get-backend-bootstrap', event => { event.returnValue = { backendUrl: input.environment.baseUrl, backendWsUrl: input.environment.baseUrl.replace(/^http/, 'ws'), version: 'fixture', platform: process.platform, appRuntime: 'development', appStartedAt: new Date().toISOString(), windowRole: 'main', managedBrowserPopoutAvailable: false, secureControlToken: 'synthetic-fixture-secure-capability-000000' } })
    window = new BrowserWindow({ show: false, webPreferences: { preload: join(input.repositoryRoot, 'apps/electron/dist/preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
    writeFileSync(input.reportPath, JSON.stringify({ passed: false, stage: 'window-created', realElectron: process.versions.electron }))
    report.safeStorageAvailable = await safeStorage.isAsyncEncryptionAvailable()
    writeFileSync(input.reportPath, JSON.stringify({ passed: false, stage: 'safe-storage-checked', realElectron: process.versions.electron, safeStorageAvailable: report.safeStorageAvailable }))
    assert.equal(report.safeStorageAvailable, true, 'OS encrypted safeStorage is unavailable in this runtime')
    let credentials = createEnvironmentCredentialService({ storePath: join(input.root, 'electron-credentials.json'), safeStorage })
    let owned = await startBackend()
    const first = await ensurePrimaryEnvironmentSession({ child: owned, baseUrl: input.environment.baseUrl, credentials })
    assert.equal(first.environmentId, input.environment.environment.environmentId)
    protocol.handle('app', () => new Response('<!doctype html><html><body>Environment acceptance</body></html>', { headers: { 'content-type': 'text/html' } }))
    let uninstall = installEnvironmentCredentialsIpc({ ipcMain, service: credentials, isTrustedSender: event => (event as Electron.IpcMainInvokeEvent).sender.id === window?.webContents.id && (event as Electron.IpcMainInvokeEvent).senderFrame?.url.startsWith('app://forge/') === true })
    await window.loadURL('app://forge/environment-acceptance')
    const renderer = await window.webContents.executeJavaScript(`(async () => {
      const bridge = window.electronBridge.environmentCredentials;
      const primary = await bridge.primary(); if (!primary.ok) throw new Error(primary.error.code);
      const binary = await bridge.requestBinary({ environmentId: primary.value.environmentId, method: 'GET', path: ${JSON.stringify(input.binaryPath)}, maxBytes: 4 });
      if (!binary.ok) throw new Error(binary.error.code + ':' + binary.error.message);
      return { environmentId: primary.value.environmentId, deviceSessionId: primary.value.deviceSessionId, hasBearer: Object.keys(primary.value).some(k => /bearer|token|secret/i.test(k)), status: binary.value.status, typed: binary.value.bytes instanceof Uint8Array, bytes: Array.from(binary.value.bytes) };
    })()`)
    assert.equal(renderer.hasBearer, false); assert.equal(renderer.status, 200); assert.equal(renderer.typed, true); assert.deepEqual(renderer.bytes, [0, 127, 128, 255]); report.bootstrap = renderer
    await stopBackend(); owned = await startBackend()
    uninstall(); credentials = createEnvironmentCredentialService({ storePath: join(input.root, 'electron-credentials.json'), safeStorage })
    const restarted = await ensurePrimaryEnvironmentSession({ child: owned, baseUrl: input.environment.baseUrl, credentials })
    assert.equal(restarted.environmentId, first.environmentId); assert.equal(restarted.deviceSessionId, first.deviceSessionId)
    uninstall = installEnvironmentCredentialsIpc({ ipcMain, service: credentials, isTrustedSender: event => (event as Electron.IpcMainInvokeEvent).sender.id === window?.webContents.id && (event as Electron.IpcMainInvokeEvent).senderFrame?.url.startsWith('app://forge/') === true })
    const revoked = await window.webContents.executeJavaScript(`(async () => {
      const bridge = window.electronBridge.environmentCredentials; const primary = (await bridge.primary()).value;
      const ticket = await bridge.wsTicket(primary.environmentId, 'rpc', 2); if (!ticket.ok) throw new Error(ticket.error.code);
      const ws = new WebSocket(${JSON.stringify(input.environment.baseUrl.replace(/^http/, 'ws') + '/api/v2/rpc')}, ['forge.v2', 'ticket.' + ticket.value.ticket]);
      const closed = new Promise(resolve => ws.onclose = event => resolve(event.code));
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Renderer RPC unavailable')) });
      ws.send(JSON.stringify({type:'request',requestId:'revoke-self',method:'access.devices.revoke',input:{deviceSessionId:primary.deviceSessionId}}));
      const closeCode = await closed; const session = await bridge.session(primary.environmentId);
      // The runtime's revocation handler clears its credential port through this same preload operation.
      const cleared = await bridge.remove(primary.environmentId); if (!cleared.ok) throw new Error(cleared.error.code);
      return { closeCode, sessionDenied: !session.ok && session.error.code === 'UNAUTHENTICATED', primaryCleared: (await bridge.primary()).value === null };
    })()`)
    assert.equal(revoked.closeCode, 4401); assert.equal(revoked.sessionDenied, true); assert.equal(revoked.primaryCleared, true)
    report.restart = { identityStable: true, encryptedCredentialReload: true, deviceSessionStable: true }; report.revoke = { ...revoked, rendererClearedCredentialPort: true }; report.passed = true
    uninstall()
  } catch (error) { report.error = error instanceof Error ? error.message : String(error) }
  finally { await stopBackend(); await writeFile(input.reportPath, JSON.stringify(report, null, 2)); window?.destroy(); app.exit(report.passed ? 0 : 1) }
})
