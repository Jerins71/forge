import type { EnvironmentDescriptor } from "@forge/protocol/environment-v2";
import { validateSecureBuilderControlCapability, validateSecureBuilderControlOrigin } from "./terminal/terminal-access-policy.js";
import { createEnvironmentService, type EnvironmentService } from "./environment/environment-service.js";
import { createExposurePolicy, enableTailscaleServe } from "./environment/exposure-policy.js";
import { getEnvironmentDbPath } from "./swarm/storage/data-paths.js";
import { dirname, join } from "node:path";
import { createConfig, readEnvironmentExposure } from "./config.js";
import { StatsService } from "./stats/stats-service.js";
import { collectFeatureAdoption } from "./telemetry/feature-counters.js";
import {
  assembleFullPayload,
  extractAuthMethodsConfigured,
  extractProvidersUsed
} from "./telemetry/telemetry-payload.js";
import { TelemetryService } from "./telemetry/telemetry-service.js";
import { ObservabilityService } from "./observability/observability-service.js";
import type { ObservabilityFacade } from "./observability/observability-types.js";
import { CronSchedulerService } from "./scheduler/cron-scheduler-service.js";
import { getScheduleFilePath } from "./scheduler/schedule-storage.js";
import { acquireRuntimeLock } from "./runtime-lock.js";
import { FeedbackService } from "./swarm/feedback-service.js";
import { SwarmManager } from "./swarm/swarm-manager.js";
import { BrowserAutomationService } from "./swarm/browser-automation/index.js";
import { seedBuiltins } from "./swarm/agents/specialists/specialist-registry.js";
import { UnreadTracker } from "./swarm/session/unread-tracker.js";
import type { AgentDescriptor, SessionLifecycleEvent, SwarmConfig } from "./swarm/types.js";
import { readTerminalRuntimeConfig } from "./terminal/terminal-config.js";
import { TerminalPersistence } from "./terminal/terminal-persistence.js";
import { NodePtyRuntime } from "./terminal/terminal-pty-runtime.js";
import { TerminalSettingsService } from "./terminal/terminal-settings-service.js";
import type { ResolvedTerminalSession, TerminalSessionResolver } from "./terminal/terminal-session-resolver.js";
import { TerminalService } from "./terminal/terminal-service.js";
import { SwarmWebSocketServer } from "./ws/server.js";

export interface ServerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ServerReadyInfo {
  host: string;
  port: number;
  config: SwarmConfig;
  environment: EnvironmentDescriptor;
}

export interface StartServerOptions {
  config?: SwarmConfig;
  logger?: Partial<ServerLogger>;
  onReady?: (info: ServerReadyInfo) => Promise<void> | void;
  secureControlToken?: string;
  environmentIdentity?: Pick<import("./environment/identity.js").IdentityOptions, "installationStateDir" | "label" | "capabilities">;
}

export interface StartedServer extends ServerReadyInfo {
  stop(): Promise<void>;
  createBootstrapGrant(): ReturnType<EnvironmentService["access"]["createBootstrapGrant"]>;
  /** Test hook for the route-inventory classification gate. */
  listRegisteredHttpRoutes(): ReadonlyArray<{ methods: string; matches: (pathname: string) => boolean }>;
}

let activeServer: BackendServer | null = null;

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  if (activeServer) {
    throw new Error("Server already started");
  }

  const config = options.config ?? createConfig();
  const logger = createLogger(options.logger);
  const exposureOptions = readEnvironmentExposure(config);
  const exposure = createExposurePolicy(exposureOptions);

  const runtimeLock = acquireRuntimeLock(config.paths.dataDir);
  const observabilityService: ObservabilityFacade = new ObservabilityService({ dataDir: config.paths.dataDir });

  // Signal-driven shutdown is owned by index.ts so the lock remains held until
  // graceful shutdown completes. This hook is only a final best-effort fallback
  // for process exits that bypass that lifecycle.
  let runtimeLockReleased = false;
  const emergencyRelease = () => {
    if (runtimeLockReleased) return;
    try { runtimeLock.release(); } catch { /* best effort */ }
  };
  process.once("exit", emergencyRelease);
  const releaseRuntimeLock = () => {
    if (runtimeLockReleased) return;
    runtimeLock.release();
    runtimeLockReleased = true;
    process.removeListener("exit", emergencyRelease);
  };

  let swarmManager: SwarmManager | undefined;
  let wsServer: SwarmWebSocketServer | undefined;
  let environment: EnvironmentService | undefined;
  const browserAutomationService = new BrowserAutomationService({
    dataDir: config.paths.dataDir,
    onSessionChanged: (snapshot, reason) => wsServer?.broadcastBrowserSessionChanged(snapshot, reason),
    onHostChanged: (host) => wsServer?.broadcastBrowserHostChanged(host),
  });

  try {
    await seedBuiltins(config.paths.dataDir);

    await observabilityService.initialize();

    swarmManager = new SwarmManager(config, {
      observability: observabilityService,
      browserAutomationService,
    });
  } catch (error) {
    await Promise.allSettled([
      swarmManager?.closeSecureSessions(),
      observabilityService.shutdown({ timeoutMs: 3000 }),
    ]);
    releaseRuntimeLock();
    throw error;
  }

  const schedulersByProfileId = new Map<string, CronSchedulerService>();
  let schedulerLifecycle: Promise<void> = Promise.resolve();

  const syncSchedulers = async (profileIds: Set<string>): Promise<void> => {
    for (const profileId of profileIds) {
      if (schedulersByProfileId.has(profileId)) {
        continue;
      }

      const scheduler = new CronSchedulerService({
        swarmManager,
        schedulesFile: getScheduleFilePath(config.paths.dataDir, profileId),
        managerId: profileId,
      });
      await scheduler.start();
      schedulersByProfileId.set(profileId, scheduler);
    }

    for (const [profileId, scheduler] of schedulersByProfileId.entries()) {
      if (profileIds.has(profileId)) {
        continue;
      }

      await scheduler.stop();
      schedulersByProfileId.delete(profileId);
    }
  };

  const queueSchedulerSync = (profileIds: Set<string>): Promise<void> => {
    const next = schedulerLifecycle.then(
      () => syncSchedulers(profileIds),
      () => syncSchedulers(profileIds),
    );
    schedulerLifecycle = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const handleAgentsSnapshot = (event: unknown): void => {
    if (!event || typeof event !== "object") {
      return;
    }

    const payload = event as { type?: string; agents?: unknown };
    if (payload.type !== "agents_snapshot" || !Array.isArray(payload.agents)) {
      return;
    }

    const profileIds = collectSchedulerProfileIds(payload.agents, config.managerId);
    void queueSchedulerSync(profileIds).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[scheduler] Failed to sync scheduler instances: ${message}`);
    });
  };

  let terminalService: TerminalService | null = null;
  const terminalSettingsService = new TerminalSettingsService({ dataDir: config.paths.dataDir });
  let handleTerminalSessionLifecycle: (event: SessionLifecycleEvent) => void = () => undefined;
  let handleTerminalAgentsSnapshot: () => void = () => undefined;
  let server: BackendServer | null = null;

  try {
    const unreadTracker = new UnreadTracker({
      dataDir: config.paths.dataDir,
      getProfileIds: () => swarmManager.listProfiles().map((profile) => profile.profileId),
      getSessionAgentIds: (profileId) =>
        swarmManager
          .listAgents()
          .filter(
            (descriptor) =>
              descriptor.role === "manager" &&
              (descriptor.profileId ?? descriptor.agentId) === profileId,
          )
          .map((descriptor) => descriptor.agentId),
    });
    environment = await createEnvironmentService({ config, swarmManager, unreadTracker, exposure, identityOptions: options.environmentIdentity,
      localBrowserOrigin: request => {
        const address = request.socket.localAddress;
        const peer = request.socket.remoteAddress?.replace(/^::ffff:/, '');
        if (!config.isDesktop || !address || !peer || !['127.0.0.1', '::1'].includes(peer)) return false;
        return validateSecureBuilderControlCapability(request, options.secureControlToken)
          && validateSecureBuilderControlOrigin(request, { backendHost: request.headers.host?.split(":")[0] ?? "127.0.0.1", backendPort: request.socket.localPort ?? config.port }).ok;
      } });
    await swarmManager.boot();
    await environment.initialize();

    let telemetryService: TelemetryService | null = null;
    const statsService = new StatsService(swarmManager, {
      onRefreshAllCompleted: (allStats) => {
        void telemetryService?.sendOnStatsRefresh(allStats);
      },
    });
    telemetryService = new TelemetryService({
      dataDir: config.paths.dataDir,
      debug: config.debug,
      assemblePayload: async (installId, context) => {
        const stats = context.stats ?? (await statsService.getSnapshot("all"));
        const profileIds = swarmManager.listProfiles().map((profile) => profile.profileId);
        const features = await collectFeatureAdoption(config.paths.dataDir, profileIds, config);
        const authMethods = await extractAuthMethodsConfigured(config);
        return assembleFullPayload(
          installId,
          context.reportId,
          stats,
          features,
          extractProvidersUsed(stats),
          authMethods,
        );
      },
    });



    await queueSchedulerSync(collectSchedulerProfileIds(swarmManager.listAgents(), config.managerId));
    swarmManager.on("agents_snapshot", handleAgentsSnapshot);

    await terminalSettingsService.load();
    const terminalRuntimeConfig = await readTerminalRuntimeConfig({
      persistedSettings: terminalSettingsService.getPersistedSettings(),
    });
    const terminalSessionResolver: TerminalSessionResolver = {
      resolveSession: (sessionAgentId) => {
        const descriptor = swarmManager.getAgent(sessionAgentId);
        if (descriptor?.role === "manager") {
          const profileId = descriptor.profileId ?? descriptor.agentId;
          const profile = swarmManager.listProfiles().find((entry) => entry.profileId === profileId);
          const profileArchived = Boolean(profile?.archivedAt);
          return {
            sessionAgentId: profileId,
            profileId,
            cwd: descriptor.cwd,
            archived: swarmManager.isAgentEffectivelyArchived(descriptor.agentId),
            terminalScopeArchived: profileArchived,
          };
        }

        const profile = swarmManager.listProfiles().find((entry) => entry.profileId === sessionAgentId);
        if (!profile) {
          return undefined;
        }

        const profileSession = swarmManager
          .listAgents()
          .find((entry) => entry.role === "manager" && (entry.profileId ?? entry.agentId) === profile.profileId);

        return {
          sessionAgentId: profile.profileId,
          profileId: profile.profileId,
          cwd: profileSession?.cwd ?? config.defaultCwd,
          archived: Boolean(profile.archivedAt),
          terminalScopeArchived: Boolean(profile.archivedAt),
          storageScopeOnly: true,
        };
      },
      listSessions: () => {
        const scopes = new Map<string, ResolvedTerminalSession>();
        for (const descriptor of swarmManager.listAgents()) {
          if (descriptor.role !== "manager") {
            continue;
          }

          const scopeAgentId = descriptor.profileId ?? descriptor.agentId;
          if (!scopes.has(scopeAgentId)) {
            scopes.set(scopeAgentId, {
              sessionAgentId: scopeAgentId,
              profileId: descriptor.profileId ?? descriptor.agentId,
              cwd: descriptor.cwd,
              archived: swarmManager.isAgentEffectivelyArchived(descriptor.agentId),
              terminalScopeArchived: Boolean(
                swarmManager.listProfiles().find((entry) => entry.profileId === scopeAgentId)?.archivedAt,
              ),
            });
          }
        }

        return Array.from(scopes.values());
      },
    };
    const terminalPersistence = new TerminalPersistence({
      dataDir: config.paths.dataDir,
      scrollbackLines: terminalRuntimeConfig.scrollbackLines,
      journalMaxBytes: terminalRuntimeConfig.journalMaxBytes,
    });
    const terminalPtyRuntime = new NodePtyRuntime({
      outputBatchIntervalMs: terminalRuntimeConfig.outputBatchIntervalMs,
      defaultShell: terminalRuntimeConfig.defaultShell,
      getDefaultShell: () => terminalSettingsService.getSettings().defaultShell ?? undefined,
    });
    terminalService = new TerminalService({
      dataDir: config.paths.dataDir,
      runtimeConfig: terminalRuntimeConfig,
      sessionResolver: terminalSessionResolver,
      ptyRuntime: terminalPtyRuntime,
      persistence: terminalPersistence,
      cwdPolicy: {
        rootDir: config.paths.rootDir,
        allowlistRoots: config.cwdAllowlistRoots,
        enforceAllowlist: false,
      },
    });
    swarmManager.setTerminalArchiveHooks({
      suspendProfileTerminals: (profileId) => terminalService?.suspendSessionPreserving(profileId) ?? Promise.resolve(0),
      restoreProfileTerminals: (profileId) => terminalService?.restorePersistedSession(profileId) ?? Promise.resolve(0),
    });
    handleTerminalSessionLifecycle = (event: SessionLifecycleEvent): void => {
      if (event.action !== "deleted") {
        return;
      }

      void terminalService?.cleanupSession(event.sessionAgentId, "session_deleted").catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[terminal] Failed to cleanup deleted session terminals: ${message}`);
      });
    };
    handleTerminalAgentsSnapshot = (): void => {
      void terminalService?.reconcileSessions().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[terminal] Failed to reconcile session terminals: ${message}`);
      });
    };
    swarmManager.on("session_lifecycle", handleTerminalSessionLifecycle);
    swarmManager.on("agents_snapshot", handleTerminalAgentsSnapshot);
    try {
      const terminalInit = await terminalService.initialize();
      logger.info(
        `[terminal] initialized restoredRunning=${terminalInit.restoredRunning} restoredExited=${terminalInit.restoredExited} restoreFailed=${terminalInit.restoreFailed} cleanedOrphans=${terminalInit.cleanedOrphans} skipped=${terminalInit.skipped}`,
      );
    } catch (error) {
      swarmManager.off("session_lifecycle", handleTerminalSessionLifecycle);
      swarmManager.off("agents_snapshot", handleTerminalAgentsSnapshot);
      throw error;
    }

    const feedbackService = new FeedbackService(config.paths.dataDir, { observability: observabilityService });

    wsServer = new SwarmWebSocketServer({
      swarmManager,
      environment,
      tls: exposureOptions.tlsCert && exposureOptions.tlsKey ? { cert: exposureOptions.tlsCert, key: exposureOptions.tlsKey } : undefined,
      host: config.host,
      port: config.port,
      terminalService,
      terminalRuntimeConfig,
      terminalSettingsService,
      promptRegistry: swarmManager.promptRegistry,
      unreadTracker,
      statsService,
      telemetryService,
      observabilityService,
      feedbackService,
      browserAutomationService,
      secureControlToken: options.secureControlToken,
    });

    await wsServer.start();
    exposure.setLoopbackPort(wsServer.getPort());
    if (process.env.FORGE_TAILSCALE_SERVE === "1") {
      await enableTailscaleServe({ backendPort: wsServer.getPort(), publicBaseUrl: exposure.publicBaseUrl,
        ownershipFile: join(dirname(getEnvironmentDbPath(config.paths.dataDir)), "tailscale-serve.json"), environmentId: environment.descriptor().environmentId });
    }
    server = new BackendServer({
      config,
      environment,
      port: wsServer.getPort(),
      swarmManager,
      observabilityService,
      wsServer,
      queueSchedulerSync,
      handleAgentsSnapshot,
      terminalService,
      handleTerminalSessionLifecycle,
      handleTerminalAgentsSnapshot,
      releaseRuntimeLock,
    });

    activeServer = server;
    await options.onReady?.({
      host: server.host,
      port: server.port,
      config,
      environment: environment.descriptor(),
    });
    environment.start();
    return server;
  } catch (error) {
    if (server) {
      await server.stop();
    } else {
      swarmManager?.off("agents_snapshot", handleAgentsSnapshot);
      if (terminalService) {
        swarmManager?.off("session_lifecycle", handleTerminalSessionLifecycle);
        swarmManager?.off("agents_snapshot", handleTerminalAgentsSnapshot);
      }
      await environment?.stop();
      await Promise.allSettled([
        wsServer?.stop(),
        queueSchedulerSync(new Set<string>()),
        swarmManager?.closeSecureSessions(),
        terminalService?.shutdown(),
        observabilityService.shutdown({ timeoutMs: 3000 }),
      ]);
      releaseRuntimeLock();
    }
    throw error;
  }
}

class BackendServer implements StartedServer {
  readonly host: string;
  port: number;
  readonly config: SwarmConfig;
  readonly environment: EnvironmentDescriptor;
  private readonly environmentService: EnvironmentService;

  private readonly swarmManager: SwarmManager;
  private readonly observabilityService: ObservabilityFacade;
  private readonly wsServer: SwarmWebSocketServer;
  private readonly queueSchedulerSync: (profileIds: Set<string>) => Promise<void>;
  private readonly handleAgentsSnapshot: (event: unknown) => void;
  private readonly terminalService: TerminalService | null;
  private readonly handleTerminalSessionLifecycle: (event: SessionLifecycleEvent) => void;
  private readonly handleTerminalAgentsSnapshot: () => void;
  private readonly releaseRuntimeLock: () => void;

  private stopped = false;

  constructor(options: {
    config: SwarmConfig;
    environment: EnvironmentService;
    port: number;
    swarmManager: SwarmManager;
    observabilityService: ObservabilityFacade;
    wsServer: SwarmWebSocketServer;
    queueSchedulerSync: (profileIds: Set<string>) => Promise<void>;
    handleAgentsSnapshot: (event: unknown) => void;
    terminalService: TerminalService | null;
    handleTerminalSessionLifecycle: (event: SessionLifecycleEvent) => void;
    handleTerminalAgentsSnapshot: () => void;
    releaseRuntimeLock: () => void;
  }) {
    this.host = options.config.host;
    this.port = options.port;
    this.config = options.config;
    this.environmentService = options.environment;
    this.environment = options.environment.descriptor();
    this.swarmManager = options.swarmManager;
    this.observabilityService = options.observabilityService;
    this.wsServer = options.wsServer;
    this.queueSchedulerSync = options.queueSchedulerSync;
    this.handleAgentsSnapshot = options.handleAgentsSnapshot;
    this.terminalService = options.terminalService;
    this.handleTerminalSessionLifecycle = options.handleTerminalSessionLifecycle;
    this.handleTerminalAgentsSnapshot = options.handleTerminalAgentsSnapshot;
    this.releaseRuntimeLock = options.releaseRuntimeLock;
  }

  createBootstrapGrant(): ReturnType<EnvironmentService["access"]["createBootstrapGrant"]> {
    return this.environmentService.access.createBootstrapGrant({ reachableBaseUrl: this.environmentService.exposure.publicBaseUrl });
  }

  listRegisteredHttpRoutes(): ReadonlyArray<{ methods: string; matches: (pathname: string) => boolean }> {
    return this.wsServer.listRegisteredHttpRoutes();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.swarmManager.off("agents_snapshot", this.handleAgentsSnapshot);
    this.swarmManager.off("session_lifecycle", this.handleTerminalSessionLifecycle);
    this.swarmManager.off("agents_snapshot", this.handleTerminalAgentsSnapshot);

    try {
      await this.wsServer.stop();
      await this.environmentService.stop();
    } finally {
      await Promise.allSettled([
        this.queueSchedulerSync(new Set<string>()),
        this.swarmManager.closeSecureSessions(),
        this.swarmManager.disposeHistoryRecall(),
        this.terminalService?.shutdown(),
        this.observabilityService.shutdown({ timeoutMs: 3000 }),
      ]);

      try {
        this.releaseRuntimeLock();
      } finally {
        if (activeServer === this) {
          activeServer = null;
        }
      }
    }
  }
}

function createLogger(logger: Partial<ServerLogger> | undefined): ServerLogger {
  return {
    info: logger?.info ?? ((message: string) => console.log(message)),
    warn: logger?.warn ?? ((message: string) => console.warn(message)),
    error: logger?.error ?? ((message: string) => console.error(message)),
  };
}

/**
 * Collect unique profile IDs from manager agents for scheduler instantiation.
 * Schedules are profile-scoped, so we create one scheduler per profile, not per session.
 */
function collectSchedulerProfileIds(agents: unknown[], fallbackManagerId?: string): Set<string> {
  const profileIds = new Set<string>();

  for (const agent of agents) {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
      continue;
    }

    const descriptor = agent as Partial<AgentDescriptor>;
    if (descriptor.role !== "manager") {
      continue;
    }

    if (typeof descriptor.agentId !== "string" || descriptor.agentId.trim().length === 0) {
      continue;
    }

    const id = (typeof descriptor.profileId === "string" && descriptor.profileId.trim().length > 0)
      ? descriptor.profileId.trim()
      : descriptor.agentId.trim();
    profileIds.add(id);
  }

  const normalizedFallbackManagerId =
    typeof fallbackManagerId === "string" ? fallbackManagerId.trim() : "";
  if (profileIds.size === 0 && normalizedFallbackManagerId.length > 0) {
    profileIds.add(normalizedFallbackManagerId);
  }

  return profileIds;
}
