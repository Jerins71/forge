import { supportsSecureRuntimeProvider } from "./secure-sessions/runtime/secure-runtime-provider-policy.js";
import type { CoreAgentMessagePort } from "./core-agent-message-port.js";
import type { HistorySearchService } from "./history-recall/index.js";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { PromptRegistry } from "./prompts/prompt-registry.js";
import type { ConversationProjector } from "./session/conversation-projector.js";
import type { SidebarPerfRecorder } from "../stats/sidebar-perf-types.js";
import { createLiveCompactionRuntimeSettingsProvider, type CompactionRuntimeSettingsProvider } from "./compaction-runtime-settings-provider.js";
import { MemoryCoordinator } from "./memory-coordinator.js";
import { RestartRecoveryCoordinator } from "./restart-recovery-coordinator.js";
import { SwarmBootCoordinator } from "./swarm-boot-coordinator.js";
import { SwarmObservabilityCoordinator } from "./swarm-observability-coordinator.js";
import { SwarmEventCoordinator } from "./swarm-event-coordinator.js";
import { AgentMessageDispatcher } from "./agent-message-dispatcher.js";
import { SwarmCompactionCoordinator } from "./swarm-compaction-coordinator.js";
import { AgentDescriptorStore } from "./agents/agent-descriptor-store.js";
import type { DescriptorStoreAdapter } from "./agents/descriptor-store/live-map-adapter.js";
import { AgentDirectory } from "./agent-directory.js";
import {
  createSwarmManagerFoundation,
  type SecureSessionsFoundation,
} from "./swarm-manager-foundation.js";
import { SwarmConfigurationCoordinator } from "./swarm-configuration-coordinator.js";
import { createSwarmManagerSessionComposition } from "./swarm-manager-session-composition.js";
import { createSwarmManagerCoreServices } from "./swarm-manager-core-services.js";
import { createSwarmManagerRuntimeComposition } from "./swarm-manager-runtime-composition.js";
import { SessionInteractionCoordinator } from "./session-interaction-coordinator.js";
import { isWorkGraphWorkerActive } from "./planning/work-graph-restart-recovery.js";
import { SwarmManagerFacade } from "./swarm-manager-facade.js";
import type { SwarmManagerFacadeServices, TerminalArchiveHooks } from "./swarm-manager-facade-services.js";
import type { ManagerBootstrapCoordinator } from "./manager-bootstrap-coordinator.js";
import { ProfileSessionBookkeepingCoordinator } from "./profile-session-bookkeeping-coordinator.js";
import { ArchiveService } from "./archive/archive-service.js";
import { ArchiveLastUsedHydrator } from "./archive/archive-last-used-hydrator.js";
import { ProjectAgentCoordinator } from "./project-agent-coordinator.js";
import type { PersistenceService } from "./persistence-service.js";
import { ForgeExtensionHost } from "./forge-extension-host.js";
import { RuntimeRecoveryState } from "./runtime/runtime-recovery-state.js";
import { SwarmRuntimeController } from "./swarm-runtime-controller.js";
import { SwarmRuntimeLifecycleCoordinator } from "./swarm-runtime-lifecycle-coordinator.js";
import { SpecialistFallbackPolicy } from "./specialist-fallback-policy.js";
import {
  getManagedModelProviderCredentialAvailability,
  SecretsEnvService
} from "./secrets-env-service.js";
import { SwarmMemoryMergeService } from "./swarm-memory-merge-service.js";
import { SwarmSessionMetaService } from "./swarm-session-meta-service.js";
import { SkillFileService } from "./skill-file-service.js";
import { SkillMetadataService, type SkillMetadata } from "./skills/skill-metadata-service.js";
import { SwarmChoiceService } from "./swarm-choice-service.js";
import { createLazySessionAttentionRuntimeHooks, SessionAttentionRuntime } from "./session/session-attention-runtime.js";
import {
  type ProjectExecutableTrustPlan
} from "./project-executable-trust.js";
import { ProjectExecutableTrustCoordinator } from "./project-executable-trust-coordinator.js";
import {
  SwarmAgentLifecycleService,
  type AgentLifecycleStopSessionOptions,
} from "./swarm-agent-lifecycle-service.js";
import { SessionProvisioner } from "./session-provisioner.js";
import { SessionDescriptorFactory } from "./session-descriptor-factory.js";
import { SecureSecretSettingsService } from "./secure-sessions/secure-secret-settings-service.js";
import { SecureSessionsService } from "./secure-sessions/secure-sessions-service.js";
import { createSecureSessionLifecyclePort } from "./secure-sessions/secure-session-lifecycle-port.js";
import { SessionPinCoordinator } from "./session-pin-coordinator.js";
import { SessionLifecycleCoordinator } from "./session-lifecycle-coordinator.js";
import { TurnContextCoordinator } from "./turn-context-coordinator.js";
import { SwarmSessionService } from "./swarm-session-service.js";
import { ProjectAgentSharingService } from "./project-agent-sharing-service.js";
import { SessionPlanCoordinator } from "./planning/session-plan-coordinator.js";
import { SessionActiveToolsState } from "./session-active-tools.js"; import { ManagerToolActivityState } from "./manager-tool-activity.js";
import { createModelChangeNoticeEvent } from "./runtime/model-change-continuity.js";
import { ConversationAttachmentService } from "./conversation-attachment-service.js";
import { InboundConversationAppender, UserMessageCoordinator } from "./user-message-coordinator.js";
import { AssistantOutputRouter } from "./assistant-output-router.js";
import type {
  RuntimeAcquisitionRequirements, RuntimeCreationOptions,
  SwarmAgentRuntime
} from "./runtime-contracts.js";
import type { SwarmToolHost } from "./swarm-tool-host.js";
import { BrowserAutomationService, createBrowserAutomationManagerInvoker } from "./browser-automation/index.js";
import type {
  AgentDescriptor,
  AgentModelDescriptor,
  ConversationEntryEvent,
  ManagerProfile,
  SwarmConfig,
  SwarmModelPreset,
} from "./types.js";
import {
  normalizeOptionalAgentId,
  nowIso,
} from "./swarm-manager-utils.js";
import {
  type CodexMcpToolGateEvaluation,
} from "./codex-app-server/codex-mcp-tool-gate.js";
import {
  CodexPluginDelegationCoordinator,
  type CodexPluginDelegationTurnContext,
  type CodexPluginRetryAuthorizationContext,
} from "./codex-app-server/codex-plugin-delegation-coordinator.js";
import {
  CodexDirectSidecarCoordinator,
  type CodexDirectSidecarManager,
} from "./codex-app-server/codex-direct-sidecar-coordinator.js";
import type { SwarmManagerOptions } from "./swarm-manager-options.js";
export { buildSessionMemoryRuntimeView } from "./swarm-manager-utils.js";
export type { RestartRecoverySnapshot } from "@forge/protocol";
export type { CodexTransportDebugAgentDiagnostics } from "./swarm-manager-facade.js";
export type {
  AppendConversationUserMessageOptions,
  AppendConversationUserMessageResult,
  DispatchRuntimeUserMessageOptions,
} from "./user-message-coordinator.js";
// AgentDescriptor now includes specialistId/specialistDisplayName/specialistColor directly.
// Keep the orchestration facade above its known internal listener fan-out.
const SWARM_MANAGER_MAX_EVENT_LISTENERS = 64;
export { ChoiceRequestCancelledError } from "./swarm-choice-service.js";
export class SwarmManager extends SwarmManagerFacade implements SwarmToolHost {
  private readonly config: SwarmConfig;
  private readonly now: () => string;
  private readonly defaultModelPreset: SwarmModelPreset;
  private readonly descriptors = new Map<string, AgentDescriptor>();
  private readonly profiles = new Map<string, ManagerProfile>();
  private readonly agentDirectory: AgentDirectory;
  private readonly runtimeController: SwarmRuntimeController;
  private readonly runtimes: Map<string, SwarmAgentRuntime>;
  readonly runtimeCreationPromisesByAgentId: Map<string, Promise<SwarmAgentRuntime>>;
  readonly runtimeTokensByAgentId: Map<string, number>;
  private readonly runtimeRecoveryState = new RuntimeRecoveryState();
  private readonly projectAgentMessageTimestampsBySender = new Map<string, number[]>();
  private readonly conversationEntriesByAgentId = new Map<string, ConversationEntryEvent[]>();
  private readonly runtimeLifecycleCoordinator: SwarmRuntimeLifecycleCoordinator;
  private readonly restartRecoveryCoordinator: RestartRecoveryCoordinator;
  private readonly bootCoordinator: SwarmBootCoordinator;
  private readonly specialistFallbackManager: SpecialistFallbackPolicy;
  private readonly managerBootstrapCoordinator: ManagerBootstrapCoordinator;
  private readonly profileSessionBookkeepingCoordinator: ProfileSessionBookkeepingCoordinator;
  private readonly configurationCoordinator: SwarmConfigurationCoordinator;
  private readonly sidebarPerfRecorder: SidebarPerfRecorder;
  private readonly sessionActiveTools = new SessionActiveToolsState(); private readonly managerToolActivity = new ManagerToolActivityState();
  private readonly conversationProjector: ConversationProjector;
  private readonly eventCoordinator: SwarmEventCoordinator;
  private readonly conversationAttachmentService: ConversationAttachmentService;
  private readonly inboundConversationAppender: InboundConversationAppender;
  private readonly userMessageCoordinator: UserMessageCoordinator;
  private readonly sessionPlanCoordinator: SessionPlanCoordinator;
  private readonly compactionCoordinator: SwarmCompactionCoordinator;
  lineage?: import("./lineage-tools.js").CoreLineagePort;
  installCoreLineagePort(port: import("./lineage-tools.js").CoreLineagePort): void { this.lineage=port; }
  prepareLineageSession(input: Parameters<SwarmSessionService["prepareLineageSession"]>[0]) { return this.sessionService.prepareLineageSession(input); }
  private async setControlledProviderModel(threadId:string,model?:Pick<AgentModelDescriptor,"provider"|"modelId"> & Partial<Pick<AgentModelDescriptor,"thinkingLevel">>):Promise<void> {
    const descriptor=this.descriptors.get(threadId);if(!descriptor) throw new Error("Provider target is unavailable");
    if(model && (descriptor.model.provider!==model.provider || descriptor.model.modelId!==model.modelId || model.thinkingLevel!==undefined && descriptor.model.thinkingLevel!==model.thinkingLevel)) {
      if(this.runtimes.has(threadId)) throw new Error("Model replacement requires confirmed provider shutdown");
      const updated = await this.descriptorStoreAdapter.patchDescriptor(threadId,{model:{...descriptor.model,...model},status:descriptor.status==="stopped"?"idle":descriptor.status});
      if (descriptor.role === "worker") {
        const manager = this.descriptors.get(descriptor.managerId);
        if (manager?.profileId) await this.sessionPlanCoordinator.recordWorkGraphWorkerModelReroute({agentId:manager.agentId,profileId:manager.profileId},threadId,updated.model);
      }
    } else if(descriptor.status==="stopped") await this.descriptorStoreAdapter.patchDescriptor(threadId,{status:"idle"});
  }
  override async acquireControlledProvider(scope: import("@forge/protocol").ProviderScope,conversation?:import("@forge/protocol").ProviderConversationRef,model?:Pick<AgentModelDescriptor,"provider"|"modelId"> & Partial<Pick<AgentModelDescriptor,"thinkingLevel">>) {
    await this.setControlledProviderModel(scope.threadId,model);
    return this.runtimeController.acquireProvider(scope,()=>this.userMessageCoordinator.acquireRuntime(scope.threadId),conversation);
  }
  installCoreAgentMessagePort(port: CoreAgentMessagePort): void {
    this.agentMessageDispatcher.installCoreAgentMessages(port);
    this.lifecycleService.installCoreAgentMessages(port);
    this.sessionInteractionCoordinator.installCoreAgentMessages(port);
    this.runtimeLifecycleCoordinator.installCoreAgentMessages(port);
  }
  installDescriptorPersistence(persistence: import("./agents/agent-descriptor-store.js").AgentDescriptorPersistence): void { this.descriptorStore.setPersistence(persistence); }
  private readonly descriptorStore: AgentDescriptorStore;
  private readonly descriptorStoreAdapter: DescriptorStoreAdapter;
  private readonly persistenceService: PersistenceService;
  private readonly forgeExtensionHost: ForgeExtensionHost;
  private readonly skillMetadataService: SkillMetadataService;
  private readonly skillFileService: SkillFileService;
  private readonly secretsEnvService: SecretsEnvService;
  private readonly secureSecretSettingsService: SecureSecretSettingsService;
  private readonly secureSessionsService: SecureSessionsService;
  private readonly sessionMetaService: SwarmSessionMetaService;
  private readonly memoryMergeService: SwarmMemoryMergeService;
  private readonly memoryCoordinator: MemoryCoordinator;
  private readonly sessionProvisioner: SessionProvisioner;
  private readonly sessionDescriptorFactory: SessionDescriptorFactory;
  private readonly sessionPinCoordinator: SessionPinCoordinator;
  private readonly assistantOutputRouter: AssistantOutputRouter;
  private readonly projectExecutableTrustCoordinator: ProjectExecutableTrustCoordinator;
  private readonly turnContextCoordinator: TurnContextCoordinator<
    CodexMcpToolGateEvaluation,
    CodexPluginDelegationTurnContext,
    CodexPluginRetryAuthorizationContext
  >;
  private readonly lifecycleService: SwarmAgentLifecycleService;
  private readonly choiceService: SwarmChoiceService;
  private readonly sessionAttention: SessionAttentionRuntime;
  private readonly sessionService: SwarmSessionService;
  private readonly archiveLastUsedHydrator: ArchiveLastUsedHydrator;
  private readonly archiveService: ArchiveService;
  private readonly projectAgentSharingService: ProjectAgentSharingService;
  private readonly projectAgentCoordinator: ProjectAgentCoordinator;
  private readonly agentMessageDispatcher: AgentMessageDispatcher<CodexMcpToolGateEvaluation>;
  private readonly sessionLifecycleCoordinator: SessionLifecycleCoordinator;
  private readonly sessionInteractionCoordinator: SessionInteractionCoordinator;
  private readonly facadeServices: SwarmManagerFacadeServices;
  readonly promptRegistry: PromptRegistry;
  private readonly codexDirectSidecarCoordinator: CodexDirectSidecarCoordinator;
  private readonly codexPluginDelegationCoordinator: CodexPluginDelegationCoordinator;
  private terminalArchiveHooks: TerminalArchiveHooks | undefined;
  private readonly observabilityCoordinator: SwarmObservabilityCoordinator;
  private readonly historySearchService: HistorySearchService;
  private readonly browserAutomationService: BrowserAutomationService;
  readonly invokeBrowserAutomation = createBrowserAutomationManagerInvoker({ getDescriptor: (id) => this.descriptors.get(id), getService: () => this.browserAutomationService });
  constructor(config: SwarmConfig, options?: SwarmManagerOptions) {
    super();
    this.now = options?.now ?? nowIso;
    const foundation = createSwarmManagerFoundation({
      config,
      descriptors: this.descriptors,
      profiles: this.profiles,
      now: this.now,
      getConfiguredManagerId: () => normalizeOptionalAgentId(config.managerId),
      getRuntimeToken: (agentId) => this.runtimeController.getRuntimeToken(agentId),
      sessionPins: {
        listSessions: () => Array.from(this.descriptors.values()).filter(
          (descriptor): descriptor is AgentDescriptor & { role: "manager"; profileId: string } =>
            this.agentDirectory.isSessionAgent(descriptor),
        ),
        requireSession: (agentId) => this.agentDirectory.getRequiredSessionDescriptor(agentId),
        assertMutable: (descriptor) =>
          this.agentDirectory.assertDescriptorNotEffectivelyArchived(descriptor),
        getConversationHistory: (agentId) => this.getConversationHistory(agentId),
        getRuntime: (agentId) => this.runtimes.get(agentId),
        patchDescriptor: (agentId, patch) => this.descriptorStoreAdapter.patchDescriptor(agentId, patch),
        setConversationMessagePinned: (agentId, messageId, pinned) =>
          this.conversationProjector.setConversationMessagePinned(agentId, messageId, pinned),
        captureRuntimePromptMeta: (descriptor, prompt) =>
          this.memoryCoordinator.captureSessionRuntimePromptMeta(descriptor, prompt),
        emitMessagePinned: (agentId, messageId, pinned, timestamp) =>
          this.eventCoordinator.emitMessagePinned(agentId, messageId, pinned, timestamp),
        emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
        logDebug: (message, details) => this.logDebug(message, details, config),
      },
      logDebug: (message, details) => this.logDebug(message, details, config),
      overrides: {
        observability: options?.observability,
        compactionRuntimeSettingsProvider: options?.compactionRuntimeSettingsProvider,
      },
    });
    this.config = foundation.config; this.defaultModelPreset = foundation.defaultModelPreset;
    this.historySearchService = foundation.historySearchService;
    this.promptRegistry = foundation.promptRegistry;
    this.forgeExtensionHost = foundation.forgeExtensionHost;
    this.sidebarPerfRecorder = foundation.sidebarPerfRecorder;
    this.descriptorStore = foundation.descriptorStore;
    this.conversationAttachmentService = foundation.conversationAttachmentService;
    this.sessionDescriptorFactory = foundation.sessionDescriptorFactory;
    this.sessionPinCoordinator = foundation.sessionPinCoordinator;
    this.skillMetadataService = foundation.skillMetadataService;
    this.skillFileService = foundation.skillFileService;
    this.secretsEnvService = foundation.secretsEnvService;
    this.observabilityCoordinator = foundation.observabilityCoordinator; this.browserAutomationService = options?.browserAutomationService ?? new BrowserAutomationService({ dataDir: this.config.paths.dataDir, now: this.now });
    this.agentDirectory = this.createAgentDirectory();
    this.secureSecretSettingsService = new SecureSecretSettingsService({
      dataDir: this.config.paths.dataDir,
      now: () => new Date(this.now()),
      getOccupiedProjectDefaultCount: () => this.secureSessionsService.getOccupiedProjectDefaultCount(),
      onSettingsChanged: () => this.secureSessionsService.notifySecureSecretSettingsChanged(),
    });
    this.secureSessionsService = this.createSecureSessionsService(foundation.secureSessions);
    const { compactionRuntimeSettingsProvider, liveCompactionRuntimeSettingsProvider } = foundation;
    const runtimeComposition = this.createRuntimeComposition();
    this.restartRecoveryCoordinator = runtimeComposition.restartRecovery;
    this.runtimeController = runtimeComposition.runtimeController;
    this.assistantOutputRouter = runtimeComposition.assistantOutput;
    this.specialistFallbackManager = runtimeComposition.specialistFallback;
    this.runtimes = runtimeComposition.runtimes;
    this.runtimeCreationPromisesByAgentId = runtimeComposition.runtimeCreationPromisesByAgentId;
    this.runtimeTokensByAgentId = runtimeComposition.runtimeTokensByAgentId;
    const coreServices = createSwarmManagerCoreServices({
      state: {
        config: this.config,
        descriptors: this.descriptors,
        profiles: this.profiles,
        runtimes: this.runtimes,
        conversationEntriesByAgentId: this.conversationEntriesByAgentId,
        now: this.now,
      },
      foundation,
      descriptorStore: this.descriptorStore,
      directory: this.agentDirectory,
      logDebug: (message, details) => this.logDebug(message, details),
      managerBootstrap: {
        sendMessage: (fromAgentId, targetAgentId, message, delivery, sendOptions) =>
          this.sendMessage(fromAgentId, targetAgentId, message, delivery, sendOptions),
      },
      descriptorStoreAdapter: {},
      persistence: {
        resolveMemoryOwnerAgentId: (descriptor) =>
          this.memoryCoordinator.resolveMemoryOwnerAgentId(descriptor),
      },
      conversation: {
        onEntryPersisted: (id) => this.historySearchService.markAgentDirty(id),
        emitServerEvent: (eventName, payload) => {
          this.emit(eventName, payload);
          if (payload.type === "agent_tool_call") {
            this.eventCoordinator.emitSessionActiveToolsSnapshot(this.sessionActiveTools.recordToolCall(payload)); this.eventCoordinator.emitManagerToolActivityForToolCall(payload);
          }
        },
        getPinnedMessageIds: (agentId) => this.sessionPinCoordinator.getPinnedMessageIds(agentId),
      },
      sessionPlan: {
        emitSnapshot: (event) => this.emit("session_plan_snapshot", event),
        isWorkerActive: (workerId) => isWorkGraphWorkerActive(this.descriptors, workerId, this.agentMessageDispatcher?.readAssignment(workerId)),
      },
    });
    this.managerBootstrapCoordinator = coreServices.managerBootstrapCoordinator;
    this.descriptorStoreAdapter = coreServices.descriptorStoreAdapter;
    this.persistenceService = coreServices.persistenceService;
    this.conversationProjector = coreServices.conversationProjector;
    this.sessionPlanCoordinator = coreServices.sessionPlanCoordinator;
    this.compactionCoordinator = runtimeComposition.attachPlanning(this.sessionPlanCoordinator);
    this.codexDirectSidecarCoordinator = this.createCodexDirectSidecarCoordinator(options);
    this.codexPluginDelegationCoordinator = this.createCodexPluginDelegationCoordinator();
    this.configurationCoordinator = this.createConfigurationCoordinator();
    this.sessionMetaService = new SwarmSessionMetaService({
      dataDir: this.config.paths.dataDir,
      agentsStoreFile: this.config.paths.agentsStoreFile,
      descriptors: this.descriptors,
      getSortedDescriptors: () => this.agentDirectory.sortedDescriptors(),
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
      emitAgentsSnapshot: () => {
        this.eventCoordinator.emitAgentsSnapshot();
      },
      ensureSkillMetadataLoaded: () => this.skillMetadataService.ensureSkillMetadataLoaded(),
      getAdditionalSkillPaths: () => this.skillMetadataService.getAdditionalSkillPaths(),
      getAgentMemoryPath: (agentId) => this.memoryCoordinator.getAgentMemoryPath(agentId),
      resolveSystemPromptForDescriptor: (descriptor) => this.resolveSystemPromptForDescriptor(descriptor)
    });
    this.eventCoordinator = this.createEventCoordinator();
    this.inboundConversationAppender = this.createInboundConversationAppender();
    this.memoryMergeService = new SwarmMemoryMergeService({
      config: this.config,
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
      emitAgentsSnapshot: () => {
        this.eventCoordinator.emitAgentsSnapshot();
      },
      getRequiredSessionDescriptor: (agentId) => this.agentDirectory.getRequiredSessionDescriptor(agentId),
      upsertDescriptor: (descriptor) => this.descriptorStoreAdapter.upsertDescriptor(descriptor),
      getAgentMemoryPath: (agentId) => this.memoryCoordinator.getAgentMemoryPath(agentId),
      resolvePreferredManagerId: (options) => this.agentDirectory.resolvePreferredManagerId(options),
      resolvePromptWithFallback: (category, promptId, profileId, fallback) =>
        this.managerBootstrapCoordinator.resolvePromptWithFallback(category, promptId, profileId, fallback),
      ensureMemoryFilesForBoot: (options) => this.persistenceService.ensureMemoryFilesForBoot(options),
      ensureAgentMemoryFileInPersistence: (memoryFilePath, memoryTemplateContent) =>
        this.persistenceService.ensureAgentMemoryFile(memoryFilePath, memoryTemplateContent),
      readSessionMetaForDescriptor: (descriptor) =>
        this.memoryCoordinator.readSessionMetaForDescriptor(descriptor),
      writeSessionMemoryMergeAttemptMeta: (descriptor, attempt) =>
        this.memoryCoordinator.writeSessionMemoryMergeAttemptMeta(descriptor, attempt),
      recordSessionMemoryMergeAttempt: (descriptor, attempt) =>
        this.memoryCoordinator.recordSessionMemoryMergeAttempt(descriptor, attempt),
      appendSessionMemoryMergeAuditEntry: (entry) =>
        this.memoryCoordinator.appendSessionMemoryMergeAuditEntry(entry),
      refreshSessionMetaStatsBySessionId: (sessionAgentId) =>
        this.memoryCoordinator.refreshSessionMetaStatsBySessionId(sessionAgentId),
      saveStore: async () => {
        await this.descriptorStoreAdapter.saveStore();
      },
      runSessionMemoryLLMMerge: (descriptor, profileMemoryContent, sessionMemoryContent) =>
        this.executeSessionMemoryLLMMerge(descriptor, profileMemoryContent, sessionMemoryContent),
      getPiModelsJsonPath: () => this.configurationCoordinator.getPiModelsJsonPathOrThrow()
    });
    this.memoryCoordinator = this.createMemoryCoordinator(
      compactionRuntimeSettingsProvider,
      liveCompactionRuntimeSettingsProvider,
    );
    const sessionComposition = this.createSessionComposition(runtimeComposition);
    this.sessionProvisioner = sessionComposition.provisioner;
    this.archiveLastUsedHydrator = sessionComposition.archiveLastUsedHydrator;
    this.archiveService = sessionComposition.archiveService;
    this.sessionService = sessionComposition.sessionService;
    this.projectAgentSharingService = sessionComposition.projectAgentSharingService;
    this.projectAgentCoordinator = sessionComposition.projectAgentCoordinator;
    this.profileSessionBookkeepingCoordinator = new ProfileSessionBookkeepingCoordinator({
      dataDir: this.config.paths.dataDir,
      descriptors: this.descriptors,
      profiles: this.profiles,
      directory: this.agentDirectory,
      persistence: this.descriptorStoreAdapter,
      now: this.now,
      notifySharedTargetsChanged: (agentId) =>
        this.projectAgentCoordinator.notifySharedTargetsChanged(agentId),
      emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
      emitProfilesSnapshot: () => this.eventCoordinator.emitProfilesSnapshot(),
    });
    this.choiceService = this.createChoiceService();
    const completedRuntime = runtimeComposition.complete(
      {
        conversation: this.conversationProjector,
        configuration: this.configurationCoordinator,
        memory: this.memoryCoordinator,
        directory: this.agentDirectory,
        eventCoordinator: this.eventCoordinator,
        sessionMeta: this.sessionMetaService,
        choices: this.choiceService,
        provisioner: this.sessionProvisioner,
        sessionService: this.sessionService,
        archiveHydrator: this.archiveLastUsedHydrator,
        archive: this.archiveService,
        projectAgentService: sessionComposition.projectAgentService,
        projectAgents: this.projectAgentCoordinator,
        codexDirect: this.codexDirectSidecarCoordinator,
        codexPlugin: this.codexPluginDelegationCoordinator,
        promptRegistry: this.promptRegistry,
      },
      {
        interruptExternalThreadSidecarTurn: options?.interruptExternalThreadSidecarTurn,
        terminateExternalThreadSidecarTurn: options?.terminateExternalThreadSidecarTurn,
      },
    );
    this.turnContextCoordinator = completedRuntime.turnContext;
    this.sessionAttention = this.createSessionAttentionRuntime();
    this.runtimeLifecycleCoordinator = completedRuntime.runtimeLifecycle;
    this.lifecycleService = completedRuntime.lifecycle;
    this.projectExecutableTrustCoordinator = completedRuntime.projectExecutableTrust;
    this.sessionLifecycleCoordinator = completedRuntime.sessionLifecycle;
    this.bootCoordinator = completedRuntime.boot;
    this.sessionInteractionCoordinator = this.createSessionInteractionCoordinator();
    this.agentMessageDispatcher = this.createAgentMessageDispatcher(completedRuntime.goals);
    this.userMessageCoordinator = this.createUserMessageCoordinator(completedRuntime.goals);
    this.facadeServices = {
      secureSessions: this.secureSessionsService, interactions: this.sessionInteractionCoordinator,
      goals: completedRuntime.goals,
      sessions: this.sessionLifecycleCoordinator,
      pins: this.sessionPinCoordinator,
      projectAgents: this.projectAgentCoordinator,
      profileBookkeeping: this.profileSessionBookkeepingCoordinator,
      memory: this.memoryCoordinator,
      agents: this.lifecycleService,
      codexPlugin: this.codexPluginDelegationCoordinator,
      messages: this.agentMessageDispatcher,
      userMessages: this.userMessageCoordinator,
      boot: this.bootCoordinator,
      sessionAttention: this.sessionAttention.facade,
      recovery: this.restartRecoveryCoordinator,
      configuration: this.configurationCoordinator,
      registry: {
        directory: this.agentDirectory,
      },
      runtime: {
        controller: this.runtimeController,
        lifecycle: this.runtimeLifecycleCoordinator,
        specialists: this.specialistFallbackManager,
        turns: this.turnContextCoordinator,
        assistantOutput: this.assistantOutputRouter,
        activeTools: this.sessionActiveTools, managerToolActivity: this.managerToolActivity,
        runtimes: this.runtimes,
      },
      events: this.eventCoordinator,
      conversation: {
        history: this.historySearchService,
        projector: this.conversationProjector,
        sidebarPerf: this.sidebarPerfRecorder,
      },
      trust: this.projectExecutableTrustCoordinator,
      observability: this.observabilityCoordinator,
      persistence: this.conversationProjector,
      extensions: this.forgeExtensionHost,
      host: {
        config: this.config,
        setTerminalArchiveHooks: (hooks) => {
          this.terminalArchiveHooks = hooks;
        },
        logDebug: (message, details) => this.logDebug(message, details),
      },
    };
    this.setMaxListeners(SWARM_MANAGER_MAX_EVENT_LISTENERS);
  }
  protected getFacadeServices(): SwarmManagerFacadeServices { return this.facadeServices; }
  private createChoiceService(): SwarmChoiceService {
    return new SwarmChoiceService({
      now: this.now,
      getDescriptor: (agentId) => this.descriptors.get(agentId),
      emitChoiceRequest: (event) => this.eventCoordinator.emitChoiceRequest(event),
      emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
      reportAttentionAggregateChange: (agentId) => this.sessionAttention?.reportAggregateChange(agentId),
    });
  }
  private createSessionAttentionRuntime(): SessionAttentionRuntime {
    return new SessionAttentionRuntime({
      dataDir: this.config.paths.dataDir,
      descriptors: this.descriptors,
      profiles: this.profiles,
      workers: this.agentDirectory,
      choices: this.choiceService,
      turns: this.turnContextCoordinator,
      plans: this.sessionPlanCoordinator,
      onChange: ({ revision, attentions }) =>
        this.emit("session_attention_snapshot", { type: "session_attention_snapshot", revision, attentions }),
      log: (message, details) => this.logDebug(message, details),
    });
  }
  private createSecureSessionsService(foundation: SecureSessionsFoundation): SecureSessionsService {
    return new SecureSessionsService({
      ...foundation,
      getDescriptor: (agentId) => this.descriptors.get(agentId),
      listDescriptors: () => Array.from(this.descriptors.values()),
      listProfiles: () => this.agentDirectory.listProfiles(),
      hasProfile: (profileId) => this.profiles.has(profileId),
      updateProjectEnabled: (profileId, enabled) => this.configurationCoordinator.updateProjectSecureSessionsEnabled(profileId, enabled),
      isProfileArchived: (profileId) => Boolean(this.profiles.get(profileId)?.archivedAt),
      isSessionArchived: (agentId) => Boolean(this.descriptors.get(agentId)?.archivedAt),
      requireBuilderSession: (agentId) => this.agentDirectory.getRequiredSessionDescriptor(agentId),
      emitSnapshot: (event) => this.emit("secure_session_snapshot", event),
      emitCatalogChanged: (event) => this.emit("secure_secret_catalog_changed", event),
      applyModeRuntimeRecycle: (agentId) => this.projectExecutableTrustCoordinator.applyManagerRuntimeRecyclePolicy(agentId, "secure_session_mode_change"),
      hasUsableSecureRuntime: (agentId) => this.runtimeController.hasUsableSecureRuntime(agentId),
      sendAccessResultSteer: (fromAgentId, targetAgentId, message) =>
        this.sendMessage(fromAgentId, targetAgentId, message, "steer", { origin: "internal" }).then(() => undefined),
      logDebug: (message, details) => this.logDebug(message, details),
      now: this.now,
      getMaxProjectDefaults: () => this.secureSecretSettingsService.getMaxProjectDefaults(),
    });
  }
  private createSessionInteractionCoordinator(): SessionInteractionCoordinator {
    return new SessionInteractionCoordinator({
      withRuntimeAdmission: (agentId, operation) => this.runtimeController.withRuntimeAdmission(agentId, operation),
      descriptors: this.descriptors,
      directory: this.agentDirectory,
      plans: this.sessionPlanCoordinator,
      choices: this.choiceService,
      assistantOutput: this.assistantOutputRouter,
      runtimeOutput: {
        flushPreservedManagerAssistantOutputForTool: (agentId, toolName) =>
          this.runtimeController.flushPreservedManagerAssistantOutputForTool(agentId, toolName),
        markExplicitManagerAssistantOutput: (agentId) => this.runtimeController.markExplicitManagerAssistantOutput(agentId),
      },
      lifecycle: this.lifecycleService,
      sendMessage: (...args) => this.sendMessage(...args),
      codexPlugin: this.codexPluginDelegationCoordinator,
      turns: this.turnContextCoordinator,
      sessions: {
        createSession: (profileId, options) =>
          this.sessionLifecycleCoordinator.createSession(profileId, options),
      },
      events: {
        emitConversationMessage: (event) => this.eventCoordinator.emitConversationMessage(event),
        emitConversationReset: (agentId, reason) =>
          this.eventCoordinator.emitConversationReset(agentId, reason),
        markSessionActivity: (agentId, timestamp) =>
          this.eventCoordinator.markSessionActivity(agentId, timestamp),
      },
      recordToolSideEffect: (agentId, event) => this.observabilityCoordinator.recordToolSideEffect(agentId, event),
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
    });
  }
  private createRuntimeComposition(): ReturnType<typeof createSwarmManagerRuntimeComposition> {
    return createSwarmManagerRuntimeComposition({
      attention: createLazySessionAttentionRuntimeHooks(() => this.sessionAttention),
      state: {
        config: this.config,
        descriptors: this.descriptors,
        profiles: this.profiles,
        runtimeRecoveryState: this.runtimeRecoveryState,
        now: this.now,
      },
      foundation: {
        forgeExtensionHost: this.forgeExtensionHost,
        sessionPins: this.sessionPinCoordinator,
        secrets: this.secretsEnvService,
        observability: this.observabilityCoordinator,
      },
      toolHost: this,
      browserAutomation: this.browserAutomationService,
      secureSessions: createSecureSessionLifecyclePort(this.secureSessionsService),
      descriptors: {
        upsertDescriptor: (descriptor) =>
          this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor),
        deleteDescriptor: (agentId) =>
          this.descriptorStoreAdapter.deleteDescriptorInLiveMaps(agentId),
        upsertProfile: (profile) =>
          this.descriptorStoreAdapter.upsertProfileInLiveMaps(profile),
        deleteProfile: (profileId) =>
          this.descriptorStoreAdapter.deleteProfileInLiveMaps(profileId),
        patchDescriptor: (agentId, descriptorPatch) =>
          this.descriptorStoreAdapter.patchDescriptor(agentId, descriptorPatch),
        patchDescriptorFromRuntimeStatus: (agentId, descriptorPatch) =>
          this.patchDescriptorFromRuntimeStatus(agentId, descriptorPatch),
        transactionPatchDescriptor: (agentId, descriptorPatch, transactionOptions) =>
          this.descriptorStoreAdapter.transactionDescriptors(
            (store) => store.patchDescriptor(agentId, descriptorPatch),
            transactionOptions,
          ),
        patchDescriptorInLiveMaps: (agentId, descriptorPatch) =>
          this.descriptorStoreAdapter.patchDescriptorInLiveMaps(agentId, descriptorPatch),
      },
      events: {
        emitConversationMessage: (event) => this.eventCoordinator.emitConversationMessage(event),
        markSessionActivity: (agentId, timestamp) =>
          this.eventCoordinator.markSessionActivity(agentId, timestamp),
        emitStatus: (agentId, status, pendingCount, contextUsage) =>
          this.eventCoordinator.emitStatus(agentId, status, pendingCount, contextUsage),
        emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
        emitSessionWorkersSnapshot: (sessionAgentId, workers) => this.eventCoordinator.emitSessionWorkersSnapshot(sessionAgentId, workers),
        emitProfilesSnapshot: () => this.eventCoordinator.emitProfilesSnapshot(),
        emitSessionLifecycle: (event) => this.eventCoordinator.emitSessionLifecycle(event),
        emitSessionGoalSnapshot: (event) => this.emit("session_goal_snapshot", event),
        emitSessionActiveToolsSnapshot: (snapshot) => this.eventCoordinator.emitSessionActiveToolsSnapshot(snapshot),
        clearSessionActiveTools: (agentId) => this.sessionActiveTools.clearSession(agentId),
        activateManagerToolActivity: (agentId, turnId) => this.eventCoordinator.activateManagerToolActivity(agentId, turnId),
        clearManagerToolActivity: (agentId) => this.eventCoordinator.clearManagerToolActivity(agentId), saveStore: () => this.descriptorStoreAdapter.saveStore(),
        emitModelCacheObservation: (event) =>
          this.eventCoordinator.emitModelCacheObservation(event),
        // Deliberately direct: count-only throughput must not enter the
        // conversation projector.
        emitGenerationThroughput: (event) => this.emit("generation_throughput", event),
        onHistorySourceChanged: (id) => this.historySearchService.markAgentDirty(id), emitGenerationMeasurementTerminalPersisted: (record) =>
          this.emit("generation_measurement_terminal_persisted", record),
        logDebug: (message, details) => this.logDebug(message, details),
      },
      messaging: {
        getConversationHistory: (agentId) => this.getConversationHistory(agentId),
        sendMessage: (fromAgentId, targetAgentId, message, delivery, sendOptions) =>
          this.sendMessage(fromAgentId, targetAgentId, message, delivery, sendOptions),
        sendWorkerResult: (workerAgentId, resultText, expectedAssignmentId) =>
          this.sendWorkerResult(workerAgentId, resultText, expectedAssignmentId),
        publishToUser: (agentId, text, source) => this.publishToUser(agentId, text, source),
        terminateDescriptor: (descriptor, terminateOptions) =>
          this.terminateDescriptor(descriptor, terminateOptions),
        sendManagerBootstrapMessage: (managerId) =>
          this.managerBootstrapCoordinator.sendManagerBootstrapMessage(managerId),
      },
      runtimeResources: {
        getPiModelsJsonPath: () => this.configurationCoordinator.getPiModelsJsonPathOrThrow(),
        getMemoryRuntimeResources: (descriptor) => this.getMemoryRuntimeResources(descriptor),
        getSwarmContextFiles: (cwd) => this.getSwarmContextFiles(cwd),
        resolveAndValidateCwd: (cwd) => this.configurationCoordinator.resolveAndValidateCwd(cwd),
        ensureSessionFileParentDirectory: (sessionFile) =>
          this.persistenceService.ensureSessionFileParentDirectory(sessionFile),
        ensureDirectories: () => this.persistenceService.ensureDirectories(),
        loadStore: () => this.descriptorStoreAdapter.loadStore(),
        loadSecrets: () => this.configurationCoordinator.loadSecretsStore(),
        loadSecureSecretSettings: () => this.secureSecretSettingsService.load(),
        reloadSkillMetadata: () => this.configurationCoordinator.reloadSkillMetadata(),
        reloadModelCatalog: () =>
          this.configurationCoordinator.reloadModelCatalogOverridesAndProjection(),
        preloadSessionPlanStates: () => this.sessionInteractionCoordinator.preloadSessionPlanStates(),
        deleteManagerSchedulesFile: (profileId) => this.persistenceService.deleteManagerSchedulesFile(profileId),
        getOrCreateRuntimeForDescriptor: (descriptor) =>
          this.getOrCreateRuntimeForDescriptor(descriptor),
      },
      runtimeFactory: { createRuntimeForDescriptor: (...args) => this.createRuntimeForDescriptor(...args) },
      resolution: {
        resolvePromptWithFallback: (category, promptId, profileId, fallback) =>
          this.managerBootstrapCoordinator.resolvePromptWithFallback(
            category,
            promptId,
            profileId,
            fallback,
          ),
        resolveSpecialistRosterForProfile: (profileId) =>
          this.configurationCoordinator.resolveSpecialistRosterForProfile(profileId),
        resolveSpecialistRosterForManager: (manager) =>
          this.configurationCoordinator.resolveSpecialistRosterForManager(manager),
        resolveSpawnModelWithCapacityFallback: (model) =>
          this.resolveSpawnModelWithCapacityFallback(model),
        resolveSpawnWorkerArchetypeId: (input, normalizedAgentId, profileId) =>
          this.configurationCoordinator.resolveSpawnWorkerArchetypeId(
            input,
            normalizedAgentId,
            profileId,
          ),
        normalizeSpecialistHandle: async (value) => {
          const registry = await this.configurationCoordinator.loadSpecialistRegistryModule();
          return registry.normalizeSpecialistHandle(value) || undefined;
        },
        resolveSystemPromptForDescriptor: (descriptor) =>
          this.configurationCoordinator.resolveSystemPromptForDescriptor(descriptor),
        injectWorkerIdentityContext: (descriptor, systemPrompt) =>
          this.configurationCoordinator.injectWorkerIdentityContext(descriptor, systemPrompt),
        resolveDefaultModelDescriptor: () =>
          this.configurationCoordinator.resolveDefaultModelDescriptor(),
      },
      sessions: {
        materializeSortOrder: () =>
          this.profileSessionBookkeepingCoordinator.materializeProfileSortOrder(),
        deleteConversationHistory: (agentId, sessionFile) =>
          this.conversationProjector.deleteConversationHistory(agentId, sessionFile),
        assertExternalProjectAgentCapability: (agentId, capability) =>
          this.sessionInteractionCoordinator.assertExternalProjectAgentTurnCapabilityAllowed(
            agentId,
            capability,
          ),
        getTerminalArchiveHooks: () => this.terminalArchiveHooks,
      },
    });
  }
  respondToCodexElicitation(input: {
    elicitationId: string; managerAgentId: string;
    decision: "allow" | "deny" | "cancel";
    values?: Record<string, unknown>;
    persistScope?: "session" | "always";
  }): boolean {
    return this.codexDirectSidecarCoordinator.respondToElicitation(input);
  }
  getCodexElicitationUrl(input: { managerAgentId: string; elicitationId: string; generation: string }) { return this.codexDirectSidecarCoordinator.getElicitationUrl(input); }
  getPendingCodexElicitationsForManager(managerAgentId: string) {
    return this.codexDirectSidecarCoordinator.getPendingElicitationsForManager(managerAgentId);
  }
  private createCodexDirectSidecarCoordinator(
    options?: SwarmManagerOptions,
  ): CodexDirectSidecarCoordinator {
    return new CodexDirectSidecarCoordinator({
      dataDir: this.config.paths.dataDir,
      codexAppServerService: options?.codexAppServerService,
      codexAppServerServiceOptions: options?.codexAppServerServiceOptions,
      host: {
        now: this.now,
        logDebug: (message, details) => this.logDebug(message, details),
        getDescriptor: (agentId) => this.descriptors.get(agentId),
        upsertDescriptor: (descriptor) =>
          this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor),
        saveStore: () => this.descriptorStoreAdapter.saveStore(),
        ensureSessionFileParentDirectory: (sessionFile) =>
          mkdir(dirname(sessionFile), { recursive: true }).then(() => undefined),
        emitConversationMessage: (event) => this.eventCoordinator.emitConversationMessage(event),
        emitConversationLog: (event) => this.conversationProjector.emitConversationLog(event),
        emitAgentMessage: (event) => this.eventCoordinator.emitAgentMessage(event),
        emitAgentToolCall: (event) => this.conversationProjector.emitAgentToolCall(event),
        emitStatus: (agentId, status, pendingCount) =>
          this.eventCoordinator.emitStatus(agentId, status, pendingCount),
        reportAttentionStatusTransition: (input) => this.sessionAttention.reportStatusTransition(input),
        emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
        emitProfilesSnapshot: () => this.eventCoordinator.emitProfilesSnapshot(),
        listWorkersForSession: (agentId) => this.agentDirectory.getWorkersForManager(agentId),
        listSessionsForProfile: (profileId) => this.agentDirectory.getSessionsForProfile(profileId),
        scheduleProjectExecutableTrustPrompt: (manager) =>
          this.scheduleFacadeProjectExecutableTrustPrompt(manager),
        markSessionActivity: (agentId, timestamp) =>
          this.eventCoordinator.markSessionActivity(agentId, timestamp),
        markSessionUserMessageActivity: (agentId, timestamp) =>
          this.eventCoordinator.markSessionUserMessageActivity(agentId, timestamp),
        emitCodexElicitation: (event) => this.eventCoordinator.emitCodexElicitation({
          type: "codex_elicitation_request",
          elicitationId: event.elicitationId,
          agentId: event.managerAgentId,
          sidecarAgentId: event.sidecarAgentId,
          mode: event.mode,
          ...(event.title ? { title: event.title } : {}),
          message: event.message,
          ...(event.fields ? { fields: event.fields } : {}),
          ...(event.urlOrigin ? { urlOrigin: event.urlOrigin } : {}),
          persistScopes: event.persistScopes,
        }),
        dismissCodexElicitation: (elicitationId, managerAgentId) =>
          this.eventCoordinator.dismissCodexElicitation({
            type: "codex_elicitation_dismissed",
            elicitationId,
            agentId: managerAgentId,
          }),
      },
    });
  }
  private createEventCoordinator(): SwarmEventCoordinator {
    return new SwarmEventCoordinator({
      host: {
        emit: (eventName, event) => {
          this.emit(eventName, event);
        },
        getDescriptor: (agentId) => this.descriptors.get(agentId),
        getRuntime: (agentId) => this.runtimes.get(agentId),
        listManagerAgents: () => this.agentDirectory.listManagerAgents(),
        listProfiles: () => this.agentDirectory.listProfiles(),
        upsertDescriptor: (descriptor) =>
          this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor),
      },
      conversationProjector: this.conversationProjector, history: this.historySearchService,
      observability: this.observabilityCoordinator,
      sessionActiveTools: this.sessionActiveTools, managerToolActivity: this.managerToolActivity,
      now: this.now,
    });
  }
  private createAgentDirectory(): AgentDirectory {
    return new AgentDirectory({
      descriptors: this.descriptors,
      profiles: this.profiles,
      configuredManagerId: this.config.managerId,
      getPendingChoiceCount: (agentId) => this.choiceService.getPendingChoiceIdsForSession(agentId).length,
    });
  }
  private createConfigurationCoordinator(): SwarmConfigurationCoordinator {
    const secureSessions = this.secureSessionsService;
    return new SwarmConfigurationCoordinator({
      config: this.config,
      defaultModelPreset: this.defaultModelPreset,
      descriptors: this.descriptors,
      profiles: this.profiles,
      promptRegistry: this.promptRegistry,
      skillMetadataService: this.skillMetadataService,
      skillFileService: this.skillFileService,
      secretsEnvService: this.secretsEnvService,
      secureSessions: {
        hasActiveSession: (agentId) => secureSessions.getSecureRuntimeBinding(this.descriptors.get(agentId)!) !== undefined,
        stopForLifecycle: (agentId) => secureSessions.stopSecureSessionForLifecycle(agentId),
        beginLifecycleFence: (profileId, sessionAgentIds) => secureSessions.beginSecureSessionLifecycleFence(profileId, sessionAgentIds),
        cancelLifecycleFence: (fenceId) => secureSessions.cancelSecureSessionLifecycleFence(fenceId),
        completeLifecycleFence: (fenceId, outcome) => secureSessions.completeSecureSessionLifecycleFence(fenceId, outcome),
      },
      sessions: {
        getSessionsForProfile: (profileId) => this.agentDirectory.getSessionsForProfile(profileId),
        getAllManagerSessions: () => Array.from(this.descriptors.values()).filter(
          (descriptor): descriptor is AgentDescriptor & { role: "manager"; profileId: string } =>
            this.agentDirectory.isSessionAgent(descriptor),
        ),
        getSessionById: (agentId) => {
          const descriptor = this.descriptors.get(agentId);
          return this.agentDirectory.isSessionAgent(descriptor) ? descriptor : undefined;
        },
      },
      access: {
        assertManagerSettingsTargetNotArchived: (managerId) =>
          this.agentDirectory.assertManagerSettingsTargetNotArchived(managerId),
        assertProfileNotArchived: (profileId) => this.agentDirectory.assertProfileNotArchived(profileId),
        getRequiredSessionDescriptor: (agentId) => this.agentDirectory.getRequiredSessionDescriptor(agentId),
        assertDescriptorNotEffectivelyArchived: (descriptor) => this.agentDirectory.assertDescriptorNotEffectivelyArchived(descriptor),
      },
      persistence: {
        transactionDescriptors: (callback) =>
          this.descriptorStoreAdapter.transactionDescriptors(callback),
        saveStore: () => this.descriptorStoreAdapter.saveStore(),
        emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
        emitProfilesSnapshot: () => this.eventCoordinator.emitProfilesSnapshot(),
      },
      prompt: {
        getAgentMemoryPath: (agentId) =>
          this.memoryCoordinator.getAgentMemoryPath(agentId),
        ensureAgentMemoryFile: (memoryFilePath, profileId) =>
          this.memoryCoordinator.ensureAgentMemoryFile(memoryFilePath, profileId),
        resolveMemoryOwnerAgentId: (descriptor) =>
          this.memoryCoordinator.resolveMemoryOwnerAgentId(descriptor),
        resolveSessionProfileId: (memoryOwnerAgentId) =>
          this.memoryCoordinator.resolveSessionProfileId(memoryOwnerAgentId),
        refreshSessionMetaStats: (descriptor) =>
          this.memoryCoordinator.refreshSessionMetaStats(descriptor),
        refreshSessionMetaStatsBySessionId: (sessionAgentId) =>
          this.memoryCoordinator.refreshSessionMetaStatsBySessionId(sessionAgentId),
        getExternalProjectAgentDirectoryEntries: (profileId) =>
          this.projectAgentCoordinator.getExternalDirectory(profileId),
      },
      applySpecialistAvailability: (roster, managerAgentId) =>
        this.codexPluginDelegationCoordinator.applySpecialistAvailability(roster, managerAgentId),
      applyManagerRuntimeRecyclePolicy: (agentId, reason) =>
        this.projectExecutableTrustCoordinator.applyManagerRuntimeRecyclePolicy(agentId, reason),
      switchProviderContext: async (agentId,model) => { if(!this.lineage) throw new Error("Durable context transfer owner is unavailable");await this.lineage.switchContext(agentId,model); },
      canUseSecureModel: (model) => supportsSecureRuntimeProvider(model.provider),
      emitModelChangeNotice: (agentId, sourceModel, targetModel) =>
        this.conversationProjector.emitConversationMessage(createModelChangeNoticeEvent(agentId, sourceModel, targetModel, this.now())),
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
    });
  }
  private createMemoryCoordinator(
    runtimeProvider: CompactionRuntimeSettingsProvider,
    liveProvider: ReturnType<typeof createLiveCompactionRuntimeSettingsProvider>,
  ): MemoryCoordinator {
    return new MemoryCoordinator({
      config: this.config,
      descriptors: this.descriptors,
      services: {
        compaction: this.compactionCoordinator,
        memory: this.memoryMergeService,
        sessionMeta: this.sessionMetaService,
      },
      compactionSettings: {
        runtimeProvider,
        liveProvider,
        getProviderAvailability: () =>
          getManagedModelProviderCredentialAvailability(this.config, {
            credentialPoolService: this.getCredentialPoolService(),
          }),
      },
      sessions: {
        requireBuilderSession: (agentId) =>
          this.agentDirectory.getRequiredSessionDescriptor(agentId),
        assertMutable: (descriptor) => this.agentDirectory.assertDescriptorNotEffectivelyArchived(descriptor),
        resolvePreferredManagerId: (options) => this.agentDirectory.resolvePreferredManagerId(options),
      },
      sortedProfiles: () => this.agentDirectory.sortedProfiles(),
      resolvePromptWithFallback: (category, promptId, profileId, fallback) =>
        this.managerBootstrapCoordinator.resolvePromptWithFallback(category, promptId, profileId, fallback),
      now: this.now,
    });
  }
  private createSessionComposition(runtimeComposition: ReturnType<typeof createSwarmManagerRuntimeComposition>): ReturnType<typeof createSwarmManagerSessionComposition> {
    return createSwarmManagerSessionComposition({
      state: {
        config: this.config,
        descriptors: this.descriptors,
        profiles: this.profiles,
        runtimes: this.runtimes,
        now: this.now,
      },
      services: {
        directory: this.agentDirectory,
        descriptorFactory: this.sessionDescriptorFactory,
        pins: this.sessionPinCoordinator,
        conversations: this.conversationProjector,
        history: this.historySearchService,
      },
      provisioner: {
        descriptorMutations: {
          upsertDescriptor: (descriptor) =>
            this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor),
          deleteDescriptor: (agentId) =>
            this.descriptorStoreAdapter.deleteDescriptorInLiveMaps(agentId),
          upsertProfile: (profile) =>
            this.descriptorStoreAdapter.upsertProfileInLiveMaps(profile),
          deleteProfile: (profileId) =>
            this.descriptorStoreAdapter.deleteProfileInLiveMaps(profileId),
        },
        ensureProfilePiDirectories: (profileId) => this.persistenceService.ensureProfilePiDirectories(profileId),
        ensureSessionFileParentDirectory: (sessionFile) =>
          this.persistenceService.ensureSessionFileParentDirectory(sessionFile),
        ensureAgentMemoryFile: (memoryFilePath, profileId) =>
          this.memoryCoordinator.ensureAgentMemoryFile(memoryFilePath, profileId),
        getAgentMemoryPath: (agentId) =>
          this.memoryCoordinator.getAgentMemoryPath(agentId),
        writeInitialSessionMeta: (descriptor) =>
          this.memoryCoordinator.writeInitialSessionMeta(descriptor),
        runRuntimeShutdown: (descriptor, action, options) =>
          this.runtimeLifecycleCoordinator.runRuntimeShutdown(descriptor, action, options),
        detachRuntime: (agentId, runtimeToken) =>
          this.runtimeLifecycleCoordinator.detachRuntime(agentId, runtimeToken),
        clearAgentTurnState: (agentId) =>
          this.runtimeLifecycleCoordinator.clearAgentState(agentId),
        deleteManagerSessionFile: (sessionFile) => this.persistenceService.deleteManagerSessionFile(sessionFile),
        logDebug: (message, details) => this.logDebug(message, details),
      },
      sessions: {
        getRequiredSessionDescriptor: (agentId) =>
          this.agentDirectory.getRequiredSessionDescriptor(agentId),
        getOrCreateRuntimeForDescriptor: (descriptor) =>
          this.getOrCreateRuntimeForDescriptor(descriptor),
        stopSessionInternal: (agentId, options) => this.stopSessionInternal(agentId, options),
        withRuntimeShutdownBarrier: (agentId, operation) => this.runtimeController.withRuntimeShutdownBarrier(agentId, operation),
        assertSessionIsDeletable: (descriptor) =>
          this.agentDirectory.assertSessionIsDeletable(descriptor),
        saveStore: () => this.descriptorStoreAdapter.saveStore(),
        writeInitialSessionMeta: (descriptor) =>
          this.memoryCoordinator.writeInitialSessionMeta(descriptor),
        notifyProjectAgentsChanged: (profileId) => this.notifyProjectAgentsChanged(profileId),
        emitSessionLifecycle: (event) => this.eventCoordinator.emitSessionLifecycle(event),
        emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
        emitProfilesSnapshot: () => this.eventCoordinator.emitProfilesSnapshot(),
        emitConversationReset: (agentId, source) =>
          this.eventCoordinator.emitConversationReset(agentId, source as "api_reset"),
        injectAgentCreatorContext: (agentId, profileId) =>
          this.managerBootstrapCoordinator.injectAgentCreatorContext(agentId, profileId),
        cancelAllPendingChoicesForAgent: (agentId) =>
          this.sessionInteractionCoordinator.cancelAllPendingChoicesForAgent(agentId),
        clearPinsForConversationReset: (descriptor) =>
          this.sessionPinCoordinator.clearForConversationReset(descriptor),
        captureSessionRuntimePromptMeta: (descriptor, resolvedSystemPrompt) =>
          this.memoryCoordinator.captureSessionRuntimePromptMeta(
            descriptor,
            resolvedSystemPrompt,
          ),
        appendSessionRenameHistoryEntry: (descriptor, entry) =>
          this.profileSessionBookkeepingCoordinator.appendSessionRenameHistoryEntry(
            descriptor,
            entry,
          ),
        clearSessionPlan: async (descriptor) => { await this.sessionPlanCoordinator.clear(descriptor); },
        clearSessionGoal: async (descriptor) => { await runtimeComposition.goals.clear(descriptor); },
        copySecureAccessForFork: (sourceId, forkId) => this.secureSessionsService.copySecureSessionAccessForFork(sourceId, forkId),
        writeForkedSessionMemoryHeader: (sourceDescriptor, forkedAgentId, fromMessageId) =>
          this.memoryCoordinator.writeForkedSessionMemoryHeader(
            sourceDescriptor,
            forkedAgentId,
            fromMessageId,
          ),
        logDebug: (message, details) => this.logDebug(message, details),
        now: this.now,
      },
      projectAgents: {
        getRequiredSessionDescriptor: (agentId) =>
          this.agentDirectory.getRequiredSessionDescriptor(agentId),
        assertSessionSupportsProjectAgent: (descriptor) =>
          this.agentDirectory.assertSessionSupportsProjectAgent(descriptor),
        getOrCreateRuntimeForDescriptor: (descriptor) =>
          this.getOrCreateRuntimeForDescriptor(descriptor),
        upsertDescriptorInLiveMaps: (descriptor) =>
          this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor),
        captureSessionRuntimePromptMeta: (descriptor, resolvedSystemPrompt) =>
          this.memoryCoordinator.captureSessionRuntimePromptMeta(
            descriptor,
            resolvedSystemPrompt,
          ),
        saveStore: () => this.descriptorStoreAdapter.saveStore(),
        emitSessionLifecycle: (event) => this.eventCoordinator.emitSessionLifecycle(event),
        emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
        emitProfilesSnapshot: () => this.eventCoordinator.emitProfilesSnapshot(),
        emitSessionProjectAgentUpdated: (agentId, profileId, projectAgent) =>
          this.eventCoordinator.emitSessionProjectAgentUpdated(agentId, profileId, projectAgent),
        notifyProjectAgentsChanged: (profileId) => this.notifyProjectAgentsChanged(profileId),
        logDebug: (message, details) => this.logDebug(message, details),
      },
      sharing: {
        logDebug: (message, details) => this.logDebug(message, details),
      },
      projectAgentWorkflows: {
        access: {
          getRequiredBuilderSession: (agentId) =>
            this.agentDirectory.getRequiredSessionDescriptor(agentId),
          assertDescriptorNotEffectivelyArchived: (descriptor) =>
            this.agentDirectory.assertDescriptorNotEffectivelyArchived(descriptor),
          assertSessionSupportsProjectAgent: (descriptor) =>
            this.agentDirectory.assertSessionSupportsProjectAgent(descriptor),
        },
        prompt: {
          getConversationHistory: (agentId) => this.getConversationHistory(agentId),
          buildResolvedManagerPrompt: (descriptor, options) =>
            this.configurationCoordinator.buildResolvedManagerPrompt(descriptor, options),
          resolveLiveSystemPrompt: (descriptor) =>
            this.configurationCoordinator.resolveSystemPromptForDescriptor(descriptor),
          readPersistedSystemPrompt: (descriptor) =>
            this.sessionMetaService.readSessionMetaForDescriptor(descriptor).then(
              (meta) => meta?.resolvedSystemPrompt ?? null,
            ),
        },
        runtime: {
          hasRuntime: (agentId) => this.runtimes.has(agentId),
          recycleManager: (agentId, reason) =>
            this.applyFacadeManagerRuntimeRecyclePolicy(agentId, reason),
        },
        persistence: {
          upsertDescriptorInLiveMaps: (descriptor) =>
            this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor),
          saveStore: () => this.descriptorStoreAdapter.saveStore(),
        },
        events: {
          emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
          emitSessionProjectAgentUpdated: (agentId, profileId, projectAgent) =>
            this.eventCoordinator.emitSessionProjectAgentUpdated(agentId, profileId, projectAgent),
        },
        notifyProjectAgentsChanged: (profileId) => this.notifyProjectAgentsChanged(profileId),
        listSessionsForProfile: (profileId) =>
          this.agentDirectory.getSessionsForProfile(profileId),
        getPiModelsJsonPath: () => this.configurationCoordinator.getPiModelsJsonPathOrThrow(),
        logDebug: (message, details) => this.logDebug(message, details),
      },
      archive: {
        hydration: {
          patchDescriptor: (agentId, patch) =>
            this.descriptorStoreAdapter.patchDescriptor(agentId, patch),
          warn: (message, details) => this.logDebug(message, details),
        },
        operations: {
          patchDescriptor: (agentId, patch) =>
            this.descriptorStoreAdapter.patchDescriptor(agentId, patch),
          patchProfile: (profileId, patch) =>
            this.descriptorStoreAdapter.patchProfile(profileId, patch),
          stopSessionForArchive: (agentId) =>
            this.stopSessionInternal(agentId, {
              saveStore: true,
              emitSnapshots: true,
              manualStopNotice: false,
              taskLifecycle: "none",
            }),
          onProfileArchiveStopError: (agentId, error) =>
            this.logDebug("archive:profile_stop_session:error", {
              agentId,
              error: error instanceof Error ? error.message : String(error),
            }),
        },
      },
    });
  }
  private createAgentMessageDispatcher(goals: ReturnType<typeof createSwarmManagerRuntimeComposition>["goals"]): AgentMessageDispatcher<CodexMcpToolGateEvaluation> {
    return new AgentMessageDispatcher({
      resolveWorkerAssignmentSelection: (worker,secure) => this.lifecycleService.resolveWorkerAssignmentSelection(worker,secure),
      getConversationHistory: (agentId) => this.getConversationHistory(agentId),
      descriptors: this.descriptors,
      profiles: this.profiles,
      assertMutable: (descriptor) => this.agentDirectory.assertDescriptorNotEffectivelyArchived(descriptor),
      attachments: this.conversationAttachmentService,
      turns: this.turnContextCoordinator,
      output: this.assistantOutputRouter,
      observability: this.observabilityCoordinator,
      plans: {
        resolveAssignment: (owner, requestedStep) =>
          this.sessionPlanCoordinator.resolveAssignment(owner, requestedStep),
        appendToManagerInput: (owner, text) =>
          this.sessionPlanCoordinator.appendToManagerInput(owner, text),
        recordWorkerAssignment: (owner, assignment, input) =>
          this.sessionPlanCoordinator.recordWorkerAssignment(owner, assignment, input),
      },
      goals: { appendToManagerInput: (owner, text) => goals.appendToManagerInput(owner, text) },
      delegation: { appendToManagerInput: (owner, text) => this.configurationCoordinator.appendDelegationRosterModelContext(owner, text) },
      projectAgents: {
        authorizeExternalDelivery: (input) => this.projectAgentSharingService.authorizeExternalDelivery(input),
        recordExternalContact: (sourceAgentId, targetProfileId, targetSessionAgentId) =>
          this.projectAgentSharingService.recordExternalContact(
            sourceAgentId,
            targetProfileId,
            targetSessionAgentId,
          ),
        assertRepoSourceAvailable: (descriptor) =>
          this.projectAgentCoordinator.assertRepoSourceAvailableForExternalDelivery(descriptor),
        rateLimitBuckets: this.projectAgentMessageTimestampsBySender,
      },
      codex: {
        assertWorkerDeliveryAllowed: (sender, target, options) =>
          this.codexPluginDelegationCoordinator.assertWorkerDeliveryAllowed(sender, target, {
            origin: options?.origin,
            hasAttachments:
              this.conversationAttachmentService.normalize(options?.attachments).length > 0,
          }),
        buildProjectAgentTurnGate: (target, message) =>
          this.codexPluginDelegationCoordinator.buildTurnGate(
            target,
            { channel: "web" },
            message,
            { kind: "none" },
            "project_agent_input",
          ),
      },
      secureWorkers: createSecureSessionLifecyclePort(
        this.secureSessionsService,
      ),
      appendProjectAgentConversation: (target, payload) =>
        this.inboundConversationAppender.appendProjectAgentConversation(target, payload),
      emitAgentMessage: (event) => this.eventCoordinator.emitAgentMessage(event),
      saveStore: () => this.descriptorStoreAdapter.saveStore(),
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
    });
  }
  private createInboundConversationAppender(): InboundConversationAppender {
    return new InboundConversationAppender({
      attachments: this.conversationAttachmentService,
      events: this.eventCoordinator,
      now: this.now,
    });
  }
  private createUserMessageCoordinator(goals: ReturnType<typeof createSwarmManagerRuntimeComposition>["goals"]): UserMessageCoordinator {
    return new UserMessageCoordinator({
      targeting: {
        descriptors: this.descriptors,
        resolvePreferredManagerId: () => this.agentDirectory.resolvePreferredManagerId(),
        assertDescriptorNotEffectivelyArchived: (descriptor) =>
          this.agentDirectory.assertDescriptorNotEffectivelyArchived(descriptor),
        getConversationHistory: (agentId) => this.getConversationHistory(agentId),
      },
      runtime: {
        recoverStoppedSession: (agentId) => this.sessionLifecycleCoordinator.resumeStoppedSessionForUserInput(agentId),
        executableTrust: this.projectExecutableTrustCoordinator,
        withRuntimeAdmission: this.runtimeController.withRuntimeAdmission.bind(this.runtimeController),
        getOrCreateRuntime: (descriptor) => this.getOrCreateRuntimeForDescriptor(descriptor),
      },
      attachments: this.conversationAttachmentService,
      inboundConversation: this.inboundConversationAppender,
      agentMessages: this.agentMessageDispatcher,
      assistantOutput: this.assistantOutputRouter,
      codex: {
        direct: this.codexDirectSidecarCoordinator,
        plugin: this.codexPluginDelegationCoordinator,
      },
      memory: this.memoryCoordinator,
      projectAgents: this.projectAgentCoordinator,
      sessionReferences: { descriptors: this.descriptors, profiles: this.profiles, saveStore: () => this.descriptorStoreAdapter.saveStore() },
      goals,
      turns: this.turnContextCoordinator,
      observability: this.observabilityCoordinator,
      events: this.eventCoordinator,
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
    });
  }
  private createCodexPluginDelegationCoordinator(): CodexPluginDelegationCoordinator {
    return new CodexPluginDelegationCoordinator({
      appServer: this.codexDirectSidecarCoordinator.appServerService,
      host: {
        getDescriptor: (agentId) => this.descriptors.get(agentId),
        listDescriptors: () => this.descriptors.values(),
        assertDescriptorNotArchived: (descriptor) =>
          this.agentDirectory.assertDescriptorNotEffectivelyArchived(descriptor),
        assertMentionRoutingAvailable: (manager) =>
          this.codexDirectSidecarCoordinator.assertMentionRoutingAvailable(
            manager as CodexDirectSidecarManager,
          ),
        spawnAgent: (managerAgentId, input) =>
          this.lifecycleService.spawnAgent(managerAgentId, input),
        sendInitialTask: ({ managerAgentId, workerAgentId, message, planStep }) =>
          this.sendMessage(managerAgentId, workerAgentId, message, "auto", {
            origin: "internal",
            internalDeliveryKind: "codex_plugin_bootstrap",
            ...(planStep ? { planStep } : {}),
            planAssignmentSource: "spawn_agent",
          }).then(() => undefined),
        getSessionDir: (descriptor) => this.getFacadeSessionDirForDescriptor(descriptor),
        now: this.now,
        logDebug: (event, details) => this.logDebug(event, details),
      },
    });
  }
  private async stopSessionInternal(
    agentId: string,
    options: AgentLifecycleStopSessionOptions
  ): Promise<{ terminatedWorkerIds: string[]; unsafeShutdownAgentIds: string[] }> {
    return this.lifecycleService.stopSessionInternal(agentId, options);
  }
  getSecureSecretSettingsService(): SecureSecretSettingsService { return this.secureSecretSettingsService; }

  private logDebug(message: string, details?: unknown, config = this.config): void {
    if (!config.debug) return;
    const prefix = `[swarm][${this.now()}] ${message}`;
    if (details === undefined) console.log(prefix);
    else console.log(prefix, details);
  }
  private async getOrCreateRuntimeForDescriptor(descriptor: AgentDescriptor, requirements?: RuntimeAcquisitionRequirements): Promise<SwarmAgentRuntime> {
    this.agentDirectory.assertDescriptorNotEffectivelyArchived(descriptor);
    if (descriptor.role === "manager") {
      await this.applyFacadePendingManagerRuntimeRecycleBeforeRuntimeUse(
        descriptor as AgentDescriptor & { role: "manager" },
      );
    }
    await this.projectAgentCoordinator.preflightRuntime(descriptor);
    return this.lifecycleService.getOrCreateRuntimeForDescriptor(descriptor, requirements);
  }
  private resolveSpawnModelWithCapacityFallback(model: AgentModelDescriptor): AgentModelDescriptor { return this.lifecycleService.resolveSpawnModelWithCapacityFallback(model); }
  private async resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): Promise<string> {
    return this.configurationCoordinator.resolveSystemPromptForDescriptor(descriptor);
  }
  private async terminateDescriptor(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean }
  ): Promise<void> {
    this.codexPluginDelegationCoordinator.closeDescriptorScopes(descriptor);
    await this.lifecycleService.terminateDescriptor(descriptor, options);
    if (descriptor.role === "manager") {
      this.projectExecutableTrustCoordinator.forgetManager(descriptor.agentId);
    }
  }
  protected async getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
    skillMetadata: SkillMetadata[];
  }> {
    return this.configurationCoordinator.getMemoryRuntimeResources(descriptor);
  }
  protected async getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>> { return this.configurationCoordinator.getSwarmContextFiles(cwd); }
  protected async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken = this.runtimeController.allocateRuntimeToken(descriptor.agentId),
    options?: RuntimeCreationOptions
  ): Promise<SwarmAgentRuntime> {
    return this.runtimeController.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options);
  }
  protected async resolveProjectExecutableTrustPlanForRuntime(options: {
    descriptor: AgentDescriptor;
    sessionDescriptor?: AgentDescriptor;
  }): Promise<ProjectExecutableTrustPlan> {
    return this.projectExecutableTrustCoordinator.resolvePlanForRuntime(options);
  }
  protected async executeSessionMemoryLLMMerge(
    descriptor: AgentDescriptor,
    profileMemoryContent: string,
    sessionMemoryContent: string
  ): Promise<{ mergedContent: string; model: string }> {
    return this.memoryMergeService.executeSessionMemoryLLMMerge(
      descriptor,
      profileMemoryContent,
      sessionMemoryContent
    );
  }
  async patchDescriptorFromRuntimeStatus(
    agentId: string,
    patch: Partial<AgentDescriptor>
  ): Promise<AgentDescriptor | undefined> {
    return this.descriptorStoreAdapter.patchDescriptorInLiveMaps(agentId, patch);
  }
}
