import type { AssignmentSelection } from "../environment/control/orchestration/assignments.js";
import type { CoreAgentMessagePort } from "./core-agent-message-port.js";
import type { ManagerExactModelSelection } from "@forge/protocol";
import { getSessionFilePath, getWorkerSessionFilePath } from "./data-paths.js";
import { normalizeThinkingLevelForModelDescriptor, resolveModelDescriptorFromPreset, parseSwarmModelPreset, parseSwarmReasoningLevel, assertSwarmModelIdNotRetired } from "./catalog/model-presets.js";
import {
  DEFAULT_RUNTIME_SHUTDOWN_TIMEOUT_MS,
  type RuntimeAcquisitionRequirements,
  type RuntimeCreationOptions,
  type RuntimeShutdownOptions,
  type RuntimeShutdownResult,
  type SetPinnedContentOptions,
  type SwarmAgentRuntime
} from "./runtime-contracts.js";
import {
  isRuntimeRecoveryActiveForRuntime,
  type ManagerRuntimeRecycleReason as RuntimeManagerRuntimeRecycleReason,
  type RuntimeRecoveryState
} from "./runtime/runtime-recovery-state.js";
import { SessionProvisioner, type ProvisionedSessionDescriptor } from "./session-provisioner.js";
import { isNonRunningAgentStatus, transitionAgentStatus } from "./agent-state-machine.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  ConversationAttachment,
  ManagerProfile,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SpawnAgentInput,
  SwarmModelPreset,
  SwarmReasoningLevel
} from "./types.js";
import {
  formatWorkerStopIncompleteNotice,
  MANUAL_MANAGER_STOP_INCOMPLETE_NOTICE,
  STOPPED_TURN_NOTICE,
} from "./manual-stop-notice.js";
import {
  SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE,
  SECURE_RUNTIME_PROVIDER_UNSUPPORTED_MESSAGE,
} from "./secure-sessions/runtime/secure-runtime-binding.js";
import { supportsSecureRuntimeProvider } from "./secure-sessions/runtime/secure-runtime-provider-policy.js";
import {
  buildModelCapacityBlockKey,
  cloneDescriptor,
  normalizeAgentId,
  normalizeOptionalAgentId,
  normalizeOptionalModelId,
  resolveNextCapacityFallbackModelId
} from "./swarm-manager-utils.js";
import { resolveExactManagerModelSelection } from "./catalog/manager-model-selection.js";
import { resolveModelCredentialProvider } from "./secrets-env-service.js";
import { modelCatalogService } from "./catalog/model-catalog-service.js";
import {
  assertForgeRuntimeEligibleDescriptor,
  interruptExternalThreadWorkerDescriptor,
  isExternalThreadDescriptor,
  shouldPreserveExternalThreadWorkerOnSessionStop,
  shouldInterruptExternalThreadSidecar,
} from "./external-thread-compatibility.js";
import type { SecureWorkerLifecyclePort } from "./secure-sessions/secure-session-lifecycle-port.js";
import {
  mergeWorkerPresets,
  readWorkerPresetSettings,
  specialistsToWorkerPresets,
  type ResolvedWorkerPreset,
} from "./specialists/worker-presets.js";
import { RETIRED_PROFILE_IDS } from "./agents/descriptor-store/descriptor-codec.js";

const MANAGER_ARCHETYPE_ID = "manager";

interface ResolvedSpecialistDefinitionLike {
  specialistId: string;
  displayName: string;
  color: string;
  enabled: boolean;
  whenToUse: string;
  modelId?: string;
  provider?: string;
  reasoningLevel?: SwarmReasoningLevel;
  builtin?: boolean;
  webSearch?: boolean;
  promptBody: string;
  available: boolean;
  availabilityCode?: string;
  availabilityMessage?: string;
}

interface ModelCapacityBlockLike {
  provider: string;
  modelId: string;
  blockedUntilMs: number;
}

export interface AgentLifecycleDescriptorMutations {
  upsertDescriptor: (descriptor: AgentDescriptor) => void;
  deleteDescriptor: (agentId: string) => void;
  upsertProfile: (profile: ManagerProfile) => void;
  deleteProfile: (profileId: string) => void;
}

export type AgentLifecycleStopSessionOptions = {
  saveStore: boolean;
  emitSnapshots: boolean;
  emitStatus?: boolean;
  deleteWorkers?: boolean;
  manualStopNotice?: boolean;
  taskLifecycle?: "manual_stop" | "none";
};

export type ManagerRuntimeRecycleReason = RuntimeManagerRuntimeRecycleReason;

/**
 * Stop-path hook for preserved external-thread sidecars.
 *
 * Intended for stop/interrupt semantics only (for example, binding to
 * CodexAppServerService.interruptTurn when that real service is available).
 */
export type ExternalThreadStopInterruptCallback = (agentId: string) => Promise<void>;

/**
 * Terminate/delete cleanup hook for external-thread sidecars.
 *
 * This is deliberately distinct from stop/interrupt. Integration must NOT bind
 * this to interruptTurn(); kill/delete should keep terminated/delete semantics
 * while later real service work provides a cleanup-only method that releases any
 * shared busy-state bookkeeping.
 */
export type ExternalThreadTerminateCleanupCallback = (agentId: string) => Promise<void>;

export interface SwarmAgentLifecycleServiceOptions {
  dataDir: string;
  descriptors: Map<string, AgentDescriptor>;
  getAgentForInternalUse: (agentId: string) => AgentDescriptor | undefined;
  profiles: Map<string, ManagerProfile>;
  runtimes: Map<string, SwarmAgentRuntime>;
  runtimeCreationPromisesByAgentId?: Map<string, Promise<SwarmAgentRuntime>>;
  getRuntime: (agentId: string) => SwarmAgentRuntime | undefined;
  getRuntimeCreationPromise: (agentId: string) => Promise<SwarmAgentRuntime> | undefined;
  setRuntimeCreationPromise: (agentId: string, promise: Promise<SwarmAgentRuntime>) => void;
  clearRuntimeCreationPromiseIfCurrent: (agentId: string, promise: Promise<SwarmAgentRuntime>) => boolean;
  runtimeRecoveryState: Pick<
    RuntimeRecoveryState,
    | "hasPendingManagerRuntimeRecycle"
    | "getPendingManagerRuntimeRecycleReason"
    | "setPendingManagerRuntimeRecycle"
    | "clearPendingManagerRuntimeRecycle"
    | "clearRecoveryAbortedWorkerTurn"
  >;
  secureWorkers: SecureWorkerLifecyclePort;
  modelCapacityBlocks: Map<string, ModelCapacityBlockLike>;
  sessionProvisioner: SessionProvisioner;
  descriptorMutations: AgentLifecycleDescriptorMutations;
  now: () => string;
  getRequiredSessionDescriptor: (agentId: string) => ProvisionedSessionDescriptor;
  assertManager: (agentId: string, action: string) => AgentDescriptor;
  hasRunningManagers: () => boolean;
  generateUniqueAgentId: (source: string) => string;
  generateUniqueManagerId: (source: string) => string;
  resolveAndValidateCwd: (cwd: string) => Promise<string>;
  resolveDefaultModelDescriptor: () => AgentModelDescriptor;
  getManagedModelProviderAvailability: () => Promise<Map<string, boolean>>;
  resolveSpawnWorkerArchetypeId: (
    input: SpawnAgentInput,
    normalizedAgentId: string,
    profileId: string
  ) => Promise<string | undefined>;
  resolveSpecialistRosterForProfile: (profileId: string) => Promise<ResolvedSpecialistDefinitionLike[]>;
  resolveSpecialistRosterForManager?: (manager: AgentDescriptor) => Promise<ResolvedSpecialistDefinitionLike[]>;
  normalizeSpecialistHandle: (value: string) => Promise<string | undefined>;
  resolveSystemPromptForDescriptor: (descriptor: AgentDescriptor) => Promise<string>;
  injectWorkerIdentityContext: (descriptor: AgentDescriptor, systemPrompt: string) => string;
  createRuntimeForDescriptor: (
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions
  ) => Promise<SwarmAgentRuntime>;
  allocateRuntimeToken: (agentId: string) => number;
  clearRuntimeToken: (agentId: string, runtimeToken?: number) => void;
  getRuntimeToken: (agentId: string) => number | undefined;
  getActiveTurnId: (agentId: string, runtimeToken?: number) => string | undefined;
  isSecureRuntimeBindingUsable(
    agentId: string,
    runtime: SwarmAgentRuntime,
  ): boolean;
  hasSecureRuntimeBinding(runtime: SwarmAgentRuntime): boolean;
  ensureSessionFileParentDirectory: (sessionFile: string) => Promise<void>;
  updateSessionMetaForWorkerDescriptor: (
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string
  ) => Promise<void>;
  refreshSessionMetaStatsBySessionId: (sessionAgentId: string) => Promise<void>;
  refreshSessionMetaStats: (descriptor: AgentDescriptor) => Promise<void>;
  captureSessionRuntimePromptMeta: (
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ) => Promise<void>;
  attachRuntime: (agentId: string, runtime: SwarmAgentRuntime) => void;
  saveStore: () => Promise<void>;
  /**
   * Session-wide stop/recycle/delete discard the current work epoch before
   * teardown so those actions cannot look like completed work. Worker-only
   * kill/stop must not call this while the manager or another owned worker is
   * still in the same epoch.
   */
  suppressSessionAttention: (sessionAgentId: string) => Promise<void>;
  emitStatus: (
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ) => void;
  emitAgentsSnapshot: () => void;
  emitProfilesSnapshot: () => void;
  logDebug: (message: string, details?: Record<string, unknown>) => void;
  clearWorkerHealthState: (agentId: string) => void;
  suppressIntentionalStopRuntimeCallbacks: (agentId: string, runtimeToken?: number) => void;
  clearIntentionalStopRuntimeCallbackSuppression: (agentId: string, runtimeToken?: number) => void;
  allowInvalidatedManualStopMessageEnd: (agentId: string, runtimeToken?: number) => void;
  markPendingManualManagerStopNotice: (agentId: string) => void;
  emitImmediateManualManagerStopNotice: (agentId: string, text?: string, systemNoticeKind?: "worker_stopped" | "turn_stopped") => void;
  settlePendingManualManagerStopNotice: (agentId: string) => void;
  cancelAllPendingChoicesForAgent: (agentId: string) => void;
  runRuntimeShutdown: (
    descriptor: AgentDescriptor,
    action: "terminate" | "stopInFlight",
    options?: RuntimeShutdownOptions
  ) => Promise<RuntimeShutdownResult>;
  recoverRuntimeShutdown: (descriptor: AgentDescriptor) => Promise<boolean>;
  isRuntimeShutdownQuarantined: (agentId: string) => boolean;
  prepareRuntimeShutdown: (agentId: string) => void;
  withRuntimeAdmission: <T>(agentId: string, operation: () => Promise<T>) => Promise<T>;
  waitForRuntimeAdmissions: (agentId: string) => Promise<void>;
  assertRuntimeCreationAllowed: (agentId: string) => void;
  detachRuntime: (agentId: string, runtimeToken?: number) => boolean;
  clearAgentTurnState: (agentId: string) => void;
  reconcileStoppedManagerRuntime: (input: {
    agentId: string;
    turnId?: string;
  }) => Promise<boolean>;
  detachRuntimeIfMatches: (
    agentId: string,
    expectedRuntime: SwarmAgentRuntime,
    runtimeToken?: number
  ) => boolean;
  syncPinnedContentForManagerRuntime: (
    descriptor: ProvisionedSessionDescriptor,
    options?: {
      runtime?: SwarmAgentRuntime;
      setPinnedContentOptions?: SetPinnedContentOptions;
    }
  ) => Promise<void>;
  interruptExternalThreadSidecarTurn?: ExternalThreadStopInterruptCallback;
  terminateExternalThreadSidecarTurn?: ExternalThreadTerminateCleanupCallback;
  sendMessage: (
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery?: RequestedDeliveryMode,
    options?: {
      origin?: "user" | "internal";
      attachments?: ConversationAttachment[];
      planStep?: string;
      planAssignmentSource?: "spawn_agent" | "send_message_to_agent";
      requiresSecureRuntime?: boolean;
    }
  ) => Promise<SendMessageReceipt>;
  sendManagerBootstrapMessage: (managerId: string) => Promise<void>;
  materializeSortOrder: () => void;
  getSessionsForProfile: (profileId: string) => Array<AgentDescriptor & { role: "manager"; profileId: string }>;
  getWorkersForManager: (managerId: string) => AgentDescriptor[];
  deleteConversationHistory: (agentId: string, sessionFile: string) => void;
  deleteManagerSchedulesFile: (profileId: string) => Promise<void>;
  migrateLegacyProfileKnowledgeToReferenceDoc: (profileId: string) => Promise<void>;
  prepareWorkerDescriptorForSpawn?: (context: {
    callerAgentId: string;
    input: SpawnAgentInput;
    descriptor: AgentDescriptor;
    specialistId?: string;
  }) => void | Promise<void>;
}

export class SwarmAgentLifecycleService {
  private core: CoreAgentMessagePort | undefined;

  installCoreAgentMessages(core: CoreAgentMessagePort): void { this.core = core; }
  private refreshProviderContext?: (agentId: string) => Promise<void>;
  installCoreProviderRefresh(refresh: (agentId: string) => Promise<void>): void { this.refreshProviderContext = refresh; }

  constructor(private readonly options: SwarmAgentLifecycleServiceOptions) {}

  private upsertDescriptor(descriptor: AgentDescriptor): void {
    this.options.descriptorMutations.upsertDescriptor(descriptor);
  }

  private deleteDescriptor(agentId: string): void {
    this.options.descriptorMutations.deleteDescriptor(agentId);
  }

  private deleteProfile(profileId: string): void {
    this.options.descriptorMutations.deleteProfile(profileId);
  }

  private getRuntime(agentId: string): SwarmAgentRuntime | undefined {
    return this.options.getRuntime(agentId);
  }

  private getRuntimeCreationPromise(agentId: string): Promise<SwarmAgentRuntime> | undefined {
    return this.options.getRuntimeCreationPromise(agentId);
  }

  private setRuntimeCreationPromise(agentId: string, promise: Promise<SwarmAgentRuntime>): void {
    this.options.setRuntimeCreationPromise(agentId, promise);
  }

  private clearRuntimeCreationPromiseIfCurrent(agentId: string, promise: Promise<SwarmAgentRuntime>): boolean {
    return this.options.clearRuntimeCreationPromiseIfCurrent(agentId, promise);
  }

  private clearWorkerTeardownState(agentId: string): void {
    this.options.clearWorkerHealthState(agentId);
    this.options.runtimeRecoveryState.clearRecoveryAbortedWorkerTurn(agentId);
  }

  private async interruptExternalThreadWorker(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean }
  ): Promise<void> {
    this.clearWorkerTeardownState(descriptor.agentId);

    const interruptSidecarTurn = this.options.interruptExternalThreadSidecarTurn;
    if (interruptSidecarTurn) {
      try {
        await interruptSidecarTurn(descriptor.agentId);
        if (descriptor.status !== "streaming") {
          return;
        }
      } catch (error) {
        this.options.logDebug("external_thread:interrupt_service_failed", {
          agentId: descriptor.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    interruptExternalThreadWorkerDescriptor(descriptor, {
      abort: options.abort,
      emitStatus: options.emitStatus,
      now: this.options.now,
      emitStatusEvent: (agentId, status, pendingCount) => {
        this.options.emitStatus(agentId, status, pendingCount);
      },
      logDebug: (message, details) => {
        this.options.logDebug(message, details);
      },
    });
    this.upsertDescriptor(descriptor);
  }

  private async cleanupExternalThreadWorkerForTermination(descriptor: AgentDescriptor): Promise<void> {
    this.clearWorkerTeardownState(descriptor.agentId);

    const terminateSidecarTurn = this.options.terminateExternalThreadSidecarTurn;
    if (!terminateSidecarTurn) {
      return;
    }

    // Cleanup-only seam for kill/delete. Do not treat this as a stop/interrupt
    // path; callers still project the descriptor to terminated immediately after.

    try {
      await terminateSidecarTurn(descriptor.agentId);
    } catch (error) {
      this.options.logDebug("external_thread:terminate_service_failed", {
        agentId: descriptor.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private invalidateManagerRuntimeBeforeWorkerTeardown(
    agentId: string,
    options?: { allowManualStopMessageEnd?: boolean }
  ): {
    runtime?: SwarmAgentRuntime;
    runtimeToken?: number;
    turnId?: string;
  } {
    this.options.prepareRuntimeShutdown(agentId);
    const runtime = this.options.runtimes.get(agentId);
    const runtimeToken = this.options.getRuntimeToken(agentId);
    const turnId = this.options.getActiveTurnId(agentId, runtimeToken);
    if (options?.allowManualStopMessageEnd) {
      this.options.allowInvalidatedManualStopMessageEnd(agentId, runtimeToken);
    }
    this.options.clearRuntimeToken(agentId);
    return { runtime, runtimeToken, turnId };
  }

  private async shutdownLatestManagerRuntime(
    descriptor: AgentDescriptor,
    action: "terminate" | "stopInFlight",
    invalidatedRuntime: { runtime?: SwarmAgentRuntime; runtimeToken?: number }
  ): Promise<boolean> {
    const latestRuntime = this.options.runtimes.get(descriptor.agentId);
    if (!latestRuntime) {
      // The shutdown guard is installed before worker teardown. A manager can
      // legitimately have no attached runtime (for example, a restored idle
      // session), but the prepared guard still has to be completed so a later
      // resume is not permanently rejected as "stopping".
      const shutdown = await this.options.runRuntimeShutdown(descriptor, action, { abort: true });
      this.options.clearRuntimeToken(descriptor.agentId);
      return shutdown.status !== "clean";
    }

    const shutdown = await this.options.runRuntimeShutdown(descriptor, action, { abort: true });
    const runtimeToken = shutdown.runtimeToken ??
      (latestRuntime === invalidatedRuntime.runtime ? invalidatedRuntime.runtimeToken : undefined);

    if (latestRuntime === invalidatedRuntime.runtime && shutdown.runtimeToken === undefined) {
      this.options.detachRuntimeIfMatches(descriptor.agentId, latestRuntime, runtimeToken);
      return shutdown.status !== "clean";
    }

    this.options.detachRuntime(descriptor.agentId, runtimeToken);
    return shutdown.status !== "clean";
  }

  private async shutdownWorkerRuntimeWithSuppressedCallbacks(
    descriptor: AgentDescriptor,
    action: "terminate" | "stopInFlight",
    options?: RuntimeShutdownOptions
  ): Promise<boolean> {
    if (
      descriptor.role !== "worker" ||
      isExternalThreadDescriptor(descriptor) ||
      (!this.options.runtimes.has(descriptor.agentId) && !this.options.isRuntimeShutdownQuarantined(descriptor.agentId))
    ) {
      return false;
    }

    const runtimeToken = this.options.getRuntimeToken(descriptor.agentId);
    this.options.suppressIntentionalStopRuntimeCallbacks(descriptor.agentId, runtimeToken);

    try {
      const shutdown = await this.options.runRuntimeShutdown(descriptor, action, options);
      this.options.detachRuntime(descriptor.agentId, shutdown.runtimeToken);
      return shutdown.status !== "clean";
    } finally {
      this.clearWorkerTeardownState(descriptor.agentId);
      this.options.clearIntentionalStopRuntimeCallbackSuppression(descriptor.agentId, runtimeToken);
    }
  }

  /** One quiet marker on the turn the user stopped; the turn's own rows do not say why it ended. */
  markTurnStoppedByUser(agentId: string): void {
    if (this.options.descriptors.get(agentId)?.role !== "manager") return;
    this.options.emitImmediateManualManagerStopNotice(agentId, STOPPED_TURN_NOTICE, "turn_stopped");
  }

  async stopSession(agentId: string, options?: { manualStopNotice?: boolean }): Promise<{ terminatedWorkerIds: string[] }> {
    const { terminatedWorkerIds } = await this.stopSessionInternal(agentId, {
      saveStore: true,
      emitSnapshots: true,
      ...(options?.manualStopNotice === false ? { manualStopNotice: false } : {}),
    });

    return { terminatedWorkerIds };
  }

  async resumeSession(agentId: string): Promise<void> {
    const descriptor = this.options.getRequiredSessionDescriptor(agentId);

    if (this.options.runtimes.has(agentId)) {
      throw new Error(`Session is already running: ${agentId}`);
    }

    const previousStatus = descriptor.status;
    const interruptedTurnId = previousStatus === "stopped"
      ? this.options.getActiveTurnId(agentId)
      : undefined;
    if (descriptor.status === "error") {
      throw new Error(`Session is not resumable from error status: ${agentId}`);
    }

    if (
      descriptor.status !== "idle" &&
      descriptor.status !== "terminated" &&
      descriptor.status !== "stopped"
    ) {
      throw new Error(`Session is not resumable from status ${descriptor.status}: ${agentId}`);
    }

    await this.options.recoverRuntimeShutdown(descriptor);
    // A later stop must either win before recovery is admitted or wait until
    // replacement creation settles; never clear its fence halfway through start.
    await this.options.withRuntimeAdmission(agentId, async () => {
      if (previousStatus === "stopped") {
        await this.options.reconcileStoppedManagerRuntime({
          agentId,
          turnId: interruptedTurnId,
        });
      }

      if (isNonRunningAgentStatus(descriptor.status)) {
        descriptor.status = transitionAgentStatus(descriptor.status, "idle");
      }

      descriptor.updatedAt = this.options.now();
      this.upsertDescriptor(descriptor);

      try {
        const runtime = await this.getOrCreateRuntimeForDescriptor(descriptor);
        descriptor.contextUsage = runtime.getContextUsage();
        this.upsertDescriptor(descriptor);
      } catch (error) {
        descriptor.status = previousStatus;
        descriptor.updatedAt = this.options.now();
        this.upsertDescriptor(descriptor);
        throw error;
      }

      await this.options.saveStore();
      this.options.emitAgentsSnapshot();
      this.options.emitProfilesSnapshot();
    });
  }

  async spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor> {
    return this.options.withRuntimeAdmission(callerAgentId, () => this.spawnAdmittedAgent(callerAgentId, input));
  }

  private async spawnAdmittedAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor> {
    const manager = this.options.assertManager(callerAgentId, "spawn agents");

    const requestedAgentId = input.agentId?.trim();
    if (!requestedAgentId) {
      throw new Error("spawn_agent requires a non-empty agentId");
    }

    const agentId = this.options.generateUniqueAgentId(requestedAgentId);
    const createdAt = this.options.now();
    const managerProfileId = manager.profileId ?? manager.agentId;
    let preset: ResolvedWorkerPreset | undefined;
    if (input.preset !== undefined) {
      const requested = input.preset.trim();
      const presets = await this.resolveWorkerPresetsForManager(manager);
      preset = presets.find((entry) => entry.name === requested);
      if (!preset) {
        throw new Error(
          presets.length > 0
            ? `Unknown preset "${requested}". Valid presets: ${presets.map((entry) => entry.name).join(", ")}. Omit preset to use your own model.`
            : `Unknown preset "${requested}". No presets are configured; omit preset to use your own model.`
        );
      }
    } else if (input.specialist !== undefined) {
      // Internal only: Forge-owned builtin instructions (the Codex plugin worker) on the manager's model.
      const specialistId = await this.options.normalizeSpecialistHandle(input.specialist);
      const specialist = (await this.resolveSpecialistRoster(manager)).find((entry) => entry.specialistId === specialistId);
      if (!specialist || !specialist.enabled) {
        throw new Error(`Unknown specialist: ${input.specialist}`);
      }
      [preset] = specialistsToWorkerPresets([{ ...specialist, builtin: false }], manager.model);
    }

    if (
      preset &&
      (
        input.model !== undefined ||
        input.modelId !== undefined ||
        input.systemPrompt !== undefined ||
        input.archetypeId !== undefined
      )
    ) {
      throw new Error("Cannot combine a preset with model, prompt, or archetype overrides.");
    }

    let model: AgentModelDescriptor;
    let archetypeId: string | undefined;
    let explicitSystemPrompt: string | undefined;
    let webSearch = false;

    if (preset) {
      // Only a model the user chose is checked: a file that names none runs on the manager's,
      // and the internal Codex plugin worker is bound to its own runtime after spawn.
      const usesManagerModel = preset.provider === manager.model.provider && preset.modelId === manager.model.modelId;
      if (input.preset !== undefined && !usesManagerModel && !modelCatalogService.isKnownModelId(preset.modelId, preset.provider)) {
        throw new Error(`Preset "${preset.name}" uses a model that is not available: ${preset.provider}/${preset.modelId}.`);
      }
      model = {
        provider: preset.provider,
        modelId: preset.modelId,
        thinkingLevel: parseSwarmReasoningLevel(input.reasoningLevel, "spawn_agent.reasoningLevel") ?? preset.reasoningLevel,
      };
      model.thinkingLevel = normalizeThinkingLevelForModelDescriptor(model);
      if (preset.instructions) {
        explicitSystemPrompt = preset.instructions;
      } else {
        archetypeId = await this.options.resolveSpawnWorkerArchetypeId(input, agentId, managerProfileId);
      }
      webSearch = preset.webSearch === true;
    } else {
      const requestedModel = this.resolveSpawnModel(input, manager.model);
      model = this.resolveSpawnModelWithCapacityFallback(requestedModel);
      archetypeId = await this.options.resolveSpawnWorkerArchetypeId(input, agentId, managerProfileId);
      explicitSystemPrompt = input.systemPrompt?.trim();
      webSearch = input.webSearch === true;
    }

    if (input.requiresSecureRuntime && !supportsSecureRuntimeProvider(model.provider)) {
      throw new Error(SECURE_RUNTIME_PROVIDER_UNSUPPORTED_MESSAGE);
    }

    const descriptor: AgentDescriptor = {
      agentId,
      displayName: agentId,
      role: "worker",
      managerId: manager.agentId,
      profileId: manager.profileId ?? manager.agentId,
      archetypeId,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd: input.cwd ? await this.options.resolveAndValidateCwd(input.cwd) : manager.cwd,
      model,
      sessionFile: getWorkerSessionFilePath(
        this.options.dataDir,
        manager.profileId ?? manager.agentId,
        manager.agentId,
        agentId
      ),
      // New workers have explicit current attribution; legacy descriptors that
      // lack this field remain unknown when historical records are scanned.
      specialistAttributionKnown: true,
      ...(webSearch ? { webSearch: true } : {})
    };

    await this.assertWorkerModelAvailable(manager, descriptor.model, input, preset);

    if (preset) {
      descriptor.specialistId = preset.name;
      descriptor.specialistDisplayName = preset.displayName ?? preset.name;
      if (preset.color) descriptor.specialistColor = preset.color;
    }

    await this.options.prepareWorkerDescriptorForSpawn?.({
      callerAgentId,
      input,
      descriptor,
      specialistId: preset?.name,
    });

    this.upsertDescriptor(descriptor);
    await this.options.ensureSessionFileParentDirectory(descriptor.sessionFile);
    await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
    await this.options.saveStore();
    this.options.emitAgentsSnapshot();

    this.options.logDebug("agent:spawn", {
      callerAgentId,
      agentId,
      managerId: descriptor.managerId,
      displayName: descriptor.displayName,
      archetypeId: descriptor.archetypeId,
      specialistId: descriptor.specialistId,
      model: descriptor.model,
      cwd: descriptor.cwd
    });

    let secureWorkerPrepared = false;
    try {
      secureWorkerPrepared =
        await this.options.secureWorkers.prepareWorkerForSecureTeam(agentId);
      if (input.requiresSecureRuntime && !secureWorkerPrepared) {
        throw new Error(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);
      }
      if (secureWorkerPrepared) {
        this.options.emitStatus(agentId, descriptor.status, 0);
        this.options.emitAgentsSnapshot();
      } else {
        const baseSystemPrompt =
          explicitSystemPrompt && explicitSystemPrompt.length > 0
            ? explicitSystemPrompt
            : await this.options.resolveSystemPromptForDescriptor(descriptor);

        const runtimeSystemPrompt = this.options.injectWorkerIdentityContext(descriptor, baseSystemPrompt);

        const runtime = await this.options.createRuntimeForDescriptor(descriptor, runtimeSystemPrompt);

        this.options.attachRuntime(agentId, runtime);

        const persistedSystemPrompt = runtime.getSystemPrompt?.() ?? runtimeSystemPrompt;
        const contextUsage = runtime.getContextUsage();
        descriptor.contextUsage = contextUsage;
        this.upsertDescriptor(descriptor);
        await this.options.updateSessionMetaForWorkerDescriptor(descriptor, persistedSystemPrompt);
        await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);

        this.options.emitStatus(agentId, descriptor.status, runtime.getPendingCount(), contextUsage);
        this.options.emitAgentsSnapshot();
      }
    } catch (error) {
      let rollbackShutdownIncomplete = false;
      try {
        if (
          this.options.runtimes.has(agentId) ||
          this.options.isRuntimeShutdownQuarantined(agentId)
        ) {
          const shutdown = await this.options.runRuntimeShutdown(descriptor, "terminate", { abort: true });
          this.options.detachRuntime(agentId, shutdown.runtimeToken);
          rollbackShutdownIncomplete = shutdown.status !== "clean";
        }
      } catch (shutdownError) {
        rollbackShutdownIncomplete = true;
        this.options.logDebug("agent:spawn:rollback_runtime_error", {
          agentId,
          error: String(shutdownError)
        });
      }

      this.options.clearWorkerHealthState(agentId);
      this.options.clearAgentTurnState(agentId);

      if (rollbackShutdownIncomplete) {
        descriptor.status = "stopped";
        descriptor.contextUsage = undefined;
        descriptor.streamingStartedAt = undefined;
        descriptor.updatedAt = this.options.now();
        this.upsertDescriptor(descriptor);
        this.options.emitStatus(agentId, descriptor.status, 0);
        this.options.emitImmediateManualManagerStopNotice(
          descriptor.managerId,
          formatWorkerStopIncompleteNotice([agentId]),
        );
      } else {
        this.deleteDescriptor(agentId);
      }
      this.options.emitAgentsSnapshot();
      await this.options.saveStore();

      try {
        await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);
      } catch (metaError) {
        this.options.logDebug("agent:spawn:rollback_meta_error", {
          agentId,
          managerId: descriptor.managerId,
          error: String(metaError)
        });
      }

      throw error;
    }

    if (input.initialMessage && input.initialMessage.trim().length > 0) {
      await this.options.sendMessage(callerAgentId, agentId, input.initialMessage, "auto", {
        origin: "internal",
        ...(input.planStep ? { planStep: input.planStep } : {}),
        planAssignmentSource: "spawn_agent",
        ...(input.requiresSecureRuntime
          ? { requiresSecureRuntime: true }
          : {}),
      });
    }

    return cloneDescriptor(descriptor);
  }

  async killAgent(callerAgentId: string, targetAgentId: string): Promise<void> {
    this.options.assertManager(callerAgentId, "kill agents");
    await this.killControlledWorker(callerAgentId, targetAgentId);
  }

  /** Durable user control may terminate a child after its manager has stopped. */
  async killControlledWorker(callerAgentId: string, targetAgentId: string): Promise<void> {
    const manager = this.options.descriptors.get(callerAgentId);
    if (!manager || manager.role !== "manager") throw new Error("Worker owner is not a manager");
    const target = this.options.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown agent: ${targetAgentId}`);
    }
    if (target.role === "manager") {
      throw new Error("Manager cannot be killed");
    }

    if (target.managerId !== manager.agentId) {
      throw new Error(`Only owning manager can kill agent ${targetAgentId}`);
    }

    if (!this.core) throw new Error("Core worker control is unavailable");
    await this.core.stopWorker({ managerId: manager.agentId, workerId: targetAgentId });
  }

  /** The control owner has drained this worker's canonical/provider fence before removal. */
  async deleteControlledWorker(managerId: string, workerId: string): Promise<void> {
    const manager = this.options.descriptors.get(managerId);
    const worker = this.options.descriptors.get(workerId);
    if (!manager || manager.role !== "manager" || !worker || worker.role !== "worker" || worker.managerId !== managerId) {
      throw new Error("Worker does not belong to this session");
    }
    await this.terminateDescriptor(worker, { abort: true, emitStatus: true });
    if (worker.status !== "terminated") throw new Error("Worker shutdown is still settling");
    this.deleteDescriptor(workerId);
    // Forget its mounted detail/cache; canonical result transfers and the manager's history stay intact.
    this.options.deleteConversationHistory(workerId, worker.sessionFile);
    await this.options.refreshSessionMetaStatsBySessionId(managerId);
    await this.options.saveStore();
    this.options.emitAgentsSnapshot();
  }

  /**
   * The user stopped this worker. The core is told before the runtime goes away, so when the
   * worker's run ends its manager receives "stopped by the user" as the result, instead of a
   * "blocked" result to act on or no result at all.
   */
  async stopWorkerByUser(agentId: string): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    const assignment = descriptor?.role === "worker" ? this.core?.readAssignment(agentId) : undefined;
    if (descriptor?.role === "worker" && assignment && ["assigned", "running"].includes(assignment.state)) {
      await this.core!.noteWorkerStoppedByUser({ managerId: descriptor.managerId, workerId: agentId });
    }
    await this.stopWorker(agentId);
  }

  /** Stops asked for while one is under way join it: a user stop and the core's release of the same worker are one shutdown. */
  private readonly workerStopsInFlight = new Map<string, Promise<void>>();

  async stopWorker(agentId: string): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      throw new Error(`Unknown worker agent: ${agentId}`);
    }

    const inFlight = this.workerStopsInFlight.get(agentId);
    if (inFlight) return inFlight;
    const stop = this.stopWorkerRuntime(
      descriptor as AgentDescriptor & { role: "worker" },
    ).finally(() => this.workerStopsInFlight.delete(agentId));
    this.workerStopsInFlight.set(agentId, stop);
    return stop;
  }

  private async stopWorkerRuntime(
    descriptor: AgentDescriptor & { role: "worker" },
  ): Promise<void> {
    const agentId = descriptor.agentId;
    if (isExternalThreadDescriptor(descriptor)) {
      if (!shouldInterruptExternalThreadSidecar(descriptor)) {
        return;
      }

      await this.maybeSuppressSessionAttentionForWorkerTeardown(descriptor.managerId, descriptor.agentId);
      await this.interruptExternalThreadWorker(descriptor, { abort: true, emitStatus: true });
      await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
      await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);
      await this.options.saveStore();
      this.options.emitAgentsSnapshot();
      return;
    }

    await this.maybeSuppressSessionAttentionForWorkerTeardown(descriptor.managerId, descriptor.agentId);
    this.clearWorkerTeardownState(agentId);
    const shutdownIncomplete = await this.shutdownWorkerRuntimeWithSuppressedCallbacks(
      descriptor,
      "terminate",
      { abort: true },
    );
    this.clearWorkerTeardownState(agentId);
    if (shutdownIncomplete) {
      this.options.clearAgentTurnState(agentId);
    }

    descriptor.status = shutdownIncomplete
      ? "stopped"
      : transitionAgentStatus(descriptor.status, "idle");
    descriptor.contextUsage = undefined;
    descriptor.updatedAt = this.options.now();
    this.upsertDescriptor(descriptor);

    await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
    await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);
    await this.options.saveStore();

    this.options.emitStatus(agentId, descriptor.status, 0);
    this.options.emitAgentsSnapshot();
    if (shutdownIncomplete) {
      this.options.emitImmediateManualManagerStopNotice(
        descriptor.managerId,
        formatWorkerStopIncompleteNotice([descriptor.agentId]),
      );
    }
  }

  /**
   * Worker-only teardown is not a session stop. Discard the epoch only when
   * no other manager/owned-worker activity remains that could still settle it.
   */
  private async maybeSuppressSessionAttentionForWorkerTeardown(
    sessionAgentId: string,
    targetWorkerId: string,
  ): Promise<void> {
    if (this.sessionHasRemainingWorkAfterWorkerTeardown(sessionAgentId, targetWorkerId)) {
      return;
    }
    await this.options.suppressSessionAttention(sessionAgentId);
  }

  private sessionHasRemainingWorkAfterWorkerTeardown(
    sessionAgentId: string,
    targetWorkerId: string,
  ): boolean {
    const manager = this.options.descriptors.get(sessionAgentId);
    if (manager?.role === "manager" && manager.status === "streaming") {
      return true;
    }
    return this.options.getWorkersForManager(sessionAgentId).some((worker) => (
      worker.agentId !== targetWorkerId && worker.status === "streaming"
    ));
  }

  async resumeWorker(agentId: string): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      throw new Error(`Unknown worker agent: ${agentId}`);
    }

    if (isExternalThreadDescriptor(descriptor)) {
      throw new Error(`External-thread sidecar does not use Forge runtime resume: ${agentId}`);
    }

    if (this.options.runtimes.has(agentId)) {
      throw new Error(`Worker is already running: ${agentId}`);
    }

    const previousStatus = descriptor.status;
    if (descriptor.status === "error") {
      throw new Error(`Worker is not resumable from error status: ${agentId}`);
    }

    if (
      descriptor.status !== "idle" &&
      descriptor.status !== "terminated" &&
      descriptor.status !== "stopped"
    ) {
      throw new Error(`Worker is not resumable from status ${descriptor.status}: ${agentId}`);
    }

    await this.options.recoverRuntimeShutdown(descriptor);
    if (previousStatus === "stopped") {
      this.options.clearAgentTurnState(agentId);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      descriptor.status = transitionAgentStatus(descriptor.status, "idle");
    }

    descriptor.updatedAt = this.options.now();
    this.upsertDescriptor(descriptor);

    try {
      const runtime = await this.getOrCreateRuntimeForDescriptor(descriptor);
      descriptor.contextUsage = runtime.getContextUsage();
      this.upsertDescriptor(descriptor);
    } catch (error) {
      descriptor.status = previousStatus;
      descriptor.updatedAt = this.options.now();
      this.upsertDescriptor(descriptor);
      throw error;
    }

    await this.options.saveStore();
    this.options.emitAgentsSnapshot();
  }

  async stopAllAgents(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{
    managerId: string;
    stoppedWorkerIds: string[];
    managerStopped: boolean;
    terminatedWorkerIds: string[];
    managerTerminated: boolean;
  }> {
    const caller = this.options.descriptors.get(callerAgentId);
    if (!caller || caller.role !== "manager") throw new Error("Only manager can stop all agents");
    const manager = caller;

    const target = this.options.descriptors.get(targetManagerId);
    if (!target || target.role !== "manager") {
      throw new Error(`Unknown manager: ${targetManagerId}`);
    }

    if (target.agentId !== manager.agentId) {
      throw new Error(`Only selected manager can stop all agents for ${targetManagerId}`);
    }

    await this.options.suppressSessionAttention(target.agentId);
    const stoppedWorkerIds: string[] = [];
    const workerShutdownIncompleteIds: string[] = [];
    const managerRuntime = this.options.runtimes.get(target.agentId);
    const shouldAllowManualStopMessageEnd =
      managerRuntime !== undefined && (target.status === "streaming" || managerRuntime.getStatus() === "streaming");
    if (shouldAllowManualStopMessageEnd) {
      this.options.markPendingManualManagerStopNotice(target.agentId);
    }

    this.options.cancelAllPendingChoicesForAgent(targetManagerId);
    const invalidatedManagerRuntime = this.invalidateManagerRuntimeBeforeWorkerTeardown(target.agentId, {
      allowManualStopMessageEnd: shouldAllowManualStopMessageEnd
    });

    for (const descriptor of Array.from(this.options.descriptors.values())) {
      if (descriptor.role !== "worker") {
        continue;
      }

      if (descriptor.managerId !== targetManagerId) {
        continue;
      }

      if (isExternalThreadDescriptor(descriptor)) {
        if (!shouldInterruptExternalThreadSidecar(descriptor)) {
          continue;
        }

        await this.interruptExternalThreadWorker(descriptor, { abort: true, emitStatus: true });
        await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
        stoppedWorkerIds.push(descriptor.agentId);
        continue;
      }

      this.clearWorkerTeardownState(descriptor.agentId);

      if (isNonRunningAgentStatus(descriptor.status) && descriptor.status !== "stopped") {
        continue;
      }

      const shutdownIncomplete = await this.shutdownWorkerRuntimeWithSuppressedCallbacks(
        descriptor,
        "stopInFlight",
        { abort: true },
      );
      this.clearWorkerTeardownState(descriptor.agentId);
      if (shutdownIncomplete) {
        this.options.clearAgentTurnState(descriptor.agentId);
      }

      descriptor.status = shutdownIncomplete
        ? "stopped"
        : transitionAgentStatus(descriptor.status, "idle");
      descriptor.contextUsage = undefined;
      descriptor.updatedAt = this.options.now();
      this.upsertDescriptor(descriptor);
      await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
      this.options.emitStatus(descriptor.agentId, descriptor.status, 0, descriptor.contextUsage);

      stoppedWorkerIds.push(descriptor.agentId);
      if (shutdownIncomplete) {
        workerShutdownIncompleteIds.push(descriptor.agentId);
      }
    }

    if (workerShutdownIncompleteIds.length > 0) {
      this.options.emitImmediateManualManagerStopNotice(
        target.agentId,
        formatWorkerStopIncompleteNotice(workerShutdownIncompleteIds),
      );
    }

    let managerStopped = false;
    let managerShutdownIncomplete = false;
    if (!isNonRunningAgentStatus(target.status) || target.status === "stopped"
      || this.options.isRuntimeShutdownQuarantined(target.agentId)) {
      if (shouldAllowManualStopMessageEnd) {
        this.options.markPendingManualManagerStopNotice(target.agentId);
        this.options.allowInvalidatedManualStopMessageEnd(target.agentId, invalidatedManagerRuntime.runtimeToken);
      }
      managerShutdownIncomplete = await this.shutdownLatestManagerRuntime(
        target,
        "stopInFlight",
        invalidatedManagerRuntime,
      );

      if (managerShutdownIncomplete) {
        this.options.emitImmediateManualManagerStopNotice(
          target.agentId,
          MANUAL_MANAGER_STOP_INCOMPLETE_NOTICE,
        );
      } else if (shouldAllowManualStopMessageEnd) {
        this.options.settlePendingManualManagerStopNotice(target.agentId);
      }

      target.status = managerShutdownIncomplete
        ? "stopped"
        : transitionAgentStatus(target.status, "idle");
      target.contextUsage = undefined;
      target.updatedAt = this.options.now();
      this.upsertDescriptor(target);
      this.options.emitStatus(target.agentId, target.status, 0, target.contextUsage);
      managerStopped = true;
    }

    if (!managerShutdownIncomplete) {
      await this.options.reconcileStoppedManagerRuntime({
        agentId: target.agentId,
        turnId: invalidatedManagerRuntime.turnId,
      });
    }

    if (
      !shouldAllowManualStopMessageEnd &&
      !managerShutdownIncomplete &&
      workerShutdownIncompleteIds.length === 0 &&
      (stoppedWorkerIds.length > 0 || managerRuntime !== undefined)
    ) {
      this.options.emitImmediateManualManagerStopNotice(target.agentId);
    }

    await this.options.refreshSessionMetaStatsBySessionId(targetManagerId);
    await this.options.saveStore();
    this.options.emitAgentsSnapshot();

    this.options.logDebug("manager:stop_all", {
      callerAgentId,
      targetManagerId,
      stoppedWorkerIds,
      managerStopped
    });

    return {
      managerId: targetManagerId,
      stoppedWorkerIds,
      managerStopped,
      terminatedWorkerIds: stoppedWorkerIds,
      managerTerminated: managerStopped
    };
  }

  async createManager(
    callerAgentId: string,
    input: { controlCommandId?: string; name: string; cwd: string; model?: SwarmModelPreset; modelSelection?: ManagerExactModelSelection; reasoningLevel?: SwarmReasoningLevel; secureSessionsEnabled?: boolean }
  ): Promise<AgentDescriptor> {
    const callerDescriptor = callerAgentId ? this.options.descriptors.get(callerAgentId) : undefined;
    if (callerAgentId === "") {
      // Direct user request through an authenticated environment client; the route already required workspace:write.
    } else if (!callerDescriptor || callerDescriptor.role !== "manager") {
      const canBootstrap = !this.options.hasRunningManagers();
      if (!canBootstrap) {
        throw new Error("Only manager can create managers");
      }
    } else if (isNonRunningAgentStatus(callerDescriptor.status)) {
      throw new Error(`Manager is not running: ${callerAgentId}`);
    }

    if (input.secureSessionsEnabled !== undefined && typeof input.secureSessionsEnabled !== "boolean") {
      throw new Error("create_manager.secureSessionsEnabled must be a boolean");
    }
    const requestedName = input.name?.trim();
    if (!requestedName) {
      throw new Error("create_manager requires a non-empty name");
    }

    const normalizedRequestedName = normalizeAgentId(requestedName);
    if (RETIRED_PROFILE_IDS.has(normalizedRequestedName)) {
      throw new Error(`The manager name "${normalizedRequestedName}" is reserved`);
    }

    if (input.model !== undefined && input.modelSelection !== undefined) {
      throw new Error("create_manager.model and create_manager.modelSelection are mutually exclusive");
    }

    const requestedModelPreset = parseSwarmModelPreset(input.model, "create_manager.model");
    const requestedReasoningLevel = parseSwarmReasoningLevel(input.reasoningLevel, "create_manager.reasoningLevel");
    const managerId = input.controlCommandId ? `project-${input.controlCommandId}` : this.options.generateUniqueManagerId(requestedName);
    if (input.controlCommandId && this.options.descriptors.has(managerId)) {
      const existing = this.options.descriptors.get(managerId)!;
      if (existing.controlCommandId !== input.controlCommandId || existing.cwd !== input.cwd) throw new Error("Controlled project identity conflicts");
      return cloneDescriptor(existing);
    }
    const createdAt = this.options.now();
    const cwd = await this.options.resolveAndValidateCwd(input.cwd);

    const initialModel = requestedModelPreset
      ? resolveModelDescriptorFromPreset(requestedModelPreset)
      : input.modelSelection
        ? resolveExactManagerModelSelection(input.modelSelection, {
            surface: "create",
            providerAvailability: await this.options.getManagedModelProviderAvailability(),
            reasoningLevel: requestedReasoningLevel,
          })
        : this.options.resolveDefaultModelDescriptor();

    if (!input.modelSelection) {
      initialModel.thinkingLevel = normalizeThinkingLevelForModelDescriptor(initialModel, requestedReasoningLevel);
    }

    const descriptor: AgentDescriptor = {
      agentId: managerId,
      ...(input.controlCommandId ? { controlCommandId: input.controlCommandId } : {}),
      displayName: input.controlCommandId ? requestedName : managerId,
      role: "manager",
      managerId,
      profileId: managerId,
      archetypeId: MANAGER_ARCHETYPE_ID,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd,
      model: { ...initialModel },
      modelOrigin: "profile_default",
      sessionFile: getSessionFilePath(this.options.dataDir, managerId, managerId)
    };

    this.options.materializeSortOrder();

    for (const existingProfile of this.options.profiles.values()) {
      existingProfile.sortOrder = (existingProfile.sortOrder ?? 0) + 1;
      this.options.descriptorMutations.upsertProfile(existingProfile);
    }

    const profile: ManagerProfile = {
      profileId: descriptor.agentId,
      displayName: descriptor.displayName,
      defaultSessionAgentId: descriptor.agentId,
      defaultModel: { ...initialModel },
      createdAt: descriptor.createdAt,
      updatedAt: descriptor.createdAt,
      sortOrder: 0,
      secureSessionsEnabled: input.secureSessionsEnabled ?? false,
    };

    let runtime: SwarmAgentRuntime | undefined;
    let persistedSystemPrompt: string | undefined;
    await this.options.sessionProvisioner.provisionSession({
      descriptor: descriptor as AgentDescriptor & { role: "manager"; profileId: string },
      profile,
      ensureProfilePiDirectories: true,
      initializeRuntime: async () => {
        const systemPrompt = await this.options.resolveSystemPromptForDescriptor(descriptor);
        runtime = await this.options.createRuntimeForDescriptor(descriptor, systemPrompt);
        this.options.attachRuntime(managerId, runtime);
        persistedSystemPrompt = runtime.getSystemPrompt?.() ?? systemPrompt;
      }
    });

    const contextUsage = runtime?.getContextUsage();
    descriptor.contextUsage = contextUsage;
    this.upsertDescriptor(descriptor);

    await this.options.captureSessionRuntimePromptMeta(descriptor, persistedSystemPrompt);
    await this.options.refreshSessionMetaStats(descriptor);
    await this.options.migrateLegacyProfileKnowledgeToReferenceDoc(profile.profileId);
    await this.options.saveStore();

    this.options.emitStatus(managerId, descriptor.status, runtime?.getPendingCount() ?? 0, contextUsage);
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();

    this.options.logDebug("manager:create", {
      callerAgentId,
      managerId,
      cwd: descriptor.cwd
    });

    await this.options.sendManagerBootstrapMessage(managerId);

    return cloneDescriptor(descriptor);
  }

  async deleteManager(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{ managerId: string; terminatedWorkerIds: string[] }> {
    if (callerAgentId) this.options.assertManager(callerAgentId, "delete managers");

    const profile = this.options.profiles.get(targetManagerId);
    const sessionDescriptors = profile ? this.options.getSessionsForProfile(profile.profileId) : [];

    if (sessionDescriptors.length === 0) {
      const target = this.options.descriptors.get(targetManagerId);
      if (!target || target.role !== "manager") {
        throw new Error(`Unknown manager: ${targetManagerId}`);
      }
      sessionDescriptors.push(target as ProvisionedSessionDescriptor);
    }

    const terminatedWorkerIds: string[] = [];
    const workerDescriptors: AgentDescriptor[] = [];
    const terminationFailures: unknown[] = [];

    // Delete/terminate is explicit lifecycle suppression, not a completed work
    // epoch. Retire before direct status mutations can look quiescent.
    for (const sessionDescriptor of sessionDescriptors) {
      await this.options.suppressSessionAttention(sessionDescriptor.agentId);
    }

    for (const sessionDescriptor of sessionDescriptors) {
      for (const workerDescriptor of this.options.getWorkersForManager(sessionDescriptor.agentId)) {
        terminatedWorkerIds.push(workerDescriptor.agentId);
        workerDescriptors.push(workerDescriptor);
        try {
          await this.terminateDescriptor(workerDescriptor, {
            abort: true,
            emitStatus: true,
          });
          if (workerDescriptor.status !== "terminated") {
            terminationFailures.push(
              new Error(`agent_cleanup_incomplete: ${workerDescriptor.agentId}`),
            );
          }
        } catch (error) {
          terminationFailures.push(error);
        }
      }

      try {
        await this.terminateDescriptor(sessionDescriptor, {
          abort: true,
          emitStatus: true,
        });
        if (sessionDescriptor.status !== "terminated") {
          terminationFailures.push(
            new Error(`agent_cleanup_incomplete: ${sessionDescriptor.agentId}`),
          );
        }
      } catch (error) {
        terminationFailures.push(error);
      }
    }

    if (terminationFailures.length > 0) {
      await this.options.saveStore();
      this.options.emitAgentsSnapshot();
      this.options.emitProfilesSnapshot();
      throw new AggregateError(
        terminationFailures,
        `agent_cleanup_failed: ${targetManagerId}`,
      );
    }

    for (const workerDescriptor of workerDescriptors) {
      this.deleteDescriptor(workerDescriptor.agentId);
      this.options.deleteConversationHistory(
        workerDescriptor.agentId,
        workerDescriptor.sessionFile,
      );
    }
    for (const sessionDescriptor of sessionDescriptors) {
      this.deleteDescriptor(sessionDescriptor.agentId);
      this.options.deleteConversationHistory(sessionDescriptor.agentId, sessionDescriptor.sessionFile);
    }

    if (profile) {
      this.deleteProfile(profile.profileId);
    } else {
      this.deleteProfile(targetManagerId);
    }

    const schedulesProfileId = profile?.profileId ?? sessionDescriptors[0]?.profileId ?? targetManagerId;
    await this.options.deleteManagerSchedulesFile(schedulesProfileId);

    await this.options.saveStore();
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();

    this.options.logDebug("manager:delete", {
      callerAgentId,
      targetManagerId,
      terminatedWorkerIds
    });

    return { managerId: targetManagerId, terminatedWorkerIds };
  }

  async notifySpecialistRosterChanged(profileId: string, options?: { sessionAgentId?: string }): Promise<void> {
    try {
      await this.syncWorkerSpecialistMetadataForProfile(profileId, options?.sessionAgentId);
    } catch (error) {
      this.options.logDebug("specialist:roster_change:sync:error", {
        profileId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const sessions = options?.sessionAgentId
      ? this.options.getSessionsForProfile(profileId).filter((session) => session.agentId === options.sessionAgentId)
      : this.options.getSessionsForProfile(profileId);
    const results = await Promise.allSettled(
      sessions.map((session) => this.applyManagerRuntimeRecyclePolicy(session.agentId, "specialist_roster_change")),
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        this.options.logDebug("specialist:roster_change:recycle:error", {
          profileId,
          agentId: sessions[index]?.agentId,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      }
    });
  }

  async reconcileWorkerSpecialistMetadataForBoot(): Promise<void> {
    const profileIds = new Set(this.options.profiles.keys());
    for (const descriptor of this.options.descriptors.values()) {
      if (descriptor.profileId) {
        profileIds.add(descriptor.profileId);
      }
    }

    for (const profileId of profileIds) {
      try {
        await this.syncWorkerSpecialistMetadataForProfile(profileId, undefined, {
          persist: false,
          publish: false,
        });
      } catch (error) {
        this.options.logDebug("specialist:boot_metadata_sync:error", {
          profileId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async syncWorkerSpecialistMetadataForProfile(
    profileId: string,
    sessionAgentId?: string,
    options?: { persist?: boolean; publish?: boolean },
  ): Promise<void> {
    if (sessionAgentId) {
      const manager = this.options.descriptors.get(sessionAgentId);
      const roster = manager && this.options.resolveSpecialistRosterForManager
        ? await this.options.resolveSpecialistRosterForManager(manager)
        : [];
      await this.syncWorkerSpecialistMetadata(profileId, roster, sessionAgentId, options);
      return;
    }

    if (this.options.resolveSpecialistRosterForManager) {
      const sessions = this.options.getSessionsForProfile(profileId);
      await Promise.all(sessions.map(async (manager) => {
        const roster = await this.options.resolveSpecialistRosterForManager!(manager);
        await this.syncWorkerSpecialistMetadata(profileId, roster, manager.agentId, options);
      }));
      return;
    }

    const roster = await this.options.resolveSpecialistRosterForProfile(profileId);
    await this.syncWorkerSpecialistMetadata(profileId, roster, undefined, options);
  }

  async notifyProjectAgentsChanged(profileId: string): Promise<void> {
    const sessions = this.options.getSessionsForProfile(profileId);
    const results = await Promise.allSettled(
      sessions.map((session) => this.applyManagerRuntimeRecyclePolicy(session.agentId, "project_agent_directory_change")),
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        this.options.logDebug("project_agents:directory_change:recycle:error", {
          profileId,
          agentId: sessions[index]?.agentId,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      }
    });
  }

  shouldRestoreRuntimeForDescriptor(descriptor: AgentDescriptor): boolean {
    if (isExternalThreadDescriptor(descriptor)) {
      return false;
    }

    return descriptor.status === "streaming";
  }

  async getOrCreateRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    requirements?: RuntimeAcquisitionRequirements,
  ): Promise<SwarmAgentRuntime> {
    assertForgeRuntimeEligibleDescriptor(descriptor, "get or create runtime");
    this.options.assertRuntimeCreationAllowed(descriptor.agentId);

    if (
      descriptor.role === "worker"
      && this.options.runtimeRecoveryState.hasPendingManagerRuntimeRecycle(
        descriptor.agentId,
      )
    ) {
      // Team Secure Mode may begin while this worker is finishing an ordinary
      // turn. Apply that deferred runtime boundary before the next assignment
      // can reuse the worker; the secure requirement below remains fail-closed
      // if the worker has not actually become idle yet.
      await this.applyAgentRuntimeRecyclePolicy(
        descriptor.agentId,
        "idle_transition",
      );
    }

    const inFlightCreation = this.getRuntimeCreationPromise(descriptor.agentId);
    if (inFlightCreation) {
      return this.assertRuntimeMeetsCreationRequirements(
        descriptor.agentId,
        await inFlightCreation,
        requirements,
      );
    }

    const existingRuntime = this.getRuntime(descriptor.agentId);
    if (existingRuntime) {
      const hasStaleSecureBinding =
        this.options.hasSecureRuntimeBinding(existingRuntime)
        && !this.options.isSecureRuntimeBindingUsable(
          descriptor.agentId,
          existingRuntime,
        );
      if (!hasStaleSecureBinding) {
        return this.assertRuntimeMeetsCreationRequirements(
          descriptor.agentId,
          existingRuntime,
          requirements,
        );
      }
      if (!this.canRecycleAgentRuntimeImmediately(descriptor, existingRuntime)) {
        throw new Error(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);
      }
      await this.recycleAgentRuntime(
        descriptor,
        existingRuntime,
        "secure_session_mode_change",
      );
    }

    // Pending creation must own its token before asynchronous preparation so
    // lifecycle invalidation cannot be followed by allocating a fresh token.
    const runtimeToken = this.options.allocateRuntimeToken(descriptor.agentId);
    const creationPromise = (async () => {
      try {
        if (descriptor.role === "worker") {
          await this.options.secureWorkers.prepareWorkerForSecureTeam(
            descriptor.agentId,
          );
        }
        return await this.createAndAttachRuntimeForDescriptor(descriptor, runtimeToken, requirements);
      } catch (error) {
        const attachedRuntime = this.options.runtimes.get(descriptor.agentId);
        const ownsAttachedRuntime =
          attachedRuntime !== undefined
          && this.options.getRuntimeToken(descriptor.agentId) === runtimeToken;
        if (!ownsAttachedRuntime) {
          this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
        }
        throw error;
      }
    })();
    this.setRuntimeCreationPromise(descriptor.agentId, creationPromise);

    try {
      return this.assertRuntimeMeetsCreationRequirements(
        descriptor.agentId,
        await creationPromise,
        requirements,
      );
    } finally {
      this.clearRuntimeCreationPromiseIfCurrent(descriptor.agentId, creationPromise);
    }
  }

  resolveSpawnModel(input: SpawnAgentInput, fallback: AgentModelDescriptor): AgentModelDescriptor {
    const requestedPreset = parseSwarmModelPreset(input.model, "spawn_agent.model");
    const requestedReasoningLevel = parseSwarmReasoningLevel(
      input.reasoningLevel,
      "spawn_agent.reasoningLevel"
    );

    const descriptor = requestedPreset
      ? resolveModelDescriptorFromPreset(requestedPreset)
      : {
          ...fallback,
          modelId: normalizeOptionalModelId(fallback.modelId) ?? fallback.modelId,
          provider: normalizeOptionalAgentId(fallback.provider) ?? fallback.provider,
          thinkingLevel: fallback.thinkingLevel
        };

    const requestedModelId = normalizeOptionalModelId(input.modelId);
    if (requestedModelId) {
      assertSwarmModelIdNotRetired(descriptor.provider, requestedModelId, "spawn_agent.modelId");
      descriptor.modelId = requestedModelId;
    }

    if (requestedReasoningLevel) {
      descriptor.thinkingLevel = requestedReasoningLevel;
    }

    descriptor.thinkingLevel = normalizeThinkingLevelForModelDescriptor(descriptor);

    return descriptor;
  }

  async resolveWorkerAssignmentSelection(worker: AgentDescriptor, requiresSecureRuntime: boolean, maxConcurrent?: number): Promise<AssignmentSelection> {
    const manager = this.options.descriptors.get(worker.managerId);
    if (worker.role !== "worker" || !manager || manager.role !== "manager") throw new Error("Assignment worker owner conflicts");
    const model = worker.model;
    return {
      specialistId: worker.specialistId, provider: model.provider, modelId: model.modelId, maxConcurrent,
      candidates: [{ provider: model.provider, modelId: model.modelId,
        available: this.isWorkerModelAvailable(model, await this.options.getManagedModelProviderAvailability(), requiresSecureRuntime),
      }],
    };
  }

  /** The one worker-model admission rule: spawn checks it up front so assignment never refuses a worker it created. */
  private isWorkerModelAvailable(model: Pick<AgentModelDescriptor, "provider" | "modelId">, availability: ReadonlyMap<string, boolean>, requiresSecureRuntime: boolean): boolean {
    return availability.get(resolveModelCredentialProvider(model)) === true && !this.getActiveModelCapacityBlock(model.provider, model.modelId)
      && (!requiresSecureRuntime || supportsSecureRuntimeProvider(model.provider));
  }

  private async assertWorkerModelAvailable(manager: AgentDescriptor, model: AgentModelDescriptor, input: SpawnAgentInput, preset: ResolvedWorkerPreset | undefined): Promise<void> {
    const secure = input.requiresSecureRuntime === true;
    const availability = await this.options.getManagedModelProviderAvailability();
    if (this.isWorkerModelAvailable(model, availability, secure)) return;
    const usable = (await this.resolveWorkerPresetsForManager(manager))
      .filter(entry => this.isWorkerModelAvailable(entry, availability, secure)).map(entry => entry.name);
    const choices = usable.length > 0 ? `Available presets: ${usable.join(", ")}.` : "No preset has an available model.";
    throw new Error(input.preset !== undefined && preset
      ? `Preset "${preset.name}" uses a model that is not available: ${model.provider}/${model.modelId}. ${choices}`
      : `Worker model is not available: ${model.provider}/${model.modelId}. ${choices} Or sign in to that provider in Settings > Authentication.`);
  }

  private resolveSpecialistRoster(manager: AgentDescriptor): Promise<ResolvedSpecialistDefinitionLike[]> {
    return this.options.resolveSpecialistRosterForManager
      ? this.options.resolveSpecialistRosterForManager(manager)
      : this.options.resolveSpecialistRosterForProfile(manager.profileId ?? manager.agentId);
  }

  /** The global preset list plus user-authored specialist files; a file wins a name collision. */
  async resolveWorkerPresetsForManager(manager: AgentDescriptor): Promise<ResolvedWorkerPreset[]> {
    const [settings, roster] = await Promise.all([
      readWorkerPresetSettings(this.options.dataDir),
      this.resolveSpecialistRoster(manager),
    ]);
    return mergeWorkerPresets(settings.presets, specialistsToWorkerPresets(roster, manager.model));
  }

  resolveSpawnModelWithCapacityFallback(model: AgentModelDescriptor): AgentModelDescriptor {
    const provider = normalizeOptionalAgentId(model.provider)?.toLowerCase();
    const requestedModelId = normalizeOptionalModelId(model.modelId)?.toLowerCase();
    if (!provider || !requestedModelId) {
      return model;
    }

    const requestedBlock = this.getActiveModelCapacityBlock(provider, requestedModelId);
    if (!requestedBlock) {
      return model;
    }

    const attemptedModelIds: string[] = [requestedModelId];
    let candidateModelId = requestedModelId;

    while (true) {
      const nextModelId = resolveNextCapacityFallbackModelId(provider, candidateModelId);
      if (!nextModelId) {
        this.options.logDebug("agent:spawn:model_blocked_no_fallback", {
          provider,
          requestedModelId,
          blockedUntil: new Date(requestedBlock.blockedUntilMs).toISOString(),
          attemptedModelIds
        });
        return model;
      }

      attemptedModelIds.push(nextModelId);

      const nextBlock = this.getActiveModelCapacityBlock(provider, nextModelId);
      if (!nextBlock) {
        this.options.logDebug("agent:spawn:model_reroute", {
          provider,
          requestedModelId,
          selectedModelId: nextModelId,
          attemptedModelIds
        });
        const fallbackModel = {
          ...model,
          modelId: nextModelId
        };
        return {
          ...fallbackModel,
          thinkingLevel: normalizeThinkingLevelForModelDescriptor(fallbackModel)
        };
      }

      candidateModelId = nextModelId;
    }
  }

  async stopSessionInternal(
    agentId: string,
    options: AgentLifecycleStopSessionOptions
  ): Promise<{ terminatedWorkerIds: string[]; unsafeShutdownAgentIds: string[] }> {
    const descriptor = this.options.getRequiredSessionDescriptor(agentId);
    // A repeated stop is the cleanup retry for a shutdown that is already reported as unconfirmed.
    const cleanupRetry = this.options.isRuntimeShutdownQuarantined(agentId);
    await this.options.suppressSessionAttention(descriptor.agentId);
    const terminatedWorkerIds: string[] = [];
    const terminatedWorkerDescriptors: AgentDescriptor[] = [];
    const unsafeShutdownAgentIds: string[] = [];
    const interruptedWorkerIds: string[] = [];
    const workerCleanupFailures: unknown[] = [];
    const runtime = this.options.runtimes.get(agentId);
    const shouldEmitManualStopNotice = (options.manualStopNotice ?? true) && !options.deleteWorkers;
    const shouldAllowManualStopMessageEnd =
      shouldEmitManualStopNotice &&
      runtime !== undefined &&
      (descriptor.status === "streaming" || runtime.getStatus() === "streaming");
    if (shouldAllowManualStopMessageEnd) {
      this.options.markPendingManualManagerStopNotice(agentId);
    }

    const invalidatedManagerRuntime = this.invalidateManagerRuntimeBeforeWorkerTeardown(agentId, {
      allowManualStopMessageEnd: shouldAllowManualStopMessageEnd
    });

    // Spawn is a bounded manager admission through registration and initial
    // delivery. Drain it before taking the worker snapshot so no child can
    // appear after teardown has chosen the runtimes it must settle.
    await this.options.waitForRuntimeAdmissions(agentId);

    for (const workerDescriptor of this.options.getWorkersForManager(agentId)) {
      if (shouldPreserveExternalThreadWorkerOnSessionStop(workerDescriptor, options.deleteWorkers)) {
        if (shouldInterruptExternalThreadSidecar(workerDescriptor)) {
          interruptedWorkerIds.push(workerDescriptor.agentId);
          await this.interruptExternalThreadWorker(workerDescriptor, { abort: true, emitStatus: true });
          await this.options.updateSessionMetaForWorkerDescriptor(workerDescriptor);
        }
        continue;
      }

      try {
        await this.terminateDescriptor(workerDescriptor, {
          abort: true,
          emitStatus: true,
        });
      } catch (error) {
        workerCleanupFailures.push(error);
        unsafeShutdownAgentIds.push(workerDescriptor.agentId);
        continue;
      }
      if (workerDescriptor.status !== "terminated") {
        unsafeShutdownAgentIds.push(workerDescriptor.agentId);
        continue;
      }
      terminatedWorkerIds.push(workerDescriptor.agentId);
      terminatedWorkerDescriptors.push(workerDescriptor);
    }

    if (shouldAllowManualStopMessageEnd) {
      this.options.markPendingManualManagerStopNotice(agentId);
      this.options.allowInvalidatedManualStopMessageEnd(agentId, invalidatedManagerRuntime.runtimeToken);
    }
    const managerShutdownIncomplete = await this.shutdownLatestManagerRuntime(
      descriptor,
      "terminate",
      invalidatedManagerRuntime,
    );
    this.clearPendingManagerRuntimeRecycle(agentId);
    if (shouldAllowManualStopMessageEnd && !managerShutdownIncomplete) this.options.settlePendingManualManagerStopNotice(agentId);

    if (!managerShutdownIncomplete) {
      await this.options.reconcileStoppedManagerRuntime({
        agentId,
        turnId: invalidatedManagerRuntime.turnId,
      });
    }

    if (managerShutdownIncomplete) {
      unsafeShutdownAgentIds.push(agentId);
      if (!cleanupRetry) {
        this.options.emitImmediateManualManagerStopNotice(
          agentId,
          MANUAL_MANAGER_STOP_INCOMPLETE_NOTICE,
        );
      }
    }

    if (unsafeShutdownAgentIds.length === 0) {
      for (const workerDescriptor of terminatedWorkerDescriptors) {
        if (options.deleteWorkers) {
          this.deleteDescriptor(workerDescriptor.agentId);
        }
        this.options.deleteConversationHistory(workerDescriptor.agentId, workerDescriptor.sessionFile);
      }
    }

    if (
      shouldEmitManualStopNotice &&
      !shouldAllowManualStopMessageEnd &&
      !managerShutdownIncomplete &&
      (terminatedWorkerIds.length > 0 || interruptedWorkerIds.length > 0 || runtime !== undefined)
    ) {
      this.options.emitImmediateManualManagerStopNotice(agentId);
    }

    descriptor.status = managerShutdownIncomplete
      ? "stopped"
      : descriptor.status === "error"
        ? "idle"
        : transitionAgentStatus(descriptor.status, "idle");
    descriptor.contextUsage = undefined;
    descriptor.updatedAt = this.options.now();
    this.upsertDescriptor(descriptor);

    if (options.emitStatus ?? true) {
      this.options.emitStatus(agentId, descriptor.status, 0);
    }

    await this.options.refreshSessionMetaStatsBySessionId(agentId);

    if (options.saveStore) {
      await this.options.saveStore();
    }

    if (options.emitSnapshots) {
      this.options.emitAgentsSnapshot();
      this.options.emitProfilesSnapshot();
    }

    if (workerCleanupFailures.length > 0) {
      throw new AggregateError(
        workerCleanupFailures,
        `worker_cleanup_failed: ${agentId}`,
      );
    }

    return { terminatedWorkerIds, unsafeShutdownAgentIds };
  }

  /** Saved CLI credentials or API access changed; active work finishes before its provider is replaced. */
  async notifyNativeAuthChanged(provider: "claude-native" | "codex-native"): Promise<void> {
    const agents = [...this.options.descriptors.values()].filter(descriptor =>
      descriptor.model.provider === provider,
    );
    const results = await Promise.allSettled(agents.map(descriptor =>
      this.applyAgentRuntimeRecyclePolicy(descriptor.agentId, "auth_source_change"),
    ));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Native session refresh failed");
  }

  async applyManagerRuntimeRecyclePolicy(
    agentId: string,
    reason: ManagerRuntimeRecycleReason
  ): Promise<"recycled" | "deferred" | "none"> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      this.clearPendingManagerRuntimeRecycle(agentId);
      return "none";
    }

    return this.applyAgentRuntimeRecyclePolicy(agentId, reason);
  }

  async applyAgentRuntimeRecyclePolicy(
    agentId: string,
    reason: ManagerRuntimeRecycleReason
  ): Promise<"recycled" | "deferred" | "none"> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || isExternalThreadDescriptor(descriptor)) {
      this.clearPendingManagerRuntimeRecycle(agentId);
      return "none";
    }

    if (reason === "auth_source_change") {
      // The core owns provider bindings: it replaces this one at the thread's next idle boundary
      // and resumes the same conversation. Recycling the runtime here would strand that binding.
      if (!this.refreshProviderContext) return "none";
      await this.refreshProviderContext(agentId);
      return "deferred";
    }

    if (reason === "idle_transition" && !this.options.runtimeRecoveryState.hasPendingManagerRuntimeRecycle(agentId)) {
      return "none";
    }

    const effectiveReason =
      reason === "idle_transition"
        ? this.options.runtimeRecoveryState.getPendingManagerRuntimeRecycleReason(agentId) ?? reason
        : reason;

    const runtime = this.options.runtimes.get(agentId);
    if (!runtime) {
      this.clearPendingManagerRuntimeRecycle(agentId);
      return "none";
    }

    if (!this.canRecycleAgentRuntimeImmediately(descriptor, runtime)) {
      this.setPendingManagerRuntimeRecycle(agentId, effectiveReason);
      return "deferred";
    }

    await this.recycleAgentRuntime(descriptor, runtime, effectiveReason);
    return "recycled";
  }

  async terminateDescriptor(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean }
  ): Promise<void> {
    await this.terminateDescriptorRuntime(descriptor, options);
  }

  private async terminateDescriptorRuntime(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean }
  ): Promise<void> {
    this.options.cancelAllPendingChoicesForAgent(descriptor.agentId);

    if (isExternalThreadDescriptor(descriptor)) {
      await this.cleanupExternalThreadWorkerForTermination(descriptor);
      this.clearPendingManagerRuntimeRecycle(descriptor.agentId);
      this.options.clearAgentTurnState(descriptor.agentId);

      descriptor.status = transitionAgentStatus(descriptor.status, "terminated");
      descriptor.contextUsage = undefined;
      descriptor.streamingStartedAt = undefined;
      descriptor.updatedAt = this.options.now();
      this.upsertDescriptor(descriptor);

      await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
      await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);

      if (options.emitStatus) {
        this.options.emitStatus(descriptor.agentId, descriptor.status, 0);
      }
      return;
    }

    if (descriptor.role === "worker") {
      this.clearWorkerTeardownState(descriptor.agentId);
      const shutdownIncomplete = await this.shutdownWorkerRuntimeWithSuppressedCallbacks(
        descriptor,
        "terminate",
        { abort: options.abort },
      );
      this.clearWorkerTeardownState(descriptor.agentId);
      if (shutdownIncomplete) {
        this.clearPendingManagerRuntimeRecycle(descriptor.agentId);
        this.options.clearAgentTurnState(descriptor.agentId);
        descriptor.status = "stopped";
        descriptor.contextUsage = undefined;
        descriptor.updatedAt = this.options.now();
        this.upsertDescriptor(descriptor);
        await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
        await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);
        if (options.emitStatus) {
          this.options.emitStatus(descriptor.agentId, descriptor.status, 0);
        }
        this.options.emitImmediateManualManagerStopNotice(
          descriptor.managerId,
          formatWorkerStopIncompleteNotice([descriptor.agentId]),
        );
        return;
      }
    } else {
      let shutdownIncomplete = false;
      const runtime = this.options.runtimes.get(descriptor.agentId);
      if (runtime || this.options.isRuntimeShutdownQuarantined(descriptor.agentId)) {
        const shutdown = await this.options.runRuntimeShutdown(descriptor, "terminate", { abort: options.abort });
        this.options.detachRuntime(descriptor.agentId, shutdown.runtimeToken);
        shutdownIncomplete = shutdown.status !== "clean";
      }
      if (shutdownIncomplete) {
        this.clearPendingManagerRuntimeRecycle(descriptor.agentId);
        descriptor.status = "stopped";
        descriptor.contextUsage = undefined;
        descriptor.updatedAt = this.options.now();
        this.upsertDescriptor(descriptor);
        await this.options.refreshSessionMetaStats(descriptor);
        if (options.emitStatus) {
          this.options.emitStatus(descriptor.agentId, descriptor.status, 0);
        }
        this.options.emitImmediateManualManagerStopNotice(
          descriptor.agentId,
          MANUAL_MANAGER_STOP_INCOMPLETE_NOTICE,
        );
        return;
      }
    }
    this.clearPendingManagerRuntimeRecycle(descriptor.agentId);
    this.options.clearAgentTurnState(descriptor.agentId);

    descriptor.status = transitionAgentStatus(descriptor.status, "terminated");
    descriptor.contextUsage = undefined;
    descriptor.updatedAt = this.options.now();
    this.upsertDescriptor(descriptor);

    if (descriptor.role === "worker") {
      await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
      await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);
    } else {
      await this.options.refreshSessionMetaStats(descriptor);
    }

    if (options.emitStatus) {
      this.options.emitStatus(descriptor.agentId, descriptor.status, 0);
    }
  }

  async syncWorkerSpecialistMetadata(
    profileId: string,
    roster: ResolvedSpecialistDefinitionLike[],
    managerId?: string,
    options?: { persist?: boolean; publish?: boolean },
  ): Promise<void> {
    const rosterById = new Map(roster.map((entry) => [entry.specialistId, entry]));
    let changed = false;

    for (const descriptor of this.options.descriptors.values()) {
      if (descriptor.role !== "worker" || descriptor.profileId !== profileId) {
        continue;
      }

      if (isExternalThreadDescriptor(descriptor)) {
        continue;
      }

      if (managerId && descriptor.managerId !== managerId) {
        continue;
      }

      const specialistId = normalizeOptionalAgentId(descriptor.specialistId)?.toLowerCase();
      if (!specialistId) {
        continue;
      }

      const specialist = rosterById.get(specialistId);
      if (!specialist) {
        continue;
      }

      if (
        descriptor.specialistId === specialist.specialistId &&
        descriptor.specialistDisplayName === specialist.displayName &&
        descriptor.specialistColor === specialist.color
      ) {
        continue;
      }

      descriptor.specialistId = specialist.specialistId;
      descriptor.specialistDisplayName = specialist.displayName;
      descriptor.specialistColor = specialist.color;
      this.upsertDescriptor(descriptor);
      changed = true;
    }

    if (!changed) {
      return;
    }

    if (options?.persist !== false) {
      await this.options.saveStore();
    }
    if (options?.publish !== false) {
      this.options.emitAgentsSnapshot();
    }
  }

  private canRecycleAgentRuntimeImmediately(
    descriptor: AgentDescriptor,
    runtime: SwarmAgentRuntime
  ): boolean {
    return (
      descriptor.status === "idle" &&
      runtime.getStatus() === "idle" &&
      runtime.getPendingCount() === 0 &&
      !isRuntimeRecoveryActiveForRuntime(runtime)
    );
  }

  private async recycleAgentRuntime(
    descriptor: AgentDescriptor,
    runtime: SwarmAgentRuntime,
    reason: ManagerRuntimeRecycleReason
  ): Promise<void> {
    const runtimeToken = this.options.getRuntimeToken(descriptor.agentId);
    this.clearPendingManagerRuntimeRecycle(descriptor.agentId);

    try {
      if (reason === "model_change") {
        await runtime.shutdownForReplacement();
      } else {
        await runtime.recycle();
      }
    } catch (error) {
      this.setPendingManagerRuntimeRecycle(descriptor.agentId, reason);
      throw error;
    }

    this.options.detachRuntime(descriptor.agentId, runtimeToken);

    if (descriptor.contextUsage) {
      descriptor.contextUsage = undefined;
      this.upsertDescriptor(descriptor);
    }

    if (descriptor.role === "worker") {
      await this.options.updateSessionMetaForWorkerDescriptor(descriptor);
      await this.options.refreshSessionMetaStatsBySessionId(
        descriptor.managerId,
      );
    } else {
      await this.options.refreshSessionMetaStats(descriptor);
    }

    this.options.emitStatus(descriptor.agentId, descriptor.status, 0);
    this.options.logDebug("agent:runtime_recycled", {
      agentId: descriptor.agentId,
      role: descriptor.role,
      profileId: descriptor.profileId,
      reason,
      model: descriptor.model
    });
  }

  private setPendingManagerRuntimeRecycle(agentId: string, reason: ManagerRuntimeRecycleReason): void {
    this.options.runtimeRecoveryState.setPendingManagerRuntimeRecycle(agentId, reason);
  }

  private clearPendingManagerRuntimeRecycle(agentId: string): void {
    this.options.runtimeRecoveryState.clearPendingManagerRuntimeRecycle(agentId);
  }

  private async createAndAttachRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    runtimeToken: number,
    requirements?: RuntimeAcquisitionRequirements,
  ): Promise<SwarmAgentRuntime> {
    await this.options.ensureSessionFileParentDirectory(descriptor.sessionFile);

    const existingRuntime = this.options.runtimes.get(descriptor.agentId);
    if (existingRuntime) {
      return existingRuntime;
    }

    const resolvedSystemPrompt =
      await this.options.resolveSystemPromptForDescriptor(descriptor);
    const systemPrompt =
      descriptor.role === "worker"
        ? this.options.injectWorkerIdentityContext(
            descriptor,
            resolvedSystemPrompt,
          )
        : resolvedSystemPrompt;
    const runtimeBeforeCreate = this.options.runtimes.get(descriptor.agentId);
    if (runtimeBeforeCreate) {
      return runtimeBeforeCreate;
    }

    const runtime = await this.options.createRuntimeForDescriptor(
      descriptor,
      systemPrompt,
      runtimeToken,
      requirements?.secureRuntimeRequired ? { secureRuntimeRequired:true } : undefined
    );
    if (descriptor.role === "manager") {
      await this.options.syncPinnedContentForManagerRuntime(descriptor as ProvisionedSessionDescriptor, { runtime });
    }
    const persistedSystemPrompt = runtime.getSystemPrompt?.() ?? systemPrompt;

    const latestDescriptor = this.options.getAgentForInternalUse(descriptor.agentId);
    if (!latestDescriptor || isNonRunningAgentStatus(latestDescriptor.status)) {
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: DEFAULT_RUNTIME_SHUTDOWN_TIMEOUT_MS,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw new Error(`Target agent is not running: ${descriptor.agentId}`);
    }

    const concurrentRuntime = this.options.runtimes.get(descriptor.agentId);
    if (concurrentRuntime) {
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: DEFAULT_RUNTIME_SHUTDOWN_TIMEOUT_MS,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      return concurrentRuntime;
    }

    let attachDescriptor = this.options.getAgentForInternalUse(descriptor.agentId);
    if (!attachDescriptor || isNonRunningAgentStatus(attachDescriptor.status)) {
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: DEFAULT_RUNTIME_SHUTDOWN_TIMEOUT_MS,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw new Error(`Target agent is not running: ${descriptor.agentId}`);
    }

    const attachConcurrentRuntime = this.options.runtimes.get(descriptor.agentId);
    if (attachConcurrentRuntime) {
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: DEFAULT_RUNTIME_SHUTDOWN_TIMEOUT_MS,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      return attachConcurrentRuntime;
    }

    if (this.options.getRuntimeToken(descriptor.agentId) !== runtimeToken) {
      this.options.logDebug("manager:model_change_continuity:pre_write_attach_rejected", {
        agentId: descriptor.agentId,
        reason: "stale_runtime_token"
      });
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: DEFAULT_RUNTIME_SHUTDOWN_TIMEOUT_MS,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw new Error(`Runtime token is stale for agent: ${descriptor.agentId}`);
    }

    const postWriteDescriptor = this.options.getAgentForInternalUse(descriptor.agentId);
    if (!postWriteDescriptor || isNonRunningAgentStatus(postWriteDescriptor.status)) {
      this.options.logDebug("manager:model_change_continuity:post_write_attach_rejected", {
        agentId: descriptor.agentId,
        reason: postWriteDescriptor ? "not_running" : "missing_descriptor"
      });
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: DEFAULT_RUNTIME_SHUTDOWN_TIMEOUT_MS,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw new Error(`Target agent is not running: ${descriptor.agentId}`);
    }

    const postWriteConcurrentRuntime = this.options.runtimes.get(descriptor.agentId);
    if (postWriteConcurrentRuntime) {
      this.options.logDebug("manager:model_change_continuity:post_write_attach_rejected", {
        agentId: descriptor.agentId,
        reason: "concurrent_runtime"
      });
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: DEFAULT_RUNTIME_SHUTDOWN_TIMEOUT_MS,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      return postWriteConcurrentRuntime;
    }

    if (this.options.getRuntimeToken(descriptor.agentId) !== runtimeToken) {
      this.options.logDebug("manager:model_change_continuity:post_write_attach_rejected", {
        agentId: descriptor.agentId,
        reason: "stale_runtime_token"
      });
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: DEFAULT_RUNTIME_SHUTDOWN_TIMEOUT_MS,
      });
      this.options.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw new Error(`Runtime token is stale for agent: ${descriptor.agentId}`);
    }

    attachDescriptor = postWriteDescriptor;
    this.options.attachRuntime(descriptor.agentId, runtime);

    const contextUsage = runtime.getContextUsage();
    attachDescriptor.contextUsage = contextUsage;
    this.upsertDescriptor(attachDescriptor);

    if (attachDescriptor.role === "manager") {
      await this.options.captureSessionRuntimePromptMeta(attachDescriptor, persistedSystemPrompt);
      await this.options.refreshSessionMetaStats(attachDescriptor);
    } else {
      await this.options.updateSessionMetaForWorkerDescriptor(attachDescriptor, persistedSystemPrompt);
      await this.options.refreshSessionMetaStatsBySessionId(attachDescriptor.managerId);
    }

    this.options.emitStatus(descriptor.agentId, attachDescriptor.status, runtime.getPendingCount(), contextUsage);
    return runtime;
  }

  private assertRuntimeMeetsCreationRequirements(
    agentId: string,
    runtime: SwarmAgentRuntime,
    requirements?: RuntimeAcquisitionRequirements,
  ): SwarmAgentRuntime {
    if (
      requirements?.secureRuntimeRequired
      && !this.options.isSecureRuntimeBindingUsable(agentId, runtime)
    ) {
      throw new Error(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);
    }
    return runtime;
  }

  private getActiveModelCapacityBlock(provider: string, modelId: string): ModelCapacityBlockLike | undefined {
    const key = buildModelCapacityBlockKey(provider, modelId);
    if (!key) {
      return undefined;
    }

    const block = this.options.modelCapacityBlocks.get(key);
    if (!block) {
      return undefined;
    }

    if (Date.now() >= block.blockedUntilMs) {
      this.options.modelCapacityBlocks.delete(key);
      this.options.logDebug("model_capacity:block_expired", {
        provider: block.provider,
        modelId: block.modelId,
        blockedUntil: new Date(block.blockedUntilMs).toISOString()
      });
      return undefined;
    }

    return block;
  }
}
