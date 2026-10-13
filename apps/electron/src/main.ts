import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, safeStorage, shell } from 'electron'
import { fork, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createManagedHostService, type ManagedServerArtifact } from './managed-hosts.js'
import { installManagedHostsIpc, MANAGED_HOSTS_CHANGED_CHANNEL } from './managed-hosts-ipc.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkForUpdatesManually, downloadUpdateManually, installUpdateManually, initAutoUpdater, getBetaChannel, setBetaChannel } from './auto-updater.js'
import { installCli, verifyCliInstall, writeInstallHint, type CliInstallResult } from './cli-install.js'
import { buildCommandCenterRouteUrl, buildSkillImportRouteUrl, findCommandCenterDeepLinkInArgs, findSkillImportUrlInArgs, parseCommandCenterDeepLink, parseSkillImportDeepLink, shouldRegisterExternalDeepLinkProtocol } from './deep-link.js'
import { fixPath } from './fix-path.js'
import { SleepBlockerService, type SleepBlockerSettingsPatch, type SleepBlockerStatus } from './sleep-blocker.js'
import { sendSleepBlockerStatusToWindow } from './sleep-blocker-status-ipc.js'
import { sendToRendererWindow } from './renderer-ipc.js'
import {
  installMainRendererRecovery,
  MAIN_RENDERER_READY_CHANNEL,
  type MainRendererRecoveryController,
} from './main-renderer-recovery.js'
import { loadWindowState, trackWindowState } from './window-state.js'
import { consumePostUpdateInfo } from './whats-new.js'
import { createEnvironmentCredentialService, installEnvironmentCredentialsIpc, readPrimaryEnvironmentActivity, ENVIRONMENT_ARTIFACT_SCHEME } from './environment-credentials-ipc.js'
import { ensurePrimaryEnvironmentSession, writeEnvironmentInstallationManifest } from './environment-bootstrap-ipc.js'
import { createBackendForkOptions, resolveBackendExposurePolicy, type DesktopEnvironmentExposure } from './backend-fork-options.js'
import { readSettings } from './electron-settings.js'
import { resolveDevBetterSqlite3Binding } from './dev-native-binding.js'
import { PackagedRemoteUiServer, resolvePackagedRemoteUiHost, startOptionalPackagedRemoteUi } from './packaged-remote-ui-server.js'
import { DesktopBrowserHost } from './browser/desktop-browser-host.js'
import { LifecycleLog } from './lifecycle-log.js'
import { rotateLogFileIfLarge } from './log-rotation.js'
import { installElectronDevelopmentProcessControl } from './dev-process-control.js'
import {
  createSecureVaultController,
  initializeSecureVaultAtStartup,
  installSecureVaultChildBridge,
  installSecureVaultRendererIpc,
} from './secure-vault-ipc.js'
import { applyElectronStartupOverrides } from './startup-overrides.js'
import { validateAbsoluteLocalFilePath } from './open-path.js'
import { installOpenPdfIpc } from './open-pdf.js'
import { installOpenHtmlIpc } from './open-html.js'
import { handleMainRendererWindowOpen, isUnsafeRendererWindowOpenUrl } from './window-open-policy.js'
import { getStreamDeckPluginStatus, resolveStreamDeckAppPath, resolveStreamDeckPluginPath } from './stream-deck-install.js'

// Load .env from repo root so FORGE_PORT etc. are available in main process
loadDotEnv()

const electronStartupOverrides = applyElectronStartupOverrides({
  app,
  env: process.env,
})
const electronDevServerUrl = electronStartupOverrides.devServerUrl
const DEFAULT_BACKEND_PORT = 47287
const BACKEND_READY_CHANNEL = 'forge:get-backend-bootstrap'
const TERMINAL_SHORTCUT_CHANNEL = 'bridge:terminal-shortcut'
const POST_UPDATE_INFO_CHANNEL = 'forge:get-post-update-info'
const OPEN_RELEASE_NOTES_CHANNEL = 'forge:open-release-notes'
// Secure Session teardown includes confirmed Docker removal. Give the backend
// enough time to complete its bounded cleanup contract before escalating to a
// process-tree kill.
const BACKEND_SHUTDOWN_TIMEOUT_MS = 30_000
const BACKEND_RESTART_DELAY_MS = 1_000
const BACKEND_LOG_TAIL_LINES = 40
const BACKEND_LOG_FILENAME = 'backend.log'
const BACKEND_LOG_ROTATE_BYTES = 10 * 1024 * 1024
const LIFECYCLE_LOG_FILENAME = 'lifecycle.log'
const PACKAGED_BACKEND_DIRNAME = 'backend'
const PACKAGED_RENDERER_DIRNAME = 'ui'
const PACKAGED_RESOURCES_DIRNAME = 'forge-resources'
const APP_PROTOCOL_SCHEME = 'app'
const APP_PROTOCOL_HOST = 'forge'
const EXTERNAL_PROTOCOL_SCHEME = 'forge'
const ELECTRON_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString()

type ElectronWindowRole = 'main'

type BackendReadyMessage = {
  type: 'ready'
  port: number
  /** Optional for compatibility with older backend children. */
  dataDir?: string
}

type BackendBootstrap = {
  backendUrl: string
  /** Direct loopback address of the owned backend; Secure Sessions only ever use this. */
  loopbackUrl: string
  backendWsUrl: string
  version: string
  platform: string
  appRuntime: 'development' | 'installed'
  appStartedAt: string
  windowRole: ElectronWindowRole
  secureControlToken: string
  /** Backend-resolved, post-migration canonical root. Optional for old Desktop clients. */
  dataDir?: string
}

const desktopBrowserHost = new DesktopBrowserHost()
let mainWindow: BrowserWindow | null = null
let mainRendererRecovery: MainRendererRecoveryController | null = null
let mainWindowClosing = false
let backendBootstrap: BackendBootstrap | null = null
let appIsQuitting = false
let appQuitCleanupComplete = false
let appProtocolRegistered = false
let disposeOpenPdfIpc: (() => void) | null = null
let pendingSkillImportUrl: string | null = findSkillImportUrlInArgs(process.argv)
let pendingCommandCenterDeepLink: string | null = findCommandCenterDeepLinkInArgs(process.argv)
const lifecycleLog = new LifecycleLog({
  getLogPath: () => path.join(app.getPath('userData'), LIFECYCLE_LOG_FILENAME),
})
const secureVaultController = createSecureVaultController({
  safeStorage,
  platform: process.platform,
})
const environmentCredentials = createEnvironmentCredentialService({ storePath: path.join(app.getPath('userData'), 'environment-credentials.json'), safeStorage, clientOrigin: app.isPackaged ? 'app://forge' : new URL(electronDevServerUrl).origin,
  desktopSecureControl: () => backendBootstrap ? { baseUrl: backendBootstrap.backendUrl, loopbackUrl: backendBootstrap.loopbackUrl, token: backendBootstrap.secureControlToken } : null,
})
// Publication seam: release tooling can place an immutable descriptor in resources/server/.
// Development can select the same main-only descriptor without exposing artifact paths to the renderer.
const managedHosts = createManagedHostService({
  storePath: path.join(app.getPath('userData'), 'managed-hosts.json'),
  credentials: environmentCredentials,
  clientOrigin: app.isPackaged ? 'app://forge' : new URL(electronDevServerUrl).origin,
  artifact: async () => {
    const descriptorPath = process.env.FORGE_MANAGED_SERVER_MANIFEST ?? path.join(process.resourcesPath, 'server', 'managed-server.json')
    try {
      const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as ManagedServerArtifact
      if (descriptor.version !== app.getVersion()) throw new Error('Server artifact must match this Desktop version')
      return descriptor
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  onChanged: statuses => sendToRendererWindow(mainWindow, MANAGED_HOSTS_CHANGED_CHANNEL, statuses),
})
const handledTerminationSignals = new Set<NodeJS.Signals>()

app.commandLine.appendSwitch('disable-background-timer-throttling')

protocol.registerSchemesAsPrivileged([
  { scheme: ENVIRONMENT_ARTIFACT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  {
    scheme: APP_PROTOCOL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

class BackendSupervisor {
  private child: ChildProcess | null = null
  private currentPort: number | null = null
  private currentPublicBaseUrl: string | null = null
  private currentDataDir: string | null = null
  private startPromise: Promise<number> | null = null
  private stopping = false
  private restartTimer: NodeJS.Timeout | null = null
  private backendLogPath: string | null = null
  private readonly recentOutputLines: string[] = []
  private stdoutRemainder = ''
  private stderrRemainder = ''
  private readonly secureControlToken = randomBytes(32).toString('base64url')

  constructor(private readonly onReady: (port: number, isRestart: boolean) => void) {}

  get bootstrap(): BackendBootstrap {
    if (this.currentPort == null) {
      throw new Error('Backend bootstrap requested before backend was ready')
    }

    return buildBackendBootstrap(
      this.currentPort,
      this.currentDataDir ?? undefined,
      this.secureControlToken,
      this.currentPublicBaseUrl ?? undefined,
    )
  }

  get currentBackendPort(): number {
    if (this.currentPort == null) {
      throw new Error('Backend port requested before backend was ready')
    }
    return this.currentPort
  }

  get logPath(): string | null {
    return this.ensureBackendLogPath()
  }

  getRecentOutput(lines = BACKEND_LOG_TAIL_LINES): string {
    const recentLines = this.recentOutputLines.slice(-lines)
    return recentLines.join('\n')
  }

  async start(): Promise<number> {
    if (this.startPromise) {
      return this.startPromise
    }

    const isRestart = this.currentPort != null
    this.stopping = false
    lifecycleLog.record('backend_launch_requested', { isRestart })
    this.startPromise = this.launch(isRestart).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async stop(): Promise<void> {
    this.stopping = true

    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }

    const child = this.child
    if (!child) {
      return
    }

    lifecycleLog.record('backend_shutdown_requested', { pid: child.pid ?? null })

    this.child = null

    await new Promise<void>((resolve) => {
      let settled = false

      const finish = (): void => {
        if (settled) {
          return
        }

        settled = true
        resolve()
      }

      const timeout = setTimeout(() => {
        lifecycleLog.record('backend_shutdown_timeout', { pid: child.pid ?? null })
        void this.forceTerminate(child).finally(() => {
          finish()
        })
      }, BACKEND_SHUTDOWN_TIMEOUT_MS)

      child.once('exit', () => {
        clearTimeout(timeout)
        lifecycleLog.record('backend_shutdown_completed', { pid: child.pid ?? null })
        finish()
      })

      try {
        child.send({ type: 'shutdown' })
      } catch {
        clearTimeout(timeout)
        lifecycleLog.record('backend_shutdown_ipc_failed', { pid: child.pid ?? null })
        void this.forceTerminate(child).finally(() => {
          finish()
        })
      }
    })
  }

  private async forceTerminate(child: ChildProcess): Promise<void> {
    lifecycleLog.record('backend_force_terminate_requested', { pid: child.pid ?? null })
    if (process.platform === 'win32') {
      const pid = child.pid
      if (typeof pid !== 'number') {
        return
      }

      try {
        const { taskkillProcessTree } = await import('./win-process.js')
        await taskkillProcessTree(pid)
      } catch {
        // Ignore taskkill failures during shutdown.
      }

      return
    }

    try {
      child.kill('SIGKILL')
    } catch {
      // Ignore kill failures during shutdown.
    }
  }

  private async launch(isRestart: boolean): Promise<number> {
    const backendEntry = resolveBackendEntry()
    const runtimeRoot = resolveBackendRuntimeRoot()
    const resourcesDir = resolveBackendResourcesDir()
    const execArgv = resolveBackendExecArgv(backendEntry)
    const devBetterSqlite3Binding = app.isPackaged
      ? undefined
      : resolveDevBetterSqlite3Binding({
          electronDir: path.resolve(__dirname, '..'),
          electronVersion: process.versions.electron ?? '',
          platform: process.platform,
          arch: process.arch,
        })
    const forkOptions = createBackendForkOptions({
      runtimeRoot,
      inheritedEnv: process.env,
      isPackaged: app.isPackaged,
      backendPort: resolveDefaultBackendPort(),
      resourcesDir,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      execArgv,
      devBetterSqlite3Binding,
      exposure: (readSettings() as ReturnType<typeof readSettings> & {environmentExposure?: DesktopEnvironmentExposure}).environmentExposure,
    })
    const exposure = resolveBackendExposurePolicy(forkOptions.env ?? {})

    await writeEnvironmentInstallationManifest(backendEntry)
    this.initializeLaunchLogging()

    return await new Promise<number>((resolve, reject) => {
      const child = fork(backendEntry, [], forkOptions)

      this.child = child
      desktopBrowserHost.attach(child)
      const secureControlPipe = child.stdio[4]
      if (!secureControlPipe || !('end' in secureControlPipe)) {
        child.kill()
        reject(new Error('Backend secure control capability pipe is unavailable'))
        return
      }
      installSecureVaultChildBridge({
        child,
        controller: secureVaultController,
      })
      lifecycleLog.record('backend_spawned', { isRestart, pid: child.pid ?? null })
      this.attachOutputCapture(child)

      let ready = false
      let settled = false

      const handleSecureControlPipeError = (error: Error): void => {
        finalizeReject(new Error(`Backend secure control capability pipe failed: ${error.message}`))
      }
      const cleanup = (): void => {
        child.off('message', handleMessage)
        child.off('error', handleError)
        secureControlPipe.off('error', handleSecureControlPipeError)
      }

      const finalizeReject = (error: Error): void => {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        reject(error)
      }

      const finalizeResolve = (port: number): void => {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        resolve(port)
      }

      const handleMessage = (message: unknown): void => {
        if (!isBackendReadyMessage(message)) {
          return
        }

        ready = true
        this.currentPort = message.port
        exposure.setLoopbackPort(message.port)
        this.currentPublicBaseUrl = exposure.publicBaseUrl
        this.currentDataDir = message.dataDir && path.isAbsolute(message.dataDir) ? path.normalize(message.dataDir) : null
        lifecycleLog.record('backend_ready', { isRestart, pid: child.pid ?? null, port: message.port })
        void ensurePrimaryEnvironmentSession({ child, baseUrl: exposure.publicBaseUrl, credentials: environmentCredentials }).then(() => {
          this.onReady(message.port, isRestart)
          finalizeResolve(message.port)
        }).catch(() => finalizeReject(new Error('Primary environment pairing could not be initialized')))
      }

      const handleError = (error: Error): void => {
        finalizeReject(new Error(`${error.message}\n\n${this.describeRecentOutput()}`))
      }

      child.on('message', handleMessage)
      child.on('error', handleError)
      secureControlPipe.once('error', handleSecureControlPipeError)
      secureControlPipe.end(this.secureControlToken)
      child.once('exit', (code, signal) => {
        this.flushOutputRemainders()
        lifecycleLog.record('backend_exited', {
          code: code ?? null,
          ready,
          signal: signal ?? null,
          stopping: this.stopping,
        })

        if (this.child === child) {
          this.child = null
        }

        if (!ready) {
          lifecycleLog.record('backend_start_failed', {
            code: code ?? null,
            signal: signal ?? null,
          })
          finalizeReject(
            new Error(
              `Backend exited before signaling readiness (code=${code ?? 'null'}, signal=${signal ?? 'null'}).\n\n${this.describeRecentOutput()}`,
            ),
          )
          return
        }

        if (this.stopping) {
          return
        }

        console.warn(`Backend child exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}). Restarting...`)
        lifecycleLog.record('backend_restart_scheduled', {
          delayMs: BACKEND_RESTART_DELAY_MS,
          code: code ?? null,
          signal: signal ?? null,
        })
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null
          void this.start().catch((error) => {
            console.error('Failed to restart backend child', error)
          })
        }, BACKEND_RESTART_DELAY_MS)
      })
    })
  }

  private attachOutputCapture(child: ChildProcess): void {
    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.captureOutputChunk('stdout', chunk)
    })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.captureOutputChunk('stderr', chunk)
    })
  }

  private captureOutputChunk(stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (text.length === 0) {
      return
    }

    const normalized = text.replace(/\r\n/g, '\n')

    if (stream === 'stdout') {
      const combined = `${this.stdoutRemainder}${normalized}`
      const segments = combined.split('\n')
      this.stdoutRemainder = segments.pop() ?? ''
      for (const line of segments) {
        this.recordOutputLine(stream, line)
      }
      return
    }

    const combined = `${this.stderrRemainder}${normalized}`
    const segments = combined.split('\n')
    this.stderrRemainder = segments.pop() ?? ''
    for (const line of segments) {
      this.recordOutputLine(stream, line)
    }
  }

  private flushOutputRemainders(): void {
    if (this.stdoutRemainder.length > 0) {
      this.recordOutputLine('stdout', this.stdoutRemainder)
      this.stdoutRemainder = ''
    }

    if (this.stderrRemainder.length > 0) {
      this.recordOutputLine('stderr', this.stderrRemainder)
      this.stderrRemainder = ''
    }
  }

  private recordOutputLine(stream: 'stdout' | 'stderr', line: string): void {
    const formatted = `[${stream}] ${line}`
    this.recentOutputLines.push(formatted)

    if (this.recentOutputLines.length > 200) {
      this.recentOutputLines.splice(0, this.recentOutputLines.length - 200)
    }

    this.writeLogLine(formatted)
  }

  private initializeLaunchLogging(): void {
    this.stdoutRemainder = ''
    this.stderrRemainder = ''
    this.recentOutputLines.length = 0
    const logPath = this.ensureBackendLogPath()
    if (logPath) rotateLogFileIfLarge(logPath, BACKEND_LOG_ROTATE_BYTES)
    this.writeLogLine(`=== Backend launch ${new Date().toISOString()} ===`)
  }

  private describeRecentOutput(): string {
    const output = this.getRecentOutput()
    const outputSection = output.length > 0 ? output : '(no output captured)'
    const logPath = this.logPath

    if (!logPath) {
      return `Recent backend output:\n${outputSection}`
    }

    return `Recent backend output:\n${outputSection}\n\nBackend log file: ${logPath}`
  }

  private writeLogLine(line: string): void {
    const logPath = this.ensureBackendLogPath()
    if (!logPath) {
      return
    }

    try {
      mkdirSync(path.dirname(logPath), { recursive: true })
      appendFileSync(logPath, `${line}\n`, 'utf8')
    } catch (error) {
      console.warn('Failed to write backend log output', error)
    }
  }

  private ensureBackendLogPath(): string | null {
    if (this.backendLogPath) {
      return this.backendLogPath
    }

    try {
      this.backendLogPath = path.join(app.getPath('userData'), BACKEND_LOG_FILENAME)
      return this.backendLogPath
    } catch {
      return null
    }
  }
}

const backendSupervisor = new BackendSupervisor((_port, isRestart) => {
  backendBootstrap = backendSupervisor.bootstrap

  if (isRestart && mainWindow && !mainWindow.isDestroyed()) {
    void loadRenderer(mainWindow)
  }
})

let sleepBlockerService: SleepBlockerService | null = null
let packagedRemoteUiServer: PackagedRemoteUiServer | null = null

async function startPackagedRemoteUiServer(): Promise<void> {
  if (!app.isPackaged || packagedRemoteUiServer) {
    return
  }

  const remoteUiServer = new PackagedRemoteUiServer({
    rendererDir: resolvePackagedRendererDir(),
    host: resolvePackagedRemoteUiHost(process.env),
    getBackendPort: () => backendSupervisor.currentBackendPort,
  })
  await remoteUiServer.start()
  packagedRemoteUiServer = remoteUiServer
  lifecycleLog.record('packaged_remote_ui_started', {
    host: resolvePackagedRemoteUiHost(process.env),
    port: remoteUiServer.address?.port ?? null,
  })
}

async function stopPackagedRemoteUiServer(): Promise<void> {
  const remoteUiServer = packagedRemoteUiServer
  packagedRemoteUiServer = null
  if (!remoteUiServer) {
    return
  }

  await remoteUiServer.stop()
  lifecycleLog.record('packaged_remote_ui_stopped')
}

async function prepareQuitForUpdate(): Promise<void> {
  if (!appIsQuitting) {
    appIsQuitting = true
    desktopBrowserHost.hide()
    lifecycleLog.record('electron_quit_prepared_for_update')
    sleepBlockerService?.dispose()
    mainRendererRecovery?.dispose()
    mainRendererRecovery = null
    disposeOpenPdfIpc?.()
    disposeOpenPdfIpc = null
    await managedHosts.dispose()
    await stopPackagedRemoteUiServer()
    await backendSupervisor.stop()
    appQuitCleanupComplete = true
  }
}

function handleTerminationSignal(signal: NodeJS.Signals): void {
  if (handledTerminationSignals.has(signal)) {
    return
  }

  handledTerminationSignals.add(signal)
  lifecycleLog.record('electron_signal_received', { signal })
  app.quit()
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    handleTerminationSignal(signal)
  })
}

installElectronDevelopmentProcessControl({
  isPackaged: app.isPackaged,
  processPort: process,
  requestQuit: () => handleTerminationSignal('SIGINT'),
})

process.on('exit', (code) => {
  lifecycleLog.record('electron_process_exit', { code })
})

function getUnavailableSleepBlockerStatus(): SleepBlockerStatus {
  return {
    enabled: false,
    gracePeriodMinutes: 30,
    blocking: false,
    graceRemainingMs: null,
    reason: 'Sleep prevention is not available.',
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const skillImportUrl = findSkillImportUrlInArgs(argv)
    if (skillImportUrl) {
      openSkillImportUrl(skillImportUrl)
      return
    }
    const commandCenterLink = findCommandCenterDeepLinkInArgs(argv)
    if (commandCenterLink) {
      openCommandCenterDeepLink(commandCenterLink)
      return
    }

    focusMainWindow()
  })

  app.on('open-url', (event, url) => {
    event.preventDefault()
    const skillImportUrl = parseSkillImportDeepLink(url)
    if (skillImportUrl) {
      openSkillImportUrl(skillImportUrl)
      return
    }
    if (parseCommandCenterDeepLink(url)) openCommandCenterDeepLink(url)
  })

  ipcMain.on(BACKEND_READY_CHANNEL, (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) { event.returnValue = null; return }
    event.returnValue = backendBootstrap ?? backendSupervisor.bootstrap
  })

  installEnvironmentCredentialsIpc({ ipcMain, service: environmentCredentials, isTrustedSender: isTrustedMainRenderer })
  installManagedHostsIpc({ipcMain,service:managedHosts,isTrustedSender:isTrustedMainRenderer,supported:process.platform === 'darwin'})
  if (process.platform === 'darwin') void managedHosts.start().catch(() => {})

  ipcMain.on(MAIN_RENDERER_READY_CHANNEL, (event) => {
    if (!isTrustedMainRenderer(event)) return
    mainRendererRecovery?.markReady(event.sender)
  })

  const browserRenderer = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    if (!mainWindow || mainWindow.isDestroyed() || !isTrustedMainRenderer(event) || event.senderFrame !== event.sender.mainFrame) throw new Error('Browser presentation requires the Forge main renderer.')
    return mainWindow
  }
  ipcMain.handle('forge:browser-engine:present', (event, input: Parameters<import('@forge/protocol').BrowserEngineDesktopBridge['present']>[0]) => {
    const window = browserRenderer(event)
    if (!input || typeof input.tabId !== 'string' || !input.bounds) throw new Error('Invalid browser presentation.')
    desktopBrowserHost.present(window, input)
  })
  ipcMain.handle('forge:browser-engine:hide', event => { browserRenderer(event); desktopBrowserHost.hide() })
  ipcMain.handle('bridge:showOpenDialog', async (_event, options: Electron.OpenDialogOptions) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      return dialog.showOpenDialog(mainWindow, options)
    }

    return dialog.showOpenDialog(options)
  })

  // No-op: overlay is not used on Windows (native title bar), but keep
  // the handler registered so the renderer doesn't throw on send.
  ipcMain.on('update-title-bar-overlay', () => {})

  ipcMain.handle('reveal-in-folder', (_event, filePath: string): { success: boolean; error?: string } => {
    const validated = validateAbsoluteLocalFilePath(filePath)
    if (!validated.ok) {
      return { success: false, error: validated.error }
    }

    shell.showItemInFolder(validated.path)
    return { success: true }
  })

  disposeOpenPdfIpc = installOpenPdfIpc({
    ipcMain,
    isTrustedSender: isTrustedMainRenderer,
    openPath: (target) => shell.openPath(target),
  })

  installOpenHtmlIpc({
    ipcMain,
    isTrustedSender: isTrustedMainRenderer,
    openPath: (target) => shell.openPath(target),
  })

  ipcMain.handle('check-for-updates', async () => {
    await checkForUpdatesManually(mainWindow)
  })

  ipcMain.handle('download-update', async () => {
    await downloadUpdateManually()
  })

  ipcMain.handle('install-update', () => {
    installUpdateManually()
  })

  ipcMain.handle('get-beta-channel', () => {
    return getBetaChannel()
  })

  ipcMain.handle('set-beta-channel', (_event, enabled: boolean) => {
    setBetaChannel(enabled)
  })

  ipcMain.handle('get-sleep-blocker-settings', () => {
    return sleepBlockerService?.getStatus() ?? getUnavailableSleepBlockerStatus()
  })

  ipcMain.handle('set-sleep-blocker-settings', (_event, patch: SleepBlockerSettingsPatch) => {
    return sleepBlockerService?.updateSettings(patch) ?? null
  })

  ipcMain.handle('install-cli', (): CliInstallResult => {
    return installCli()
  })

  ipcMain.handle('verify-cli-install', (): { ok: boolean; output: string } => {
    return verifyCliInstall()
  })

  installSecureVaultRendererIpc({
    ipcMain,
    controller: secureVaultController,
    isTrustedSender: isTrustedMainRenderer,
  })

  ipcMain.handle('get-stream-deck-plugin-status', () => getStreamDeckPluginStatus({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
  }))

  ipcMain.handle('install-stream-deck-plugin', async (): Promise<{ success: boolean; message: string }> => {
    const installerPath = resolveStreamDeckPluginPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    })
    if (!existsSync(installerPath)) {
      return { success: false, message: 'The bundled Stream Deck plugin installer is missing.' }
    }
    const error = await shell.openPath(installerPath)
    return error
      ? { success: false, message: error }
      : { success: true, message: 'Stream Deck opened the Forge plugin installer.' }
  })

  ipcMain.handle('open-stream-deck', async (): Promise<{ success: boolean; message: string }> => {
    const streamDeckAppPath = resolveStreamDeckAppPath(process.platform)
    if (!streamDeckAppPath) {
      return { success: false, message: 'Elgato Stream Deck is not installed.' }
    }
    const error = await shell.openPath(streamDeckAppPath)
    return error
      ? { success: false, message: error }
      : { success: true, message: 'Opened Elgato Stream Deck.' }
  })

  ipcMain.handle('focus-main-window', (): void => {
    focusMainWindow()
  })

  ipcMain.handle(POST_UPDATE_INFO_CHANNEL, (event) => {
    if (!isTrustedMainRenderer(event)) return null
    return consumePostUpdateInfo()
  })

  ipcMain.handle(OPEN_RELEASE_NOTES_CHANNEL, async (event) => {
    if (!isTrustedMainRenderer(event)) return
    await shell.openExternal(`https://github.com/a-mart/forge/releases/tag/v${app.getVersion()}`)
  })

  app.whenReady().then(async () => {
    protocol.handle(ENVIRONMENT_ARTIFACT_SCHEME, request => environmentCredentials.artifactProtocolResponse(request.url, request.headers.get('range') ?? undefined))
    lifecycleLog.record('electron_started', {
      isPackaged: app.isPackaged,
      version: app.getVersion(),
    })
    const secureVaultStartupInitialization =
      initializeSecureVaultAtStartup(secureVaultController)
    nativeTheme.themeSource = 'dark'
    fixPath()
    createApplicationMenu()
    registerExternalDeepLinkProtocol()
    if (app.isPackaged) {
      registerAppProtocol()
    }

    try {
      await backendSupervisor.start()
    } catch (error) {
      await backendSupervisor.stop().catch((stopError) => {
        console.warn('Failed to stop backend after startup failure', stopError)
      })
      lifecycleLog.record('electron_backend_start_failed')
      const detail = error instanceof Error ? error.message : String(error)
      const logPath = backendSupervisor.logPath
      const logHint = logPath ? `\n\nBackend log: ${logPath}` : ''
      dialog.showErrorBox(
        'Forge failed to start',
        'The backend process exited unexpectedly.\n\n' +
        'This might happen if another instance is running or if there\'s a configuration issue.\n\n' +
        `${detail}\n\n` +
        `Check the logs or try restarting the app.${logHint}`,
      )
      app.exit(1)
      return
    }

    await startOptionalPackagedRemoteUi(
      () => startPackagedRemoteUiServer(),
      (error) => {
        lifecycleLog.record('packaged_remote_ui_start_failed', { error: error.message })
        console.warn('[packaged-remote-ui] Remote browser access is unavailable; local Desktop and backend remain available.', error.message)
      },
    )

    await secureVaultStartupInitialization

    // Write CLI install hint on every launch so the shim can find the current app
    writeInstallHint()

    mainWindow = createMainWindow()
    const authoritativeWindow = mainWindow
    mainRendererRecovery = installMainRendererRecovery({
      window: authoritativeWindow,
      loadRenderer: () => reloadRenderer(authoritativeWindow),
      isClosing: () => appIsQuitting || mainWindowClosing,
      onEvent: (event) => {
        lifecycleLog.record(`electron_main_renderer_${event.type}`, event)
      },
    })
    initAutoUpdater({
      mainWindow,
      readActivity: () => readPrimaryEnvironmentActivity(environmentCredentials),
      prepareQuitForUpdate,
    })
    sleepBlockerService = new SleepBlockerService({
      readActivity: () => readPrimaryEnvironmentActivity(environmentCredentials),
      onStatusChange: (status) => {
        sendSleepBlockerStatusToWindow(mainWindow, status)
      },
    })
    sleepBlockerService.initialize()
    try {
      await loadRenderer(mainWindow)
    } catch (error) {
      if (!mainRendererRecovery.acceptsSupersededLoadError(error)) throw error
      lifecycleLog.record('electron_initial_renderer_load_superseded')
    }

  }).catch((error) => {
    lifecycleLog.record('electron_initialization_failed')
    void stopPackagedRemoteUiServer().catch((stopError) => {
      console.warn('[packaged-remote-ui] Failed to stop after initialization failure', stopError)
    })
    void backendSupervisor.stop().catch((stopError) => {
      console.warn('Failed to stop backend after initialization failure', stopError)
    })
    console.error('Electron app failed to initialize', error)
    app.exit(1)
  })

  app.on('window-all-closed', () => {
    lifecycleLog.record('electron_window_all_closed')
    app.quit()
  })

  app.on('before-quit', (event) => {
    lifecycleLog.record('electron_before_quit', { alreadyQuitting: appIsQuitting })
    if (appIsQuitting) {
      // A second quit (window close, signal, or launcher disconnect) must not
      // bypass pending cleanup. The updater may quit only after preparation.
      if (!appQuitCleanupComplete) event.preventDefault()
      return
    }

    event.preventDefault()
    appIsQuitting = true
    desktopBrowserHost.hide()
    sleepBlockerService?.dispose()
    mainRendererRecovery?.dispose()
    mainRendererRecovery = null
    disposeOpenPdfIpc?.()
    disposeOpenPdfIpc = null

    void managedHosts.dispose().catch((error) => {
      console.warn('[managed-hosts] Quit cleanup failed', error instanceof Error ? error.message : String(error))
    }).finally(() => stopPackagedRemoteUiServer()).finally(() => backendSupervisor.stop()).finally(() => {
      lifecycleLog.record('electron_exit_requested', { code: 0 })
      app.exit(0)
    })
  })

  app.on('will-quit', () => {
    lifecycleLog.record('electron_will_quit')
  })
}

function createMainWindow(): BrowserWindow {
  const savedState = loadWindowState()

  const window = new BrowserWindow({
    width: savedState.width,
    height: savedState.height,
    ...(savedState.x !== undefined && savedState.y !== undefined
      ? {
          x: savedState.x,
          y: savedState.y,
        }
      : {}),
    minWidth: 1100,
    minHeight: 720,
    show: false,
    ...(process.platform !== 'darwin' && {
      autoHideMenuBar: true,
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
    },
  })

  desktopBrowserHost.trackWindow(window)

  trackWindowState(window)

  window.once('ready-to-show', () => {
    if (savedState.isFullScreen) {
      window.setFullScreen(true)
    } else if (savedState.isMaximized) {
      window.maximize()
    }

    window.show()
  })

  window.on('close', () => {
    mainWindowClosing = true
    desktopBrowserHost.hide()
  })
  window.on('closed', () => {
    if (mainWindow === window) {
      mainRendererRecovery?.dispose()
      mainRendererRecovery = null
      mainWindow = null
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    return handleMainRendererWindowOpen(url, {
      openExternal: (target) => shell.openExternal(target),
      handleDeepLink: handlePotentialSkillImportDeepLink,
      onExternalOpenError: (target, error) => {
        console.error('Failed to open external URL', target, error)
      },
    })
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (handlePotentialSkillImportDeepLink(url)) {
      event.preventDefault()
      return
    }

    if (!isTrustedRendererUrl(url)) {
      event.preventDefault()
      if (!isUnsafeRendererWindowOpenUrl(url)) {
        void shell.openExternal(url)
      }
    }
  })

  // Native spell-check context menu with suggestions
  window.webContents.on('context-menu', (_event, params) => {
    console.log('[spell-check] context-menu event:', { misspelledWord: params.misspelledWord, suggestions: params.dictionarySuggestions, isEditable: params.isEditable })
    if (params.misspelledWord) {
      const menuItems: Electron.MenuItemConstructorOptions[] = [
        ...params.dictionarySuggestions.map((suggestion) => ({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        })),
        ...(params.dictionarySuggestions.length > 0 ? [{ type: 'separator' as const }] : []),
        {
          label: 'Add to Dictionary',
          click: () => window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        },
      ]
      Menu.buildFromTemplate(menuItems).popup()
    }
  })

  return window
}

function sendTerminalShortcut(action: 'toggle' | 'new' | 'next' | 'prev'): void {
  sendToRendererWindow(mainWindow, TERMINAL_SHORTCUT_CHANNEL, { action })
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }

  mainWindow.focus()
}

function openSkillImportUrl(skillImportUrl: string): void {
  pendingSkillImportUrl = skillImportUrl
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  focusMainWindow()
  pendingSkillImportUrl = null
  void mainWindow.loadURL(resolveRendererUrl(skillImportUrl))
}

function openCommandCenterDeepLink(deepLink: string): void {
  pendingCommandCenterDeepLink = deepLink
  if (!mainWindow || mainWindow.isDestroyed()) return
  focusMainWindow()
  pendingCommandCenterDeepLink = null
  const baseUrl = app.isPackaged ? resolvePackagedRendererUrl() : electronDevServerUrl
  void mainWindow.loadURL(buildCommandCenterRouteUrl(baseUrl, deepLink))
}

function handlePotentialSkillImportDeepLink(url: string): boolean {
  const skillImportUrl = parseSkillImportDeepLink(url)
  if (!skillImportUrl) {
    return false
  }

  openSkillImportUrl(skillImportUrl)
  return true
}

function registerExternalDeepLinkProtocol(): void {
  if (!shouldRegisterExternalDeepLinkProtocol({ isPackaged: app.isPackaged, env: process.env })) {
    return
  }

  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(EXTERNAL_PROTOCOL_SCHEME)
    return
  }

  app.setAsDefaultProtocolClient(EXTERNAL_PROTOCOL_SCHEME, process.execPath, [process.argv[1] ?? ''])
}

function createApplicationMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: Array<Electron.MenuItemConstructorOptions> = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        {
          label: 'About Forge',
          click: (): void => {
            if (!mainWindow) {
              return
            }
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Forge',
              message: 'Forge',
              detail: `Version: ${app.getVersion()}\nElectron: ${process.versions.electron}\nChromium: ${process.versions.chrome}\nNode.js: ${process.versions.node}\nPlatform: ${process.platform} ${process.arch}`,
            }).catch((error) => {
              console.error('Failed to show About dialog', error)
            })
          },
        },
        { type: 'separator' },
        {
          label: 'Check for Updates...',
          click: (): void => {
            void checkForUpdatesManually()
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', accelerator: 'Command+H' },
        { role: 'hideOthers', accelerator: 'Alt+Command+H' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', accelerator: 'Command+Q' },
      ],
    })
  } else {
    template.push({
      label: 'File',
      submenu: [
        {
          label: 'Check for Updates...',
          click: (): void => {
            void checkForUpdatesManually()
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo', accelerator: 'CmdOrCtrl+Z' },
      { role: 'redo', accelerator: isMac ? 'Shift+CmdOrCtrl+Z' : 'Ctrl+Y' },
      { type: 'separator' },
      { role: 'cut', accelerator: 'CmdOrCtrl+X' },
      { role: 'copy', accelerator: 'CmdOrCtrl+C' },
      { role: 'paste', accelerator: 'CmdOrCtrl+V' },
      ...(isMac ? [
        { role: 'pasteAndMatchStyle' as const, accelerator: 'Shift+Alt+CmdOrCtrl+V' },
        { role: 'delete' as const },
        { role: 'selectAll' as const, accelerator: 'CmdOrCtrl+A' },
      ] : [
        { role: 'delete' as const },
        { type: 'separator' as const },
        { role: 'selectAll' as const, accelerator: 'CmdOrCtrl+A' },
      ]),
    ],
  })

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload', accelerator: 'CmdOrCtrl+R' },
      { role: 'forceReload', accelerator: 'Shift+CmdOrCtrl+R' },
      { role: 'toggleDevTools', accelerator: isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I' },
      { type: 'separator' as const },
      { role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
      { role: 'zoomIn', accelerator: 'CmdOrCtrl+Plus' },
      { role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
      { type: 'separator' as const },
      { role: 'togglefullscreen', accelerator: isMac ? 'Ctrl+Command+F' : 'F11' },
    ],
  })

  template.push({
    label: 'Terminal',
    submenu: [
      {
        label: 'Toggle Terminal Panel',
        accelerator: 'CmdOrCtrl+`',
        click: (): void => sendTerminalShortcut('toggle'),
      },
      {
        label: 'New Terminal',
        accelerator: 'CmdOrCtrl+Shift+`',
        click: (): void => sendTerminalShortcut('new'),
      },
      { type: 'separator' as const },
      {
        label: 'Previous Terminal',
        accelerator: 'Alt+Shift+[',
        click: (): void => sendTerminalShortcut('prev'),
      },
      {
        label: 'Next Terminal',
        accelerator: 'Alt+Shift+]',
        click: (): void => sendTerminalShortcut('next'),
      },
    ],
  })

  template.push({
    label: 'Window',
    submenu: [
      { role: 'minimize', ...(isMac ? { accelerator: 'CmdOrCtrl+M' } : {}) },
      { role: 'zoom' },
      ...(isMac ? [
        { type: 'separator' as const },
        { role: 'front' as const },
      ] : [
        { role: 'close' as const, accelerator: 'Alt+F4' },
      ]),
    ],
  })

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  const skillImportUrl = pendingSkillImportUrl
  const commandCenterDeepLink = pendingCommandCenterDeepLink
  pendingSkillImportUrl = null
  pendingCommandCenterDeepLink = null
  const base = resolveRendererUrl(skillImportUrl ?? undefined)
  await window.loadURL(commandCenterDeepLink ? buildCommandCenterRouteUrl(base, commandCenterDeepLink) : base)
}

async function reloadRenderer(window: BrowserWindow): Promise<void> {
  const currentUrl = window.webContents.isDestroyed() ? '' : window.webContents.getURL()
  await window.loadURL(isTrustedRendererUrl(currentUrl) ? currentUrl : resolveRendererUrl())
}

function resolveRendererUrl(skillImportUrl?: string): string {
  const baseUrl = app.isPackaged ? resolvePackagedRendererUrl() : electronDevServerUrl
  return skillImportUrl ? buildSkillImportRouteUrl(baseUrl, skillImportUrl) : baseUrl
}

function isTrustedRendererUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }

  if (app.isPackaged) {
    return url.protocol === `${APP_PROTOCOL_SCHEME}:` && url.hostname === APP_PROTOCOL_HOST
  }

  return url.origin === new URL(electronDevServerUrl).origin
}

function isTrustedMainRenderer(event: unknown): boolean {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    typeof event !== 'object' ||
    event === null ||
    !('sender' in event)
  ) {
    return false
  }

  const sender = (event as { sender?: unknown }).sender
  if (sender !== mainWindow.webContents || mainWindow.webContents.isDestroyed()) {
    return false
  }

  return isTrustedRendererUrl(mainWindow.webContents.getURL())
}

function buildBackendBootstrap(
  port: number,
  dataDir: string | undefined,
  secureControlToken: string,
  publicBaseUrl = `http://127.0.0.1:${port}`,
): BackendBootstrap {
  return {
    backendUrl: publicBaseUrl,
    loopbackUrl: `http://127.0.0.1:${port}`,
    backendWsUrl: publicBaseUrl.replace(/^http/, 'ws'),
    version: app.getVersion(),
    platform: process.platform,
    appRuntime: app.isPackaged ? 'installed' : 'development',
    appStartedAt: ELECTRON_STARTED_AT,
    windowRole: 'main',
    secureControlToken,
    ...(dataDir ? { dataDir } : {}),
  }
}

function resolveRepoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..')
}

function resolveBackendRuntimeRoot(): string {
  if (!app.isPackaged) {
    return resolveRepoRoot()
  }

  return resolveBackendResourcesDir()
}

function resolveBackendResourcesDir(): string {
  if (!app.isPackaged) {
    return resolveRepoRoot()
  }

  const resourcesDir = path.join(process.resourcesPath, PACKAGED_RESOURCES_DIRNAME)
  assertPathExists(resourcesDir, 'Packaged backend resources directory')
  return resourcesDir
}

function resolvePackagedRendererDir(): string {
  const rendererDir = path.join(process.resourcesPath, PACKAGED_RENDERER_DIRNAME)
  assertPathExists(rendererDir, 'Packaged renderer directory')
  return rendererDir
}

function resolvePackagedRendererEntry(): string {
  const rendererEntry = path.join(resolvePackagedRendererDir(), 'index.html')
  assertPathExists(rendererEntry, 'Packaged renderer entry')
  return rendererEntry
}

function resolvePackagedRendererUrl(): string {
  return `${APP_PROTOCOL_SCHEME}://${APP_PROTOCOL_HOST}/index.html`
}

function resolveBackendEntry(): string {
  if (app.isPackaged) {
    const packagedBackendEntry = path.join(process.resourcesPath, PACKAGED_BACKEND_DIRNAME, 'dist', 'index.mjs')
    assertPathExists(packagedBackendEntry, 'Packaged backend entry')
    return packagedBackendEntry
  }

  const repoRoot = resolveRepoRoot()
  const backendDistEntry = path.join(repoRoot, 'apps', 'backend', 'dist', 'index.js')
  const backendSourceEntry = path.join(repoRoot, 'apps', 'backend', 'src', 'index.ts')

  if (existsSync(backendSourceEntry)) {
    return backendSourceEntry
  }

  if (existsSync(backendDistEntry)) {
    return backendDistEntry
  }

  throw new Error(`Unable to find backend entrypoint. Checked:\n- ${backendDistEntry}\n- ${backendSourceEntry}`)
}

function resolveBackendExecArgv(backendEntry: string): string[] {
  if (backendEntry.endsWith('.ts')) {
    // On Windows, --import requires a file:// URL — raw drive-letter paths
    // like T:\...\tsx are misinterpreted as URL schemes (protocol 't:').
    const tsxPath = require.resolve('tsx')
    const tsxUrl = pathToFileURL(tsxPath).href
    return [...process.execArgv, '--import', tsxUrl]
  }

  return [...process.execArgv]
}

function registerAppProtocol(): void {
  if (appProtocolRegistered) {
    return
  }

  const rendererDir = resolvePackagedRendererDir()
  const rendererEntry = resolvePackagedRendererEntry()

  protocol.handle(APP_PROTOCOL_SCHEME, (request) => {
    const requestUrl = new URL(request.url)
    const requestedPath = decodeURIComponent(requestUrl.pathname.replace(/^\/+/, ''))
    const normalizedRelativePath = requestedPath.length > 0 ? path.normalize(requestedPath) : 'index.html'
    const candidatePath = path.resolve(rendererDir, normalizedRelativePath)
    const shouldServeRequestedFile =
      candidatePath.startsWith(rendererDir) &&
      existsSync(candidatePath) &&
      path.extname(candidatePath).length > 0

    const filePath = shouldServeRequestedFile ? candidatePath : rendererEntry
    return net.fetch(pathToFileURL(filePath).toString())
  })

  appProtocolRegistered = true
}

function assertPathExists(targetPath: string, label: string): void {
  if (!existsSync(targetPath)) {
    throw new Error(`${label} was not found at ${targetPath}`)
  }
}

/**
 * Pick the default backend port. Uses the standard Forge convention
 * (47187 dev, 47287 prod) so mobile apps and other clients can connect
 * on a known port without any configuration.
 *
 * The backend's own listen logic handles EADDRINUSE — if the preferred port
 * is occupied, startup will fail and the error dialog will show. This is
 * intentional: silently falling back to a random port would break mobile
 * connectivity, so it's better to tell the user another instance is running.
 */
function resolveDefaultBackendPort(): number {
  return DEFAULT_BACKEND_PORT
}

function isBackendReadyMessage(value: unknown): value is BackendReadyMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'ready' &&
    typeof (value as { port?: unknown }).port === 'number'
  )
}

/**
 * Minimal .env loader for the Electron main process. Reads the .env file
 * from the repo root (dev) and sets any vars not already in process.env.
 * No dependency on dotenv — the backend loads its own copy via dotenv later.
 */
function loadDotEnv(): void {
  try {
    const repoRoot = path.resolve(__dirname, '..', '..', '..')
    const envPath = path.join(repoRoot, '.env')
    if (!existsSync(envPath)) return

    const content = readFileSync(envPath, 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIndex = trimmed.indexOf('=')
      if (eqIndex < 1) continue
      const key = trimmed.slice(0, eqIndex).trim()
      const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '')
      // Don't override existing env vars
      if (!(key in process.env)) {
        process.env[key] = value
      }
    }
  } catch {
    // Non-critical — continue without .env
  }
}
