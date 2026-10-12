import { ClaudeAuthService } from "../swarm/runtime/claude/claude-auth-service.js";
import { createClaudeAuthRoutes } from "./http/routes/claude-auth-routes.js";
import { RepositoryCheckoutService } from "../swarm/repository-checkout-service.js";
import { createRepositoryCheckoutRoutes } from "./http/routes/repository-checkout-routes.js";
import { createCodexAuthRoutes } from "./http/routes/codex-auth-routes.js";
import { CodexAuthService } from "../swarm/runtime/codex/codex-auth-service.js";
import { createNativeRuntimeRoutes } from "./http/routes/native-runtime-routes.js";
import { NativeRuntimeUpdateService } from "../swarm/runtime/runtime-updates/native-runtime-update-service.js";
import { createProjectSecureSessionsRoutes } from "./http/routes/project-secure-sessions-routes.js";
import { createHash } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import type { Principal } from "../environment/control/control-types.js";
import type { EnvironmentService } from "../environment/environment-service.js";
import { AccessError } from "../environment/access/access-service.js";
import { createEnvironmentHttpPolicy, createRouteInventory } from "../environment/access/http-policy.js";
import { bindHttpPrincipal, requireHttpPrincipal } from "./rpc/http-principal.js";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
  isRetiredMessageSource,
  isTerminalAssistantConversationMessage,
  type BrowserHostConnectionSnapshot,
  type BrowserSessionSnapshot,
  type ServerEvent,
  type TerminalClosedEvent,
  type TerminalCreatedEvent,
  type TerminalUpdatedEvent,
} from "@forge/protocol";

import { MobilePushService } from "../mobile/mobile-push-service.js";

import {
  getControlPidFilePath,
  readControlPidFromFile,
  readDaemonizedEnv
} from "../reboot/control-pid.js";
import { BuilderSidebarOrderService } from "../swarm/builder-sidebar-order-service.js";
import { CompactionSettingsService } from "../swarm/compaction-settings-service.js";
import { SecureSecretSettingsService } from "../swarm/secure-sessions/secure-secret-settings-service.js";
import { CliAccessService, readCliApiKeyEnv } from "../swarm/cli-access-service.js";
import { StreamDeckAccessService } from "../swarm/stream-deck-access-service.js";
import { SecureBrowserAccessService } from "../swarm/secure-browser-access-service.js";
import {
  NotificationSettingsService,
} from "../swarm/notification-settings-service.js";
import { isPidAlive } from "../swarm/platform.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import type { BrowserAutomationService } from "../swarm/browser-automation/index.js";
import { UnreadTracker } from "../swarm/session/unread-tracker.js";
import { createNoopObservabilityFacade } from "../observability/noop-observability.js";
import type { ObservabilityFacade } from "../observability/observability-types.js";
import { FeedbackService } from "../swarm/feedback-service.js";
import { PresentedChatArtifactTicketStore } from "../swarm/session/presented-chat-artifact.js";
import { HtmlArtifactPreviewStore } from "../swarm/session/html-artifact-preview.js";
import {
  validateSecureBuilderControlOrigin,
  validateSecureBuilderControlCapability,
} from "../terminal/terminal-access-policy.js";

import {
  authenticateCliHttpRequest,
} from "./cli-auth.js";
import { applyCorsHeaders, resolveRequestUrl, sendJson } from "./http-utils.js";
import { createAgentHttpRoutes } from "./http/routes/agent-http-routes.js";
import { createBuilderSidebarOrderRoutes } from "./http/routes/builder-sidebar-order-routes.js";
import { createChatArtifactRoutes } from "./http/routes/chat-artifact-routes.js";
import { createArtifactPreviewRoutes } from "./http/routes/artifact-preview-routes.js";
import { createCodexCatalogRoutes } from "./http/routes/codex-catalog-routes.js";
import { createCliAccessSettingsRoutes } from "./http/routes/cli-access-settings-routes.js";
import { createCliRoutes } from "./http/routes/cli-routes.js";
import { createStreamDeckRoutes } from "./http/routes/stream-deck-routes.js";
import { createStreamDeckPairingRoutes } from "./http/routes/stream-deck-pairing-routes.js";
import { createCompactionSettingsRoutes } from "./http/routes/compaction-settings-routes.js";
import { createContextModeRoutes } from "./http/routes/context-mode-routes.js";
import { createSecureSecretSettingsRoutes } from "./http/routes/secure-secret-settings-routes.js";
import { createDebugRoutes } from "./http/routes/debug-routes.js";
import { createExtensionRoutes } from "./http/routes/extension-routes.js";
import { createFeedbackRoutes } from "./http/routes/feedback-routes.js";
import { createFileBrowserRoutes } from "./http/routes/file-browser-routes.js";
import { createFileRoutes } from "./http/routes/file-routes.js";
import { createGitDiffRoutes } from "./http/routes/git-diff-routes.js";
import { createGitSourceControlRoutes } from "./http/routes/git-source-control-routes.js";
import { createHistoryIndexRoutes } from "./http/routes/history-index-routes.js";
import { createRemoteUpdateAwarenessRoutes } from "./http/routes/remote-update-awareness-routes.js";
import { createHealthRoutes } from "./http/routes/health-routes.js";
import { createMermaidPreviewRoutes } from "./http/routes/mermaid-preview-routes.js";
import { createMobileRoutes } from "./http/routes/mobile-routes.js";
import { createManagerSelectionCatalogRoutes } from "./http/routes/manager-selection-catalog-routes.js";
import { createModelConfigRoutes } from "./http/routes/model-config-routes.js";
import { createOpenRouterRoutes } from "./http/routes/openrouter-routes.js";
import { createProjectResourceRoutes } from "./http/routes/project-resource-routes.js";
import { createPhoenixObservabilityRoutes } from "./http/routes/phoenix-observability-routes.js";
import { createOnboardingRoutes } from "./http/routes/onboarding-routes.js";
import { createPromptRoutes } from "./http/routes/prompt-routes.js";
import { createSchedulerRoutes } from "./http/routes/scheduler-routes.js";
import { createSessionAuditRoutes } from "./http/routes/session-audit-routes.js";
import {
  createSecureSecretRoutes,
  isDesktopOnlySecureSecretPath,
  type SecureSecretTransportService,
} from "./http/routes/secure-secret-routes.js";
import {
  createSecureSessionRoutes,
  isWebSafeSecureAccessRequestDismissal,
  type SecureSessionsTransportService,
} from "./http/routes/secure-session-routes.js";
import {
  createSecureBrowserControlRoutes,
  isDesktopOnlySecureBrowserPath,
  isPublicSecureBrowserPairingPath,
  isSecureBrowserControlPath,
  isSecureBrowserStatusPath,
  readSecureBrowserCookie,
  setSecureBrowserRequestDevice,
  type SecureBrowserVaultService,
} from "./http/routes/secure-browser-control-routes.js";
import { createSettingsRoutes, type SettingsRouteBundle } from "./http/routes/settings-routes.js";
import { createSkillRoutes } from "./http/routes/skill-routes.js";
import { createSlashCommandRoutes } from "./http/routes/slash-command-routes.js";
import { createWorkerPresetRoutes } from "./http/routes/worker-preset-routes.js";
import { createModelCacheVisualizationRoutes } from "./http/routes/model-cache-visualization-routes.js";
import { createRepositorySettingsRoutes } from "./http/routes/repository-settings-routes.js";
import { createStatsRoutes } from "./http/routes/stats-routes.js";
import { RepositorySettingsService } from "../swarm/repository-settings-service.js";
import { RepositoryProjectCreationService } from "../swarm/repository-project-creation-service.js";
import { createStaticUiRoutes } from "./http/routes/static-ui-routes.js";
import { createTelemetryRoutes } from "./http/routes/telemetry-routes.js";
import { createTerminalRoutes } from "./http/routes/terminal-routes.js";
import { createTranscriptionRoutes } from "./http/routes/transcription-routes.js";
import type { HttpRoute } from "./http/shared/http-route.js";
import type { PromptRegistryForRoutes } from "../swarm/prompt-contracts.js";
import { STATS_CACHE_TTL_MS, StatsService } from "../stats/stats-service.js";
import { TokenAnalyticsService } from "../stats/token-analytics-service.js";
import { GenerationThroughputService } from "../stats/generation-throughput-service.js";
import type { TelemetryService } from "../telemetry/telemetry-service.js";
import { LocalRemoteUpdateAwarenessService } from "./http/services/remote-update-awareness-service.js";

import type { TerminalRuntimeConfig } from "../terminal/terminal-config.js";
import { TerminalSettingsService } from "../terminal/terminal-settings-service.js";
import type { TerminalService } from "../terminal/terminal-service.js";
import { TerminalWsProxy } from "../terminal/terminal-ws-proxy.js";
import { resolveSessionAgentIdForUnread } from "./unread-utils.js";
import { SessionFeaturePublisher } from "./session-feature-publisher.js";

function isSecureBuilderControlPath(pathname: string): boolean {
  return (
    pathname === "/api/secure-secrets"
    || pathname.startsWith("/api/secure-secrets/")
    || pathname === "/api/settings/secure-secrets"
    || pathname === "/api/secure-sessions"
    || pathname.startsWith("/api/secure-sessions/")
    || isSecureBrowserControlPath(pathname)
  );
}

export class SwarmWebSocketServer {
  private readonly swarmManager: SwarmManager;
  private readonly host: string;
  private readonly port: number;
  private actualPort: number | null = null;
  private readonly builderSidebarOrderService: BuilderSidebarOrderService | null;
  private readonly compactionSettingsService: CompactionSettingsService | null;
  private readonly secureSecretSettingsService: SecureSecretSettingsService | null;
  private readonly repositorySettingsService: RepositorySettingsService | null;
  private readonly repositoryProjectCreationService: RepositoryProjectCreationService | null;
  private readonly repositoryCheckoutService: RepositoryCheckoutService;
  private readonly terminalService: TerminalService | null;
  private readonly terminalRuntimeConfig: TerminalRuntimeConfig | null;
  private readonly terminalSettingsService: TerminalSettingsService;
  private readonly terminalWsProxy: TerminalWsProxy | null;
  private readonly unreadTracker: UnreadTracker;
  private readonly notificationSettingsService: NotificationSettingsService;
  private readonly remoteUpdateAwarenessService: LocalRemoteUpdateAwarenessService | null;

  private readonly environment: EnvironmentService | undefined;
  private readonly environmentTransport: ReturnType<EnvironmentService["composeTransport"]> | undefined;
  private readonly httpPolicy: ReturnType<typeof createEnvironmentHttpPolicy> | undefined;
  private readonly tls: { cert: string; key: string } | undefined;

  private httpServer: HttpServer | null = null;

  private readonly sessionFeatures: SessionFeaturePublisher;
  private readonly cliAccessService: CliAccessService;
  private readonly streamDeckAccessService: StreamDeckAccessService;
  private readonly secureBrowserAccessService: SecureBrowserAccessService;
  private readonly mobilePushService: MobilePushService;
  private readonly settingsRoutes: SettingsRouteBundle;
  private readonly claudeAuthService: ClaudeAuthService | null;
  private readonly codexAuthService: CodexAuthService;
  private readonly nativeRuntimeUpdateService: NativeRuntimeUpdateService | null;
  private readonly statsService: StatsService;
  private readonly tokenAnalyticsService: TokenAnalyticsService;
  private readonly generationThroughputService: GenerationThroughputService;
  private readonly telemetryService: TelemetryService | null;
  private readonly observabilityService: ObservabilityFacade;
  private readonly feedbackService: FeedbackService;
  private readonly httpRoutes: HttpRoute[];
  private readonly controlPidFile: string;
  private readonly shouldManageControlPid: boolean;
  private readonly secureControlToken: string;

  private statsRefreshInterval: NodeJS.Timeout | null = null;
  private tokenAnalyticsRefreshInterval: NodeJS.Timeout | null = null;
  private generationThroughputRefreshInterval: NodeJS.Timeout | null = null;

  private ownsControlPidFile = false;

  private readonly onConversationMessage = (event: ServerEvent): void => {
    if (event.type !== "conversation_message" || isRetiredMessageSource(event.sourceContext)) return;

    const triggersUnread =
      isTerminalAssistantConversationMessage(event) ||
      event.source === "project_agent_input";

    if (triggersUnread) {
      void this.handleUnreadTrigger(event.agentId);
    }
  };

  private readonly onChoiceRequest = (event: ServerEvent): void => {
    if (event.type !== "choice_request") return;

    if (event.status === "pending") {
      const sessionAgentId = resolveSessionAgentIdForUnread(this.swarmManager, event.agentId);
      if (!sessionAgentId) {
        return;
      }

      void this.handleUnreadTrigger(event.agentId, sessionAgentId);
    }
  };

  private readonly onCodexElicitation = (event: ServerEvent): void => {
    if (event.type !== "codex_elicitation_request" && event.type !== "codex_elicitation_dismissed") return;
    this.sessionFeatures.publishForSession(event.agentId, event);
  };

  private readonly onGenerationThroughput = (event: ServerEvent): void => {
    if (event.type !== "generation_throughput") return;
    // Pi throughput is a Builder-local capability in v1. Do not forward it
    // through CLI subscriptions.
    this.sessionFeatures.publishThroughput(event.measurement.sessionId, event);
  };

  private readonly onManagerToolActivity = (event: ServerEvent): void => {
    if (event.type !== "manager_tool_activity") return;
    this.sessionFeatures.publishToolActivity(event);
  };

  private readonly onTimelineActivity = (event: ServerEvent): void => {
    if (event.type !== "timeline_activity") return;
    this.sessionFeatures.publishForSession(event.sessionAgentId, event);
    // A mounted worker view subscribes under the worker's own ID.
    if (event.item.actorId !== event.sessionAgentId) this.sessionFeatures.publishForSession(event.item.actorId, event);
  };

  private readonly onProfilesSnapshot = (event: ServerEvent): void => {
    if (event.type !== "profiles_snapshot") return;
    void this.remoteUpdateAwarenessService?.reconcileProjects().catch((error) => {
      console.warn("[remote-update-awareness] Project reconciliation failed", error);
    });
  };

  private readonly onSecureSessionSnapshot = (event: ServerEvent): void => {
    if (event.type !== "secure_session_snapshot") return;
    this.sessionFeatures.publishSecureSnapshot(event);
  };

  private readonly onSecureSecretCatalogChanged = (event: ServerEvent): void => {
    if (event.type !== "secure_secret_catalog_changed") return;
    this.sessionFeatures.publish(event);
  };

  private readonly onTerminalCreated = (event: TerminalCreatedEvent): void => {
    this.sessionFeatures.publishForSession(event.sessionAgentId, event);
  };

  private readonly onTerminalUpdated = (event: TerminalUpdatedEvent): void => {
    this.sessionFeatures.publishForSession(event.sessionAgentId, event);
  };

  private readonly onTerminalClosed = (event: TerminalClosedEvent): void => {
    this.sessionFeatures.publishForSession(event.sessionAgentId, event);
  };

  private async handleUnreadTrigger(
    agentId: string,
    resolvedSessionAgentId?: string
  ): Promise<void> {
    const sessionAgentId = resolvedSessionAgentId ?? resolveSessionAgentIdForUnread(this.swarmManager, agentId);
    if (!sessionAgentId) {
      return;
    }

    const { profileId } = this.resolveUnreadContext(sessionAgentId);
    if (profileId) this.unreadTracker.increment(profileId, sessionAgentId);
  }

  private resolveUnreadContext(sessionAgentId: string): { profileId: string | null } {
    const descriptor = this.swarmManager.getAgent(sessionAgentId);
    if (!descriptor || descriptor.role !== "manager") {
      return { profileId: null };
    }

    return { profileId: descriptor.profileId ?? descriptor.agentId };
  }

  broadcastBrowserSessionChanged(
    snapshot: BrowserSessionSnapshot,
    reason: "host-report" | "automation" | "human-command" | "lifecycle" | "recovery",
  ): void {
    this.sessionFeatures.browser?.publish(snapshot);
    void reason;
  }

  broadcastBrowserHostChanged(host: BrowserHostConnectionSnapshot): void {
    this.sessionFeatures.browserHost.publishHost(host);
  }

  constructor(options: {
    swarmManager: SwarmManager;
    environment?: EnvironmentService;
    tls?: { cert: string; key: string };
    host: string;
    port: number;
    terminalService?: TerminalService | null;
    terminalRuntimeConfig?: TerminalRuntimeConfig | null;
    terminalSettingsService?: TerminalSettingsService;
    promptRegistry?: PromptRegistryForRoutes;
    unreadTracker?: UnreadTracker;
    statsService?: StatsService;
    telemetryService?: TelemetryService | null;
    cliAccessService?: CliAccessService;
    streamDeckAccessService?: StreamDeckAccessService;
    secureBrowserAccessService?: SecureBrowserAccessService;
    notificationSettingsService?: NotificationSettingsService;
    builderSidebarOrderService?: BuilderSidebarOrderService;
    compactionSettingsService?: CompactionSettingsService;
    secureSecretSettingsService?: SecureSecretSettingsService;
    observabilityService?: ObservabilityFacade;
    feedbackService?: FeedbackService;
    remoteUpdateAwarenessService?: LocalRemoteUpdateAwarenessService;
    browserAutomationService?: BrowserAutomationService;
    secureControlToken?: string;
  }) {
    this.swarmManager = options.swarmManager;
    this.environment = options.environment;
    this.tls = options.tls;
    this.host = options.host;
    this.port = options.port;
    this.secureControlToken = options.secureControlToken ?? "";
    this.builderSidebarOrderService =
      options.builderSidebarOrderService ??
      new BuilderSidebarOrderService({ dataDir: this.swarmManager.getConfig().paths.dataDir });
    this.compactionSettingsService =
      options.compactionSettingsService ?? this.swarmManager.getCompactionSettingsService();
    this.secureSecretSettingsService =
      options.secureSecretSettingsService
      ?? this.swarmManager.getSecureSecretSettingsService();
    this.cliAccessService = options.cliAccessService ?? new CliAccessService({
      dataDir: this.swarmManager.getConfig().paths.dataDir,
      envApiKey: readCliApiKeyEnv(),
    });
    this.streamDeckAccessService = options.streamDeckAccessService ?? new StreamDeckAccessService({
      dataDir: this.swarmManager.getConfig().paths.dataDir,
    });
    this.cliAccessService.setCredentialRevocationHook(id => this.environment?.access.revokeIntegrationPrincipal({ integration: "cli", credentialId: id }));
    this.streamDeckAccessService.setCredentialRevocationHook(id => this.environment?.access.revokeIntegrationPrincipal({ integration: "stream-deck", credentialId: id }));
    this.secureBrowserAccessService =
      options.secureBrowserAccessService ??
      new SecureBrowserAccessService({
        dataDir: this.swarmManager.getConfig().paths.dataDir,
      });
    this.notificationSettingsService =
      options.notificationSettingsService ??
      new NotificationSettingsService({ dataDir: this.swarmManager.getConfig().paths.dataDir });
    this.terminalService = options.terminalService ?? null;
    this.terminalRuntimeConfig = options.terminalRuntimeConfig ?? null;
    this.terminalSettingsService =
      options.terminalSettingsService ??
      new TerminalSettingsService({ dataDir: this.swarmManager.getConfig().paths.dataDir });
    this.terminalWsProxy =
      this.terminalService && this.terminalRuntimeConfig
        ? new TerminalWsProxy({
            terminalService: this.terminalService,
            runtimeConfig: this.terminalRuntimeConfig,
            environmentAccess: this.environment?.access,
          })
        : null;
    this.observabilityService =
      options.observabilityService ??
      createNoopObservabilityFacade();
    this.feedbackService =
      options.feedbackService ??
      new FeedbackService(this.swarmManager.getConfig().paths.dataDir, { observability: this.observabilityService });
    this.unreadTracker =
      options.unreadTracker ??
      new UnreadTracker({
        dataDir: this.swarmManager.getConfig().paths.dataDir,
        getProfileIds: () => this.swarmManager.listProfiles?.().map((profile) => profile.profileId) ?? [],
        getSessionAgentIds: (profileId) =>
          this.swarmManager
            .listAgents?.()
            .filter(
              (descriptor) =>
                descriptor.role === "manager" &&
                (descriptor.profileId ?? descriptor.agentId) === profileId,
            )
            .map((descriptor) => descriptor.agentId) ?? [],
      });

    const remoteUpdateConfig = this.swarmManager.getConfig();
    this.remoteUpdateAwarenessService = (
      options.remoteUpdateAwarenessService ||
      (remoteUpdateConfig.paths.remoteUpdateAwarenessDbPath && remoteUpdateConfig.remoteUpdateAwarenessModules)
    )
      ? options.remoteUpdateAwarenessService ?? new LocalRemoteUpdateAwarenessService({
          swarmManager: this.swarmManager,
          broadcastProjectEvent: () => undefined,
        })
      : null;

    this.mobilePushService = new MobilePushService({
      swarmManager: this.swarmManager,
      dataDir: this.swarmManager.getConfig().paths.dataDir,
      notificationSettingsService: this.notificationSettingsService,
    });
    this.controlPidFile = getControlPidFilePath(
      this.swarmManager.getConfig().paths.rootDir,
      this.swarmManager.getConfig().port
    );
    this.shouldManageControlPid =
      !this.swarmManager.getConfig().isDesktop && readDaemonizedEnv() !== "1";
    const artifactTicketStore = new PresentedChatArtifactTicketStore();
    const htmlPreviewStore = new HtmlArtifactPreviewStore();

    this.sessionFeatures = new SessionFeaturePublisher({
      swarmManager: this.swarmManager,
      terminalService: this.terminalService,
      listTerminalsForSession: this.terminalService
        ? (sessionAgentId) => this.terminalService?.listTerminals(sessionAgentId) ?? []
        : undefined,

      browserAutomationService: options.browserAutomationService,
    });
    this.environmentTransport = this.environment?.composeTransport(this.sessionFeatures, this.terminalService);

    this.repositorySettingsService = new RepositorySettingsService({ dataDir: this.swarmManager.getConfig().paths.dataDir });
    this.repositoryProjectCreationService = this.repositorySettingsService
      ? new RepositoryProjectCreationService({
          swarmManager: this.swarmManager,
          settingsService: this.repositorySettingsService,
          publishProject: async (input, manager) => {
            if (!this.environment || !input.principal || !manager.modelSelection) throw new Error("Project control is unavailable");
            const receipt = await this.environment.control.execute(input.principal, "project.create", { commandId: input.requestId, title: manager.name, cwd: manager.cwd, model: { ...manager.modelSelection, ...(manager.reasoningLevel ? { thinkingLevel: manager.reasoningLevel } : {}) }, ...(manager.secureSessionsEnabled !== undefined ? { secureSessionsEnabled: manager.secureSessionsEnabled } : {}) });
            if (receipt.state !== "succeeded" || !receipt.result?.sessionId) throw new Error(receipt.error?.message ?? "Project creation was interrupted");
            const descriptor = this.swarmManager.getAgentForInternalUse(receipt.result.sessionId);
            if (!descriptor) throw new Error("Created project default session is missing");
            return descriptor;
          },
        })
      : null;
    this.repositoryCheckoutService = new RepositoryCheckoutService({ creationService: this.repositoryProjectCreationService!, settingsService: this.repositorySettingsService!, swarmManager: this.swarmManager, machineName: this.environment?.descriptor().label });

    this.telemetryService = options.telemetryService ?? null;
    this.statsService = options.statsService ?? new StatsService(this.swarmManager, {
      onRefreshAllCompleted: (allStats) => {
        void this.telemetryService?.sendOnStatsRefresh(allStats);
      },
    });
    this.claudeAuthService = new ClaudeAuthService(this.swarmManager.getConfig(), () => this.swarmManager.notifyNativeAuthChanged("claude-native"));
    this.nativeRuntimeUpdateService = new NativeRuntimeUpdateService({ dataDir: this.swarmManager.getConfig().paths.dataDir });
    this.codexAuthService = new CodexAuthService({
      listCredentialPool: provider => this.swarmManager.listCredentialPool(provider),
      addPooledCredential: (provider, credential) => this.swarmManager.addPooledCredential(provider, credential),
      isOpenAIAuthBrokerModeActive: () => this.swarmManager.isOpenAIAuthBrokerModeActive(),
      config: this.swarmManager.getConfig(),
      onAccessChanged: () => this.swarmManager.notifyNativeAuthChanged("codex-native"),
    });
    this.settingsRoutes = createSettingsRoutes({
      swarmManager: this.swarmManager,
      notificationSettingsService: this.notificationSettingsService,
      statsService: this.statsService,
    });
    this.tokenAnalyticsService = new TokenAnalyticsService(this.swarmManager);
    this.generationThroughputService = new GenerationThroughputService(this.swarmManager);

    const secureTransportService = this.swarmManager as unknown as
      SecureSecretTransportService
      & SecureSessionsTransportService
      & SecureBrowserVaultService;

    this.httpRoutes = [
      ...(this.environment?.routes ?? []),
      ...createCliRoutes({
        cliAccessService: this.cliAccessService,
        swarmManager: this.swarmManager,
      }),
      ...createStreamDeckRoutes({
        cliAccessService: this.cliAccessService,
        streamDeckAccessService: this.streamDeckAccessService,
        swarmManager: this.swarmManager,
        unreadTracker: this.unreadTracker,
        statsService: this.statsService,
        broadcastEvent: (event) => this.sessionFeatures.publish(event),
        environmentControl: this.environment ? { control: this.environment.control, principalForRequest: requireHttpPrincipal } : undefined,
        onUnreadChanged: () => undefined,
      }),
      ...createStreamDeckPairingRoutes({
        streamDeckAccessService: this.streamDeckAccessService,
      }),
      ...createCliAccessSettingsRoutes({
        cliAccessService: this.cliAccessService,
      }),
      ...createSecureBrowserControlRoutes({
        accessService: this.secureBrowserAccessService,
        vaultService: secureTransportService,
        secureControlAvailable: this.secureControlToken.length >= 32,
      }),
      ...createProjectSecureSessionsRoutes({ service: this.swarmManager }),
      ...createSecureSecretRoutes({ service: secureTransportService }),
      ...createSecureSessionRoutes({ service: secureTransportService }),
      ...(this.builderSidebarOrderService
        ? createBuilderSidebarOrderRoutes({
            service: this.builderSidebarOrderService,
            broadcastEvent: (event) => this.sessionFeatures.publish(event),
          })
        : []),
      ...createHistoryIndexRoutes({ swarmManager: this.swarmManager }),
      ...createHealthRoutes({
        resolveControlPidFile: () => this.controlPidFile,
        allowReboot: !this.swarmManager.getConfig().isDesktop,
        swarmManager: this.swarmManager
      }),
      ...createFileRoutes({ swarmManager: this.swarmManager }),
      ...createChatArtifactRoutes({ swarmManager: this.swarmManager, ticketStore: artifactTicketStore }),
      ...createArtifactPreviewRoutes({ swarmManager: this.swarmManager, previewStore: htmlPreviewStore }),
      ...createFileBrowserRoutes({ swarmManager: this.swarmManager }),
      ...createGitDiffRoutes({ swarmManager: this.swarmManager }),
      ...createGitSourceControlRoutes({ swarmManager: this.swarmManager }),
      ...(this.remoteUpdateAwarenessService
        ? createRemoteUpdateAwarenessRoutes({ service: this.remoteUpdateAwarenessService })
        : []),
      ...createFeedbackRoutes({ swarmManager: this.swarmManager, feedbackService: this.feedbackService }),
      ...createPhoenixObservabilityRoutes({ observabilityService: this.observabilityService }),
      ...createOnboardingRoutes({ swarmManager: this.swarmManager }),
      ...(this.compactionSettingsService
        ? createCompactionSettingsRoutes({
            settingsService: this.compactionSettingsService,
          })
        : []),
      ...(this.secureSecretSettingsService
        ? createSecureSecretSettingsRoutes({
            settingsService: this.secureSecretSettingsService,
          })
        : []),
      ...(this.repositorySettingsService
        ? createRepositorySettingsRoutes({
            settingsService: this.repositorySettingsService,
          })
        : []),
      ...createDebugRoutes({ swarmManager: this.swarmManager }),
      ...createTranscriptionRoutes({ swarmManager: this.swarmManager }),
      ...createStatsRoutes({
        statsService: this.statsService,
        tokenAnalyticsService: this.tokenAnalyticsService,
        generationThroughputService: this.generationThroughputService,
      }),
      ...(this.telemetryService ? createTelemetryRoutes({ telemetryService: this.telemetryService }) : []),
      ...createSchedulerRoutes({ swarmManager: this.swarmManager }),
      ...createSlashCommandRoutes({ swarmManager: this.swarmManager }),
      ...createMobileRoutes({ mobilePushService: this.mobilePushService }),
      ...createManagerSelectionCatalogRoutes({ swarmManager: this.swarmManager }),
      ...createAgentHttpRoutes({ swarmManager: this.swarmManager, control: this.environment?.control }),
      ...createContextModeRoutes({ swarmManager: this.swarmManager, control: this.environment?.control }),
      ...createSessionAuditRoutes({ swarmManager: this.swarmManager }),
      ...createCodexCatalogRoutes({ swarmManager: this.swarmManager }),
      ...(this.terminalService ? createTerminalRoutes({ terminalService: this.terminalService, settingsService: this.terminalSettingsService, terminalTransport: this.environmentTransport?.terminalTransport }) : []),
      ...(this.claudeAuthService ? createClaudeAuthRoutes(this.claudeAuthService) : []),
      ...createCodexAuthRoutes(this.codexAuthService),
      ...createRepositoryCheckoutRoutes(this.repositoryCheckoutService),
      ...(this.nativeRuntimeUpdateService ? createNativeRuntimeRoutes(this.nativeRuntimeUpdateService) : []),
      ...this.settingsRoutes.routes,
      ...createWorkerPresetRoutes({ swarmManager: this.swarmManager }),
      ...createModelCacheVisualizationRoutes({
        swarmManager: this.swarmManager,
        broadcastEvent: (event) => this.sessionFeatures.publish(event),
      }),
      ...createModelConfigRoutes({
        swarmManager: this.swarmManager,
        broadcastEvent: (event) => this.sessionFeatures.publish(event),
      }),
      ...createProjectResourceRoutes({ swarmManager: this.swarmManager }),
      ...createOpenRouterRoutes({
        swarmManager: this.swarmManager,
        broadcastEvent: (event) => this.sessionFeatures.publish(event),
      }),
      ...createExtensionRoutes({ swarmManager: this.swarmManager }),
      ...createSkillRoutes({ swarmManager: this.swarmManager }),
      ...createMermaidPreviewRoutes(),
      ...(options.promptRegistry
        ? createPromptRoutes({
            promptRegistry: options.promptRegistry,
            broadcastEvent: (event) => this.sessionFeatures.publish(event),
            promptPreviewProvider: this.swarmManager,
            listProfiles: () => this.swarmManager.listProfiles(),
          })
        : []),
      ...createStaticUiRoutes({
        rootDir: this.swarmManager.getConfig().paths.rootDir,
        resourcesDir: this.swarmManager.getConfig().paths.resourcesDir,
        nodeEnv: process.env.NODE_ENV,
      }),
    ];
    this.httpPolicy = this.environment ? createEnvironmentHttpPolicy({ access: this.environment.access, exposure: this.environment.exposure,
      inventory: createRouteInventory(this.httpRoutes), integrationAuthenticators: {
        cli: async request => {
          let principal: Principal;
          try { principal = await this.environment!.access.authenticateHttp(request, 'session:read', false); }
          catch (error) {
            if (!(error instanceof AccessError) || error.code !== 'UNAUTHENTICATED') throw error;
            principal = await this.authenticateCliPrincipal(request);
          }
          bindHttpPrincipal(request, principal);
        },
        "stream-deck": async request => {
          const result = await this.streamDeckAccessService.authenticateAuthorizationHeader(request.headers.authorization);
          const principal = result.ok ? this.environment!.access.ensureIntegrationPrincipal({ integration: "stream-deck", credentialId: result.deviceId, label: "Stream Deck", scopes: ["session:read", "session:operate"] }) : await this.authenticateCliPrincipal(request);
          bindHttpPrincipal(request, principal);
        },
        "secure-browser-control": async request => {
          if (isPublicSecureBrowserPairingPath(request.method, resolveRequestUrl(request, `${this.host}:${this.getPort()}`).pathname)) return;
          if (validateSecureBuilderControlCapability(request, this.secureControlToken)) return;
          const result = await this.secureBrowserAccessService.authenticateToken(readSecureBrowserCookie(request.headers.cookie));
          if (!result.ok) throw new AccessError("UNAUTHENTICATED", "Secure browser authentication required");
          setSecureBrowserRequestDevice(request, result.device);
        },
      } }) : undefined;
  }

  private async authenticateCliPrincipal(request: IncomingMessage): Promise<Principal> {
    const result = await authenticateCliHttpRequest(this.cliAccessService, request);
    if (!result.ok) throw new AccessError(result.statusCode === 403 ? "FORBIDDEN" : "UNAUTHENTICATED", result.message);
    if (!this.environment) throw new AccessError("UNAUTHENTICATED", "Environment authentication unavailable");
    return this.cliPrincipalForAuth(request, result);
  }

  private cliPrincipalForAuth(request: IncomingMessage, result: Extract<import("../swarm/cli-access-service.js").CliAccessAuthResult, { ok: true }>): Principal {
    const credentialId = result.source === "env" ? "env:" + createHash("sha256").update(request.headers.authorization!.slice(7).trim()).digest("hex").slice(0, 16) : result.keyId;
    return this.environment!.access.ensureIntegrationPrincipal({ integration: "cli", credentialId, label: "CLI", scopes: ["session:read", "session:operate"] });
  }

  /**
   * Enumerates the registered HTTP route table. Exists for the
   * route-inventory classification gate: every registered route must map to
   * an explicitly reviewed access class (see route-inventory tests).
   */
  listRegisteredHttpRoutes(): ReadonlyArray<Pick<HttpRoute, "methods" | "matches">> {
    return this.httpRoutes;
  }

  async start(): Promise<void> {
    if (this.httpServer) {
      return;
    }

    if (this.builderSidebarOrderService) {
      await this.builderSidebarOrderService.load();
    }
    if (this.compactionSettingsService) {
      await this.compactionSettingsService.load();
    }
    if (this.secureSecretSettingsService) {
      await this.secureSecretSettingsService.load();
    }
    if (this.repositorySettingsService) {
      await this.repositorySettingsService.load();
    }
    await this.notificationSettingsService.load();
    if (!this.environment) await this.unreadTracker.load();
    await this.swarmManager.loadModelCacheVisualizationSettings?.();
    await this.remoteUpdateAwarenessService?.start();

    const listener = (request: IncomingMessage, response: ServerResponse) => { void this.handleHttpRequest(request, response); };
    const httpServer = this.tls ? createHttpsServer({ cert: await readFile(this.tls.cert), key: await readFile(this.tls.key) }, listener) : createServer(listener);
    this.httpServer = httpServer;
    httpServer.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        cleanup();
        this.actualPort = resolveListeningPort(httpServer, this.port);
        resolve();
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const cleanup = (): void => {
        httpServer.off("listening", onListening);
        httpServer.off("error", onError);
      };

      httpServer.on("listening", onListening);
      httpServer.on("error", onError);
      httpServer.listen(this.port, this.host);
    });

    if (this.shouldManageControlPid) {
      this.ownsControlPidFile = await tryWriteOwnedControlPidFile(this.controlPidFile);
    }

    this.swarmManager.on("conversation_message", this.onConversationMessage);
    this.swarmManager.on("choice_request", this.onChoiceRequest);
    this.swarmManager.on("codex_elicitation_request", this.onCodexElicitation);
    this.swarmManager.on("codex_elicitation_dismissed", this.onCodexElicitation);
    this.swarmManager.on("generation_throughput", this.onGenerationThroughput);
    this.swarmManager.on("manager_tool_activity", this.onManagerToolActivity);
    this.swarmManager.on("timeline_activity", this.onTimelineActivity);
    this.swarmManager.on("profiles_snapshot", this.onProfilesSnapshot);
    this.swarmManager.on("secure_session_snapshot", this.onSecureSessionSnapshot);
    this.swarmManager.on(
      "secure_secret_catalog_changed",
      this.onSecureSecretCatalogChanged,
    );
    this.terminalService?.on("terminal_created", this.onTerminalCreated);
    this.terminalService?.on("terminal_updated", this.onTerminalUpdated);
    this.terminalService?.on("terminal_closed", this.onTerminalClosed);
    await this.mobilePushService.start();

    const refreshStatsInBackground = () => {
      void this.statsService.refreshAllRangesInBackground().catch(() => false);
    };
    const refreshTokenAnalyticsInBackground = () => {
      void this.tokenAnalyticsService.refreshScanInBackground().catch(() => false);
    };
    const refreshGenerationThroughputInBackground = () => {
      void this.generationThroughputService.refreshScanInBackground().catch(() => false);
    };

    // Backstop behavior: keep an automatic refresh cadence (every cache TTL) so telemetry still
    // gets refresh-completion triggers even when nobody calls /api/stats/refresh manually.
    // Avoid an unconditional startup stats refresh here so provider-usage auth probing only runs
    // on demand or on the scheduled background cadence.
    void this.tokenAnalyticsService.prewarmInBackground().catch(() => false);
    void this.generationThroughputService.prewarmInBackground().catch(() => false);
    this.statsRefreshInterval = setInterval(() => {
      refreshStatsInBackground();
    }, STATS_CACHE_TTL_MS);
    this.statsRefreshInterval.unref?.();
    this.tokenAnalyticsRefreshInterval = setInterval(() => {
      refreshTokenAnalyticsInBackground();
    }, STATS_CACHE_TTL_MS);
    this.tokenAnalyticsRefreshInterval.unref?.();
    this.generationThroughputRefreshInterval = setInterval(() => {
      refreshGenerationThroughputInBackground();
    }, STATS_CACHE_TTL_MS);
    this.generationThroughputRefreshInterval.unref?.();

    await this.telemetryService?.start();
  }

  getPort(): number {
    return this.actualPort ?? this.port;
  }

  async stop(): Promise<void> {
    if (this.statsRefreshInterval) {
      clearInterval(this.statsRefreshInterval);
      this.statsRefreshInterval = null;
    }
    if (this.tokenAnalyticsRefreshInterval) {
      clearInterval(this.tokenAnalyticsRefreshInterval);
      this.tokenAnalyticsRefreshInterval = null;
    }
    if (this.generationThroughputRefreshInterval) {
      clearInterval(this.generationThroughputRefreshInterval);
      this.generationThroughputRefreshInterval = null;
    }

    this.swarmManager.off("conversation_message", this.onConversationMessage);
    this.swarmManager.off("choice_request", this.onChoiceRequest);
    this.swarmManager.off("codex_elicitation_request", this.onCodexElicitation);
    this.swarmManager.off("codex_elicitation_dismissed", this.onCodexElicitation);
    this.swarmManager.off("generation_throughput", this.onGenerationThroughput);
    this.swarmManager.off("manager_tool_activity", this.onManagerToolActivity);
    this.swarmManager.off("timeline_activity", this.onTimelineActivity);
    this.swarmManager.off("profiles_snapshot", this.onProfilesSnapshot);
    this.swarmManager.off("secure_session_snapshot", this.onSecureSessionSnapshot);
    this.swarmManager.off(
      "secure_secret_catalog_changed",
      this.onSecureSecretCatalogChanged,
    );
    this.terminalService?.off("terminal_created", this.onTerminalCreated);
    this.terminalService?.off("terminal_updated", this.onTerminalUpdated);
    this.terminalService?.off("terminal_closed", this.onTerminalClosed);

    const currentHttpServer = this.httpServer;

    this.httpServer = null;
    this.actualPort = null;

    await this.environmentTransport?.rpc.stop();

    // Close ingress immediately, but retain handler state until in-flight work
    // has settled. Repository creation shutdown can still depend on the real
    // socket bookkeeping while it aborts and cleans up active operations.
    const transportShutdown = Promise.allSettled([
      this.terminalWsProxy?.stop() ?? Promise.resolve(),

      currentHttpServer ? closeHttpServer(currentHttpServer) : Promise.resolve(),
    ]);

    // Stop local Git observations before closing feature storage.
    await this.remoteUpdateAwarenessService?.stop();
    // Abort in-flight clones and await termination/cleanup before persistence drains.
    await this.repositoryCheckoutService.shutdown();
    await this.repositoryProjectCreationService?.shutdown();

    this.settingsRoutes.cancelActiveSettingsAuthLoginFlows();
    await this.claudeAuthService?.shutdown();
    this.codexAuthService.shutdown();
    this.telemetryService?.stop();

    await this.swarmManager.flushPendingPersistence?.();

    await Promise.allSettled([
      this.mobilePushService.stop(),
      this.unreadTracker.flush(),
      transportShutdown,
    ]);
    await this.generationThroughputService.dispose();

    if (this.ownsControlPidFile) {
      await removeOwnedControlPidFile(this.controlPidFile);
      this.ownsControlPidFile = false;
    }
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!this.httpServer) {
      ignoreSocketErrors(socket);
      socket.destroy();
      return;
    }

    const requestUrl = resolveRequestUrl(request, `${this.host}:${this.getPort()}`);
    try {
      if (!this.environment) throw new AccessError("UNAUTHENTICATED", "Environment authentication unavailable");
      this.environment.exposure.validateForwarding(request);
      if (!this.environment.exposure.allowsOrigin(request.headers.origin ?? null)) throw new AccessError("FORBIDDEN", "Origin is not allowed");
      if (requestUrl.pathname === "/api/v2/rpc") {
        await this.environmentTransport!.rpc.handleUpgrade(request, socket, head, requestUrl.pathname);
        return;
      }
      if (this.terminalWsProxy?.canHandleUpgrade(requestUrl.pathname)) {
        await this.terminalWsProxy.handleUpgrade(request, socket, head, requestUrl.pathname);
        return;
      }
      rejectWebSocketUpgrade(socket, 404, "Not Found");
    } catch (error) {
      rejectWebSocketUpgrade(socket, error instanceof AccessError && error.code === "FORBIDDEN" ? 403 : 401, "Environment socket access denied");
    }
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = resolveRequestUrl(request, `${this.host}:${this.getPort()}`);
    let route: HttpRoute | undefined;

    try {
      if (!this.httpPolicy) { sendJson(response, 503, { error: "Environment access is not initialized" }); return; }
      const gate = await this.httpPolicy(request, response, requestUrl);
      if (gate.handled) return;
      if (gate.principal) bindHttpPrincipal(request, gate.principal);
      if (isSecureBuilderControlPath(requestUrl.pathname)) {
        const originValidation = validateSecureBuilderControlOrigin(
          request,
          {
            backendHost: this.host,
            backendPort: this.getPort(),
          },
        );
        if (!originValidation.ok) {
          sendJson(response, 403, { error: originValidation.errorMessage });
          return;
        }
        const hasDesktopCapability = validateSecureBuilderControlCapability(
          request,
          this.secureControlToken,
        );
        let hasSecureBrowserCapability = false;
        if (
          isSecureBrowserStatusPath(request.method, requestUrl.pathname)
          || (
            !hasDesktopCapability
            && isSecureBrowserControlPath(requestUrl.pathname)
          )
          || (
            !hasDesktopCapability
            && request.method !== "GET"
            && request.method !== "HEAD"
            && request.method !== "OPTIONS"
          )
        ) {
          const authentication = await this.secureBrowserAccessService.authenticateToken(
            readSecureBrowserCookie(request.headers.cookie),
          );
          if (authentication.ok) {
            hasSecureBrowserCapability = true;
            setSecureBrowserRequestDevice(request, authentication.device);
          }
        }
        const isPreflight = request.method === "OPTIONS";
        const desktopOnlyPath =
          isDesktopOnlySecureBrowserPath(requestUrl.pathname)
          || isDesktopOnlySecureSecretPath(requestUrl.pathname);
        const mutationRequiresControl =
          request.method !== "GET"
          && request.method !== "HEAD"
          && request.method !== "OPTIONS"
          && !isWebSafeSecureAccessRequestDismissal(
            request.method,
            requestUrl.pathname,
          )
          && !isPublicSecureBrowserPairingPath(
            request.method,
            requestUrl.pathname,
          );
        if (
          (desktopOnlyPath && !isPreflight && !hasDesktopCapability)
          || (
            mutationRequiresControl
            && !hasDesktopCapability
            && !hasSecureBrowserCapability
          )
        ) {
          sendJson(response, 403, {
            code: "SECURE_PRIVATE_API_UNAVAILABLE",
            error: "SECURE_PRIVATE_API_UNAVAILABLE",
          });
          return;
        }
      }
      route = this.httpRoutes.find((candidate) => candidate.methods.split(",").map(method => method.trim()).includes(request.method ?? "") && candidate.matches(requestUrl.pathname));

      if (!route) {
        applyCorsHeaders(request, response, "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
        response.statusCode = 404;
        response.end("Not Found");
        return;
      }

      await route.handle(request, response, requestUrl);
    } catch (error) {
      if (response.writableEnded || response.headersSent) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      const statusCode =
        message.includes("must be") ||
        message.includes("Invalid") ||
        message.includes("Missing") ||
        message.includes("too large")
          ? 400
          : 500;

      applyCorsHeaders(request, response, route?.methods ?? "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
      sendJson(response, statusCode, { error: message });
    }
  }
}

function ignoreSocketErrors(socket: Duplex): void {
  socket.once("error", () => {});
}

function rejectWebSocketUpgrade(
  socket: Duplex,
  statusCode: 401 | 403 | 404 | 500,
  message: string,
): void {
  if (socket.destroyed) {
    return;
  }

  ignoreSocketErrors(socket);

  const body = JSON.stringify({ error: message });
  const statusText =
    statusCode === 401
      ? "Unauthorized"
      : statusCode === 403
        ? "Forbidden"
        : statusCode === 404
          ? "Not Found"
          : "Internal Server Error";

  socket.end(
    [
      `HTTP/1.1 ${statusCode} ${statusText}`,
      "Connection: close",
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
      "",
      body,
    ].join("\r\n"),
  );
}

async function tryWriteOwnedControlPidFile(pidFile: string): Promise<boolean> {
  const existingPid = await readControlPidFromFile(pidFile);
  if (existingPid !== null && existingPid !== process.pid) {
    try {
      if (isPidAlive(existingPid)) {
        console.warn(`[reboot] Control pid file is already owned by pid ${existingPid}: ${pidFile}`);
        return false;
      }
    } catch {
      // Ignore liveness errors and overwrite stale pid files below.
    }
  }

  await writeFile(pidFile, `${process.pid}\n`, "utf8");
  return true;
}

async function removeOwnedControlPidFile(pidFile: string): Promise<void> {
  try {
    const rawPid = await readFile(pidFile, "utf8");
    if (Number.parseInt(rawPid.trim(), 10) !== process.pid) {
      return;
    }
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return;
    }

    throw error;
  }

  await rm(pidFile, { force: true });
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function resolveListeningPort(server: HttpServer, fallbackPort: number): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    return fallbackPort;
  }

  return address.port;
}
