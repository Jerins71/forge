import { normalizeArchetypeId, type PromptRegistry } from "./prompts/prompt-registry.js";
import { ProjectResourceSettingsStore } from "./project-resource-settings.js";
import { ProjectWorkspaceResolver } from "./project-workspace-resolver.js";
import { classifyRuntimeCapacityError } from "./runtime/runtime-utils.js";
import type { SkillMetadata, SkillMetadataService } from "./skills/skill-metadata-service.js";
import {
  normalizeSpecialistHandle,
  resolveRoster,
  resolveWorkspaceRoster,
} from "./agents/specialists/specialist-registry.js";
import type {
  AgentDescriptor,
  SpawnAgentInput,
  SwarmConfig,
  SwarmReasoningLevel,
} from "./types.js";
import type { RuntimeErrorEvent } from "./runtime-contracts.js";
import {
  buildModelCapacityBlockKey,
  clampModelCapacityBlockDurationMs,
  normalizeOptionalAgentId,
  normalizeOptionalModelId,
  previewForLog,
  readStringDetail,
} from "./swarm-manager-utils.js";

const MERGER_ARCHETYPE_ID = "merger";
const MODEL_CAPACITY_BLOCK_DEFAULT_MS = 10 * 60_000;

export interface ResolvedSpecialistDefinitionLike {
  specialistId: string;
  displayName: string;
  color: string;
  enabled: boolean;
  whenToUse: string;
  modelId?: string;
  provider?: string;
  reasoningLevel?: SwarmReasoningLevel;
  webSearch?: boolean;
  promptBody: string;
  available: boolean;
  availabilityCode?: string;
  availabilityMessage?: string;
}

export interface SpecialistRegistryModule {
  resolveRoster(profileId: string): Promise<ResolvedSpecialistDefinitionLike[]>;
  normalizeSpecialistHandle(value: string): string;
}

export interface ModelCapacityBlock {
  provider: string;
  modelId: string;
  blockedUntilMs: number;
  blockSetAt: string;
  sourcePhase: RuntimeErrorEvent["phase"];
  reason: string;
}

export interface PromptResourceCoordinatorOptions {
  config: SwarmConfig;
  promptRegistry: PromptRegistry;
  skillMetadataService: SkillMetadataService;
  getDescriptor(agentId: string): AgentDescriptor | undefined;
  applySpecialistAvailability(
    roster: ResolvedSpecialistDefinitionLike[],
    managerAgentId: string,
  ): ResolvedSpecialistDefinitionLike[] | Promise<ResolvedSpecialistDefinitionLike[]>;
  now: () => string;
  logDebug(message: string, details?: unknown): void;
}

/** A worker run refused by its provider for a reason other than capacity (auth, account, CLI version). */
export interface WorkerRunFailure {
  message: string;
  at: string;
}

/** Status codes and words that mark a provider, sign-in or version refusal rather than a task error. */
const PROVIDER_FAILURE_PATTERN = /\b(401|402|403|426)\b|unauthori[sz]ed|forbidden|authenticat|credential|api key|outdated|upgrade required|unsupported (cli|client)|version/i;

/** Resolves project-scoped prompt resources and owns transient model-capacity policy state. */
export class PromptResourceCoordinator {
  readonly modelCapacityBlocks = new Map<string, ModelCapacityBlock>();
  /** Latest provider refusal of a worker run, keyed by provider. Shown as a warning; spawn does not read it. */
  readonly workerRunFailures = new Map<string, WorkerRunFailure>();
  private specialistRegistryModulePromise: Promise<SpecialistRegistryModule> | null = null;

  constructor(private readonly options: PromptResourceCoordinatorOptions) {}

  maybeRecordModelCapacityBlock(
    agentId: string,
    descriptor: AgentDescriptor,
    error: RuntimeErrorEvent,
  ): void {
    if (descriptor.role !== "worker" || (error.phase !== "prompt_dispatch" && error.phase !== "prompt_start")) {
      return;
    }

    const classification = classifyRuntimeCapacityError(formatRuntimeErrorForCapacityClassification(error));
    if (!classification.isQuotaOrRateLimit) {
      const failedProvider = normalizeOptionalAgentId(descriptor.model.provider)?.toLowerCase();
      if (failedProvider && PROVIDER_FAILURE_PATTERN.test(error.message)) {
        this.workerRunFailures.set(failedProvider, { message: error.message, at: this.options.now() });
      }
      return;
    }

    const blockDurationMs = clampModelCapacityBlockDurationMs(
      classification.retryAfterMs ?? MODEL_CAPACITY_BLOCK_DEFAULT_MS,
    );
    const provider = normalizeOptionalAgentId(descriptor.model.provider)?.toLowerCase();
    const modelId = normalizeOptionalModelId(descriptor.model.modelId)?.toLowerCase();
    if (!blockDurationMs || !provider || !modelId) {
      return;
    }

    const key = buildModelCapacityBlockKey(provider, modelId);
    if (!key) {
      return;
    }

    const blockedUntilMs = Date.now() + blockDurationMs;
    const existing = this.modelCapacityBlocks.get(key);
    if (existing && existing.blockedUntilMs >= blockedUntilMs) {
      return;
    }

    this.modelCapacityBlocks.set(key, {
      provider,
      modelId,
      blockedUntilMs,
      blockSetAt: this.options.now(),
      sourcePhase: error.phase,
      reason: error.message,
    });
    this.options.logDebug("model_capacity:block_set", {
      agentId,
      provider,
      modelId,
      phase: error.phase,
      retryAfterMs: classification.retryAfterMs,
      blockDurationMs,
      blockedUntil: new Date(blockedUntilMs).toISOString(),
      messagePreview: previewForLog(error.message, 240),
    });
  }

  async resolveSpawnWorkerArchetypeId(
    input: SpawnAgentInput,
    normalizedAgentId: string,
    profileId: string,
  ): Promise<string | undefined> {
    if (input.archetypeId !== undefined) {
      const explicit = normalizeArchetypeId(input.archetypeId);
      if (!explicit) {
        throw new Error("spawn_agent archetypeId must include at least one letter or number");
      }
      if (!await this.options.promptRegistry.resolveEntry("archetype", explicit, profileId)) {
        throw new Error(`Unknown archetypeId: ${explicit}`);
      }
      return explicit;
    }

    return normalizedAgentId === MERGER_ARCHETYPE_ID || normalizedAgentId.startsWith(`${MERGER_ARCHETYPE_ID}-`)
      ? MERGER_ARCHETYPE_ID
      : undefined;
  }

  async loadSpecialistRegistryModule(): Promise<SpecialistRegistryModule> {
    if (!this.specialistRegistryModulePromise) {
      const dataDir = this.options.config.paths.dataDir;
      this.specialistRegistryModulePromise = Promise.resolve({
        resolveRoster: (profileId) =>
          resolveRoster(profileId, dataDir) as Promise<ResolvedSpecialistDefinitionLike[]>,
        normalizeSpecialistHandle,
      });
    }
    return this.specialistRegistryModulePromise;
  }

  async resolveSpecialistRosterForProfile(
    profileId: string,
    workspaceSpecialistsDir?: string,
  ): Promise<ResolvedSpecialistDefinitionLike[]> {
    if (workspaceSpecialistsDir) {
      return resolveWorkspaceRoster(
        profileId,
        this.options.config.paths.dataDir,
        workspaceSpecialistsDir,
      ) as Promise<ResolvedSpecialistDefinitionLike[]>;
    }
    return (await this.loadSpecialistRegistryModule()).resolveRoster(profileId);
  }

  async resolveSpecialistRosterForManager(manager: AgentDescriptor): Promise<ResolvedSpecialistDefinitionLike[]> {
    const workspace = await this.resolveProjectWorkspaceForManager(manager);
    const roster = await this.resolveSpecialistRosterForProfile(
      manager.profileId ?? manager.agentId,
      workspace?.repoRootResources.specialistsDir,
    );
    return this.options.applySpecialistAvailability(roster, manager.agentId);
  }

  async resolveProjectWorkspaceForManager(manager: AgentDescriptor) {
    const profileId = manager.profileId ?? manager.agentId;
    try {
      return await new ProjectWorkspaceResolver({
        dataDir: this.options.config.paths.dataDir,
        settingsStore: new ProjectResourceSettingsStore(this.options.config.paths.dataDir),
      }).resolvePassive({ profileId, sessionAgentId: manager.agentId, cwd: manager.cwd });
    } catch (error) {
      this.options.logDebug("project_resources:resolve:error", {
        agentId: manager.agentId,
        profileId,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async resolveSkillRosterForDescriptor(descriptor: AgentDescriptor): Promise<SkillMetadata[] | null> {
    const manager = descriptor.role === "manager"
      ? descriptor
      : this.options.getDescriptor(descriptor.managerId);
    const profileId = manager?.role === "manager"
      ? normalizeOptionalAgentId(manager.profileId) ?? manager.agentId
      : normalizeOptionalAgentId(descriptor.profileId);
    if (!profileId) {
      return null;
    }

    const workspace = manager?.role === "manager"
      ? await this.resolveProjectWorkspaceForManager(manager)
      : undefined;
    return this.options.skillMetadataService.getProfileSkillMetadataForWorkspace(
      profileId,
      workspace?.effectiveForgeDirRealpath,
    );
  }
}

function formatRuntimeErrorForCapacityClassification(error: RuntimeErrorEvent): string {
  const detailParts = [
    readStringDetail(error.details, "errorName"),
    readStringDetail(error.details, "errorCode"),
  ].filter((value): value is string => Boolean(value));
  return detailParts.length > 0 ? `${error.message} ${detailParts.join(" ")}` : error.message;
}
