import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionMemoryMergeResult, SessionMeta } from "@forge/protocol";
import type {
  CompactionRuntimeSettingsProvider,
  LiveCompactionRuntimeSettingsProvider,
} from "./compaction-runtime-settings-provider.js";
import { CompactionSettingsService } from "./compaction-settings-service.js";
import {
  getProfileMergeAuditLogPath,
  resolveMemoryFilePath,
} from "./data-paths.js";
import { resolvePromptVariables, type PromptCategory } from "./prompts/prompt-registry.js";
import { migrateLegacyProfileKnowledgeToReferenceDoc } from "./reference-docs.js";
import type {
  CompactAgentContextOptions,
  SwarmCompactionCoordinator,
} from "./swarm-compaction-coordinator.js";
import type {
  SessionMemoryMergeAuditEntry,
  SwarmMemoryMergeService,
} from "./swarm-memory-merge-service.js";
import type {
  SessionMemoryMergeAttemptMetaUpdate,
  SwarmSessionMetaService,
} from "./swarm-session-meta-service.js";
import type { SmartCompactResult } from "./runtime-contracts.js";
import { normalizeOptionalAgentId } from "./swarm-manager-utils.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "./types.js";

const FORKED_SESSION_MEMORY_HEADER_TEMPLATE = [
  "# Session Memory",
  '> Forked from session "' + "$" + '{SOURCE_LABEL}" (' + "$" + "{SOURCE_AGENT_ID}) on " + "$" + "{FORK_TIMESTAMP}",
  "> " + "$" + "{FORK_HISTORY_NOTE}",
  "",
].join("\n");

type ManagerDescriptor = AgentDescriptor & { role: "manager"; profileId: string };

type MemoryPort = Pick<
  SwarmMemoryMergeService,
  | "ensureAgentMemoryFile"
  | "ensureMemoryFilesForBoot"
  | "mergeSessionMemory"
  | "refreshDefaultMemoryTemplateNormalizedLines"
>;

type SessionMetaPort = Pick<
  SwarmSessionMetaService,
  | "captureSessionRuntimePromptMeta"
  | "hydrateCompactionCountsForBoot"
  | "incrementSessionCompactionCount"
  | "readSessionMetaForDescriptor"
  | "rebuildSessionManifestForBoot"
  | "refreshSessionMetaStats"
  | "refreshSessionMetaStatsBySessionId"
  | "startCompactionCountBackfill"
  | "updateSessionMetaForWorkerDescriptor"
  | "writeInitialSessionMeta"
  | "writeSessionMemoryMergeAttemptMeta"
>;

type CompactionPort = Pick<SwarmCompactionCoordinator, "compact" | "smartCompact">;

export interface MemoryCoordinatorOptions {
  config: Pick<SwarmConfig, "paths">;
  descriptors: Map<string, AgentDescriptor>;
  services: {
    compaction: CompactionPort;
    memory: MemoryPort;
    sessionMeta: SessionMetaPort;
  };
  compactionSettings: {
    runtimeProvider: CompactionRuntimeSettingsProvider;
    liveProvider: LiveCompactionRuntimeSettingsProvider;
    createService?: () => CompactionSettingsService;
    getProviderAvailability: () => Promise<Map<string, boolean>>;
  };
  sessions: {
    requireBuilderSession: (agentId: string, operation: string) => ManagerDescriptor;
    assertMutable: (descriptor: AgentDescriptor) => void;
    resolvePreferredManagerId: (options?: {
      includeStoppedOnRestart?: boolean;
    }) => string | undefined;
  };
  sortedProfiles: () => ManagerProfile[];
  resolvePromptWithFallback: (
    category: PromptCategory,
    promptId: string,
    profileId: string | undefined,
    fallback: string,
  ) => Promise<string>;
  now: () => string;
}

/**
 * Application owner for the memory surface exposed through SwarmManager.
 *
 * The focused services retain their algorithms and mutable state. This coordinator owns only
 * cross-service policy: caller authorization, boot ordering, compaction-settings attachment,
 * and the compact facade methods used by routes/runtime hosts.
 */
export class MemoryCoordinator {
  private compactionSettingsService: CompactionSettingsService | null = null;

  constructor(private readonly options: MemoryCoordinatorOptions) {}

  getCompactionRuntimeSettingsProvider(): CompactionRuntimeSettingsProvider {
    return this.options.compactionSettings.runtimeProvider;
  }

  getCompactionSettingsService(): CompactionSettingsService | null {
    return this.compactionSettingsService;
  }

  async loadCompactionSettingsForRuntime(): Promise<void> {
    if (this.compactionSettingsService) {
      return;
    }

    const service = this.options.compactionSettings.createService?.() ?? new CompactionSettingsService({
      dataDir: this.options.config.paths.dataDir,
      getProviderAvailability: this.options.compactionSettings.getProviderAvailability,
    });
    await service.load();
    this.compactionSettingsService = service;

    if (this.options.compactionSettings.runtimeProvider === this.options.compactionSettings.liveProvider) {
      this.options.compactionSettings.liveProvider.attachSettingsService(service);
    }
  }

  async compact(agentId: string, options?: CompactAgentContextOptions): Promise<unknown> {
    return this.options.services.compaction.compact(agentId, options);
  }

  async smartCompact(
    agentId: string,
    options?: CompactAgentContextOptions,
  ): Promise<SmartCompactResult> {
    return this.options.services.compaction.smartCompact(agentId, options);
  }

  async mergeSessionMemory(agentId: string): Promise<SessionMemoryMergeResult> {
    const descriptor = this.options.sessions.requireBuilderSession(
      agentId,
      "merge Builder session memory",
    );
    this.options.sessions.assertMutable(descriptor);
    return this.options.services.memory.mergeSessionMemory(agentId);
  }

  getAgentMemoryPath(agentId: string): string {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor) {
      const fallbackAgentId = normalizeOptionalAgentId(agentId) ?? agentId;
      return resolveMemoryFilePath(this.options.config.paths.dataDir, {
        agentId: fallbackAgentId,
        role: "manager",
        profileId: fallbackAgentId,
        managerId: fallbackAgentId,
      });
    }

    const parentDescriptor = descriptor.role === "worker"
      ? this.options.descriptors.get(descriptor.managerId)
      : undefined;
    const parentProfileId = descriptor.role === "worker"
      ? normalizeOptionalAgentId(parentDescriptor?.profileId ?? descriptor.profileId)
      : undefined;
    return resolveMemoryFilePath(
      this.options.config.paths.dataDir,
      {
        agentId: descriptor.agentId,
        role: descriptor.role,
        profileId: descriptor.profileId,
        managerId: descriptor.managerId,
      },
      parentProfileId ? { profileId: parentProfileId } : undefined,
    );
  }

  resolveMemoryOwnerAgentId(descriptor: AgentDescriptor): string {
    if (descriptor.role === "manager") {
      return descriptor.agentId;
    }
    return normalizeOptionalAgentId(descriptor.managerId)
      ?? this.options.sessions.resolvePreferredManagerId({ includeStoppedOnRestart: true })
      ?? descriptor.agentId;
  }

  resolveSessionProfileId(memoryOwnerAgentId: string): string | undefined {
    const descriptor = this.options.descriptors.get(memoryOwnerAgentId);
    if (!descriptor || descriptor.role !== "manager") {
      return undefined;
    }
    return normalizeOptionalAgentId(descriptor.profileId) ?? descriptor.agentId;
  }

  async writeForkedSessionMemoryHeader(
    sourceDescriptor: AgentDescriptor,
    forkedSessionAgentId: string,
    fromMessageId?: string,
  ): Promise<void> {
    const sourceLabel = sourceDescriptor.sessionLabel ?? sourceDescriptor.agentId;
    const profileId = sourceDescriptor.profileId ?? sourceDescriptor.agentId;
    const forkHistoryNote = fromMessageId
      ? `A durable context transfer references parent history through message ${fromMessageId} at fork time.`
      : "A durable context transfer references the parent conversation at its stable fork point.";
    const headerTemplate = await this.options.resolvePromptWithFallback(
      "operational",
      "forked-session-header",
      profileId,
      FORKED_SESSION_MEMORY_HEADER_TEMPLATE,
    );
    let header = resolvePromptVariables(headerTemplate, {
      SOURCE_LABEL: sourceLabel,
      SOURCE_AGENT_ID: sourceDescriptor.agentId,
      FORK_TIMESTAMP: this.options.now(),
      FORK_HISTORY_NOTE: forkHistoryNote,
      FROM_MESSAGE_ID: fromMessageId ?? "",
    });
    if (fromMessageId && !header.includes(fromMessageId)) {
      header = `${header.trimEnd()}\n> ${forkHistoryNote}\n`;
    }

    const forkedMemoryPath = this.getAgentMemoryPath(forkedSessionAgentId);
    await mkdir(dirname(forkedMemoryPath), { recursive: true });
    await writeFile(forkedMemoryPath, header, "utf8");
    await this.options.services.sessionMeta.refreshSessionMetaStatsBySessionId(forkedSessionAgentId);
  }

  async refreshMemoryTemplateForBoot(): Promise<void> {
    await this.options.services.memory.refreshDefaultMemoryTemplateNormalizedLines();
  }

  async ensureMemoryFilesForBoot(): Promise<void> {
    await this.options.services.memory.ensureMemoryFilesForBoot();
  }

  async migrateLegacyProfileKnowledge(profileId: string): Promise<void> {
    await migrateLegacyProfileKnowledgeToReferenceDoc(
      this.options.config.paths.dataDir,
      profileId,
    );
  }

  async migrateLegacyProfileKnowledgeForBoot(): Promise<void> {
    await Promise.all(
      this.options
        .sortedProfiles()
        .map((profile) => this.migrateLegacyProfileKnowledge(profile.profileId)),
    );
  }

  async ensureAgentMemoryFile(memoryFilePath: string, profileId?: string): Promise<void> {
    await this.options.services.memory.ensureAgentMemoryFile(memoryFilePath, profileId);
  }

  async appendSessionMemoryMergeAuditEntry(entry: SessionMemoryMergeAuditEntry): Promise<void> {
    await appendFile(
      getProfileMergeAuditLogPath(this.options.config.paths.dataDir, entry.profileId),
      `${JSON.stringify(entry)}\n`,
      "utf8",
    );
  }

  async rebuildSessionManifestForBoot(): Promise<void> {
    await this.options.services.sessionMeta.rebuildSessionManifestForBoot();
  }

  async hydrateCompactionCountsForBoot(): Promise<void> {
    await this.options.services.sessionMeta.hydrateCompactionCountsForBoot();
  }

  startCompactionCountBackfill(): void {
    this.options.services.sessionMeta.startCompactionCountBackfill();
  }

  async writeInitialSessionMeta(descriptor: AgentDescriptor): Promise<void> {
    await this.options.services.sessionMeta.writeInitialSessionMeta(descriptor);
  }

  async captureSessionRuntimePromptMeta(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null,
  ): Promise<void> {
    await this.options.services.sessionMeta.captureSessionRuntimePromptMeta(
      descriptor,
      resolvedSystemPrompt,
    );
  }

  async updateSessionMetaForWorkerDescriptor(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null,
  ): Promise<void> {
    await this.options.services.sessionMeta.updateSessionMetaForWorkerDescriptor(
      descriptor,
      resolvedSystemPrompt,
    );
  }

  async refreshSessionMetaStats(
    descriptor: AgentDescriptor,
    sessionFileOverride?: string,
  ): Promise<void> {
    await this.options.services.sessionMeta.refreshSessionMetaStats(
      descriptor,
      sessionFileOverride,
    );
  }

  async refreshSessionMetaStatsBySessionId(
    sessionAgentId: string,
    sessionFileOverride?: string,
  ): Promise<void> {
    await this.options.services.sessionMeta.refreshSessionMetaStatsBySessionId(
      sessionAgentId,
      sessionFileOverride,
    );
  }

  async incrementSessionCompactionCount(
    profileId: string,
    sessionId: string,
    failureLogKey: string,
  ): Promise<number | undefined> {
    return this.options.services.sessionMeta.incrementSessionCompactionCount(
      profileId,
      sessionId,
      failureLogKey,
    );
  }

  async readSessionMetaForDescriptor(descriptor: AgentDescriptor): Promise<SessionMeta | undefined> {
    return this.options.services.sessionMeta.readSessionMetaForDescriptor(descriptor);
  }

  async writeSessionMemoryMergeAttemptMeta(
    descriptor: AgentDescriptor,
    attempt: SessionMemoryMergeAttemptMetaUpdate,
  ): Promise<void> {
    await this.options.services.sessionMeta.writeSessionMemoryMergeAttemptMeta(descriptor, attempt);
  }

  async recordSessionMemoryMergeAttempt(
    descriptor: AgentDescriptor,
    attempt: SessionMemoryMergeAttemptMetaUpdate,
  ): Promise<void> {
    await this.options.services.sessionMeta.writeSessionMemoryMergeAttemptMeta(descriptor, attempt);
  }
}
