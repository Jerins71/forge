import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLiveCompactionRuntimeSettingsProvider,
} from "../compaction-runtime-settings-provider.js";
import type { CompactionSettingsService } from "../compaction-settings-service.js";
import {
  getProfileMergeAuditLogPath,
  getSessionMemoryPath,
} from "../data-paths.js";
import {
  MemoryCoordinator,
  type MemoryCoordinatorOptions,
} from "../memory-coordinator.js";
import type {
  AgentDescriptor,
  ManagerProfile,
  SwarmConfig,
} from "../types.js";

const NOW = "2026-07-13T21:00:00.000Z";
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MemoryCoordinator", () => {
  it("keeps mutable Builder validation ahead of session-memory merge", async () => {
    const harness = await createHarness();
    const manager = makeManager("session", "profile");
    harness.descriptors.set(manager.agentId, manager);
    harness.options.sessions.requireBuilderSession = vi.fn(() => manager);
    harness.options.sessions.assertMutable = vi.fn();

    await expect(harness.coordinator.mergeSessionMemory("session")).resolves.toEqual({
      agentId: "session",
      status: "merged",
      strategy: "llm",
      mergedAt: NOW,
      auditPath: "/audit",
    });
    expect(harness.options.sessions.requireBuilderSession).toHaveBeenCalledWith(
      "session",
      "merge Builder session memory",
    );
    expect(harness.options.sessions.assertMutable).toHaveBeenCalledWith(manager);
    expect(harness.services.memory.mergeSessionMemory).toHaveBeenCalledWith("session");

    harness.options.sessions.assertMutable = vi.fn(() => {
      throw new Error("archived");
    });
    await expect(harness.coordinator.mergeSessionMemory("session")).rejects.toThrow("archived");
    expect(harness.services.memory.mergeSessionMemory).toHaveBeenCalledTimes(1);
  });

  it("owns memory-path policy and fork-header persistence for managers and workers", async () => {
    const harness = await createHarness();
    const source = makeManager("source", "profile");
    source.sessionLabel = "Source session";
    const fork = makeManager("fork", "profile");
    const worker = makeWorker("worker", source);
    harness.descriptors.set(source.agentId, source);
    harness.descriptors.set(fork.agentId, fork);
    harness.descriptors.set(worker.agentId, worker);
    harness.options.resolvePromptWithFallback = vi.fn(async () => [
      "# Fork",
      "$" + "{SOURCE_LABEL}",
      "$" + "{FORK_TIMESTAMP}",
    ].join("\n"));

    expect(harness.coordinator.getAgentMemoryPath(source.agentId)).toBe(
      getSessionMemoryPath(harness.dataDir, "profile", "source"),
    );
    expect(harness.coordinator.getAgentMemoryPath(worker.agentId)).toBe(
      getSessionMemoryPath(harness.dataDir, "profile", "source"),
    );
    expect(harness.coordinator.resolveMemoryOwnerAgentId(worker)).toBe("source");
    expect(harness.coordinator.resolveSessionProfileId(source.agentId)).toBe("profile");

    await harness.coordinator.writeForkedSessionMemoryHeader(source, fork.agentId, "message-7");
    const forkedMemory = await readFile(
      getSessionMemoryPath(harness.dataDir, "profile", "fork"),
      "utf8",
    );
    expect(forkedMemory).toContain("Source session");
    expect(forkedMemory).toContain(NOW);
    expect(forkedMemory).toContain("message-7");
    expect(harness.services.sessionMeta.refreshSessionMetaStatsBySessionId)
      .toHaveBeenCalledWith("fork");

    await harness.coordinator.appendSessionMemoryMergeAuditEntry({
      attemptId: "attempt-1",
      timestamp: NOW,
      sessionAgentId: "source",
      profileId: "profile",
      status: "merged",
      strategy: "llm",
      llmMergeSucceeded: true,
      usedFallbackAppend: false,
      appliedChange: true,
      model: "openai/gpt-5",
      sessionContentHash: "session-hash",
      profileContentHashBefore: "before",
      profileContentHashAfter: "after",
    });
    expect(await readFile(getProfileMergeAuditLogPath(harness.dataDir, "profile"), "utf8"))
      .toContain('"attemptId":"attempt-1"');
  });

  it("loads Builder compaction settings once and attaches only the selected live provider", async () => {
    const harness = await createHarness();
    const load = vi.fn(async () => undefined);
    const service = {
      load,
      getSettings: () => ({
        model: { provider: "openai-codex", modelId: "gpt-5.5" },
        reasoningLevel: "low" as const,
        timeoutMs: 123_000,
        updatedAt: null,
      }),
    } as unknown as CompactionSettingsService;
    harness.options.compactionSettings.createService = vi.fn(() => service);

    await harness.coordinator.loadCompactionSettingsForRuntime();
    await harness.coordinator.loadCompactionSettingsForRuntime();

    expect(load).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.getCompactionSettingsService()).toBe(service);
    expect(harness.coordinator.getCompactionRuntimeSettingsProvider().getCompactionRuntimeSettings())
      .toEqual({
        model: { provider: "openai-codex", modelId: "gpt-5.5" },
        reasoningLevel: "low",
        timeoutMs: 123_000,
      });
  });
});

interface Harness {
  coordinator: MemoryCoordinator;
  options: MemoryCoordinatorOptions;
  services: MemoryCoordinatorOptions["services"] & {
    memory: { mergeSessionMemory: ReturnType<typeof vi.fn> };
    sessionMeta: { refreshSessionMetaStatsBySessionId: ReturnType<typeof vi.fn> };
  };
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  dataDir: string;
}

async function createHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), "memory-coordinator-"));
  tempDirs.push(dataDir);
  const descriptors = new Map<string, AgentDescriptor>();
  const profiles = new Map<string, ManagerProfile>();
  const liveProvider = createLiveCompactionRuntimeSettingsProvider();
  const services = {
    compaction: {
      compact: vi.fn(async () => ({ compacted: true })),
      smartCompact: vi.fn(async () => ({ compacted: true } as const)),
    },
    memory: {
      ensureAgentMemoryFile: vi.fn(async () => undefined),
      ensureMemoryFilesForBoot: vi.fn(async () => undefined),
      mergeSessionMemory: vi.fn(async () => ({
        agentId: "session",
        status: "merged" as const,
        strategy: "llm" as const,
        mergedAt: NOW,
        auditPath: "/audit",
      })),
      refreshDefaultMemoryTemplateNormalizedLines: vi.fn(async () => undefined),
    },
    sessionMeta: {
      captureSessionRuntimePromptMeta: vi.fn(async () => undefined),
      hydrateCompactionCountsForBoot: vi.fn(async () => undefined),
      incrementSessionCompactionCount: vi.fn(async () => 2),
      readSessionMetaForDescriptor: vi.fn(async () => undefined),
      rebuildSessionManifestForBoot: vi.fn(async () => undefined),
      refreshSessionMetaStats: vi.fn(async () => undefined),
      refreshSessionMetaStatsBySessionId: vi.fn(async () => undefined),
      startCompactionCountBackfill: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(async () => undefined),
      writeInitialSessionMeta: vi.fn(async () => undefined),
      writeSessionMemoryMergeAttemptMeta: vi.fn(async () => undefined),
    },
  } satisfies MemoryCoordinatorOptions["services"];
  const options: MemoryCoordinatorOptions = {
    config: {
      paths: { dataDir } as SwarmConfig["paths"],
    },
    descriptors,
    services,
    compactionSettings: {
      runtimeProvider: liveProvider,
      liveProvider,
      getProviderAvailability: vi.fn(async () => new Map()),
    },
    sessions: {
      requireBuilderSession: vi.fn((agentId) => {
        const descriptor = descriptors.get(agentId);
        if (!descriptor || descriptor.role !== "manager" || !descriptor.profileId) {
          throw new Error("missing");
        }
        return descriptor as AgentDescriptor & { role: "manager"; profileId: string };
      }),
      assertMutable: vi.fn(),
      resolvePreferredManagerId: vi.fn(() => undefined),
    },
    sortedProfiles: () => Array.from(profiles.values()),
    resolvePromptWithFallback: vi.fn(async (_category, _promptId, _profileId, fallback) => fallback),
    now: () => NOW,
  };
  return {
    coordinator: new MemoryCoordinator(options),
    options,
    services,
    descriptors,
    profiles,
    dataDir,
  };
}

function makeManager(agentId: string, profileId: string): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: agentId,
    profileId,
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd: "/workspace",
    model: { provider: "openai", modelId: "gpt-5", thinkingLevel: "high" },
    sessionFile: `/sessions/${agentId}.jsonl`,
  };
}

function makeWorker(agentId: string, manager: AgentDescriptor): AgentDescriptor {
  return {
    ...makeManager(agentId, manager.profileId ?? manager.agentId),
    role: "worker",
    managerId: manager.agentId,
  };
}
