import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { AgentDescriptor } from "@forge/protocol";
import type {
  SecureExecutionBackend,
  SecureExecutionRequest,
  SecureExecutionTask,
} from "../secure-sessions/execution/secure-execution-backend.js";
import { SecureSessionsService } from "../secure-sessions/secure-sessions-service.js";
import type { SecureVaultCipher } from "../secure-sessions/sources/electron-safe-storage-client.js";
import type { BitwardenPasswordManagerSource } from "../secure-sessions/sources/bitwarden-password-manager-source.js";
import {
  HostOnlySecret,
  type SecureSecretSource,
} from "../secure-sessions/sources/host-only-secret.js";

import { runSecureSessionMigrations } from "../secure-sessions/storage/secure-session-migrations.js";
import { SecureSessionStore } from "../secure-sessions/storage/secure-session-store.js";

const NOW = "2026-07-24T12:00:00.000Z";
const MANAGER_A = "manager-a";
const WORKER_A1 = "worker-a1";
const WORKER_A2 = "worker-a2";
const UNSUPPORTED_WORKER = "worker-unsupported";
const ASSIGNMENT_A1 = "assignment-a1";
const ASSIGNMENT_A2 = "assignment-a2";
const PROFILE_A = "profile-a";

function testPasswordManagerCliSummary() {
  return {
    state: "ready" as const,
    source: "system" as const,
    executablePath: "/usr/local/bin/bw",
    configuredExecutablePath: null,
    version: "2026.8.0",
    managedVersion: "2026.8.0",
    canInstall: true,
  };
}

describe("Secure Sessions shared team sandbox vertical slice", () => {
  it("rejects workers outside the manager workspace and unsupported runtimes", async () => {
    const harness = createHarness();
    harness.descriptors.set(
      "worker-outside",
      workerDescriptor(
        "worker-outside",
        MANAGER_A,
        PROFILE_A,
        "/workspace-other",
        "assignment-outside",
      ),
    );
    await harness.service.startSecureSession(MANAGER_A);

    expect(await harness.service.prepareWorkerForSecureTeam("worker-outside")).toBe(false);
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("worker-outside")!,
    )).toBeUndefined();
    expect(await harness.service.prepareWorkerForSecureTeam(UNSUPPORTED_WORKER)).toBe(false);
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(UNSUPPORTED_WORKER)!,
    )).toBeUndefined();
    expect(harness.execution.activeTasks).toEqual(new Set([MANAGER_A]));

    await harness.close();
  });
});

function createHarness() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runSecureSessionMigrations(database);
  const store = new SecureSessionStore(database, undefined, () => new Date(NOW));
  const descriptors = new Map<string, AgentDescriptor>([
    [MANAGER_A, managerDescriptor(MANAGER_A, PROFILE_A, "/workspace-a")],
    [WORKER_A1, workerDescriptor(
      WORKER_A1,
      MANAGER_A,
      PROFILE_A,
      "/workspace-a",
      ASSIGNMENT_A1,
    )],
    [WORKER_A2, workerDescriptor(
      WORKER_A2,
      MANAGER_A,
      PROFILE_A,
      "/workspace-a",
      ASSIGNMENT_A2,
    )],
    [UNSUPPORTED_WORKER, workerDescriptor(
      UNSUPPORTED_WORKER,
      MANAGER_A,
      PROFILE_A,
      "/workspace-a",
      "assignment-unsupported",
      "cursor-sdk",
    )],
    ["manager-b", managerDescriptor("manager-b", "profile-b", "/workspace-b")],
  ]);
  const execution = new RecordingExecutionBackend();
  const source: SecureSecretSource & {
    testConnection(): Promise<void>;
  } = {
    kind: "local_keychain",
    async testConnection() {},
    async resolve(input) {
      return {
        material: new HostOnlySecret(input.encryptedMaterial!),
        sourceVersion: null,
        resolvedAt: NOW,
      };
    },
  };
  const cipher: SecureVaultCipher & { dispose(): void } = {
    async status() {
      return { available: true };
    },
    async encrypt(bytes) {
      return Buffer.from(bytes);
    },
    async decrypt(bytes) {
      return { material: new HostOnlySecret(bytes) };
    },
    dispose() {},
  };
  const recycles: string[] = [];
  let nextId = 0;
  const bitwardenPasswordManagerSource: BitwardenPasswordManagerSource = {
    kind: "bitwarden_password_manager",
    getCachedMetadata() { return null; },
    async status() {
      return {
        state: "locked",
        accountEmail: null,
        serverUrl: null,
        cli: testPasswordManagerCliSummary(),
      };
    },
    async installCli() {
      return {
        state: "locked",
        accountEmail: null,
        serverUrl: null,
        cli: testPasswordManagerCliSummary(),
      };
    },
    async unlock() {
      return {
        state: "available",
        accountEmail: null,
        serverUrl: null,
        cli: testPasswordManagerCliSummary(),
      };
    },
    async lock() {},
    async sync() {},
    async listCollections() { return []; },
    async listItems() { return []; },
    async resolve() { throw new Error("unused Password Manager source"); },
    dispose() {},
  };
  const service = new SecureSessionsService({
    storeFactory: async () => store,
    cipher,
    localSource: source,
    bitwardenSource: source,
    bitwardenPasswordManagerSource,
    probeBitwarden: async () => true,
    execution,
    getDescriptor: (agentId) => descriptors.get(agentId),
    listDescriptors: () => [...descriptors.values()],
    listProfiles: () => [...new Set(
      [...descriptors.values()].flatMap((descriptor) =>
        descriptor.profileId ? [descriptor.profileId] : []
      ),
    )].map((profileId) => ({ profileId })),
    hasProfile: (profileId) => [...descriptors.values()]
      .some((descriptor) => descriptor.profileId === profileId),
    isProfileArchived: () => false,
    isSessionArchived: () => false,
    requireBuilderSession: (agentId) => {
      const descriptor = descriptors.get(agentId);
      if (!descriptor) throw new Error("missing descriptor");
      return descriptor;
    },
    emitSnapshot: () => undefined,
    emitCatalogChanged: () => undefined,
    applyModeRuntimeRecycle: async (agentId) => {
      recycles.push(agentId);
      return "recycled";
    },
    hasUsableSecureRuntime: () => false,
    sendAccessResultSteer: async () => undefined,
    logDebug: () => undefined,
    now: () => NOW,
    createId: () => `worker-vertical-${++nextId}`,
  });
  return {
    service,
    store,
    descriptors,
    execution,
    recycles,
    async close() {
      await service.closeSecureSessions();
    },
  };
}

interface ExecutionRecord {
  taskId: string;
  environmentNames: string[];
}

class RecordingExecutionBackend implements SecureExecutionBackend {
  readonly kind = "recording";
  readonly activeTasks = new Set<string>();
  readonly destroyed: string[] = [];
  readonly ensured: string[] = [];
  readonly records: ExecutionRecord[] = [];
  readonly blockCommands = new Set<string>();
  maxConcurrentExecutions = 0;
  private concurrentExecutions = 0;
  private blockedExecutionCount = 0;
  private readonly blockedWaiters = new Set<() => void>();
  private readonly blockedReleases = new Set<() => void>();

  async probe() {
    return { available: true, code: "available" as const };
  }

  async ensureTask(task: SecureExecutionTask) {
    this.ensured.push(task.taskId);
    this.activeTasks.add(task.taskId);
    return {
      backend: this.kind,
      sandboxId: `sandbox-${task.taskId}`,
    };
  }

  async execute(request: SecureExecutionRequest) {
    if (!this.activeTasks.has(request.task.taskId)) {
      throw new Error("attempted execution without an active team sandbox");
    }
    this.concurrentExecutions += 1;
    this.maxConcurrentExecutions = Math.max(
      this.maxConcurrentExecutions,
      this.concurrentExecutions,
    );
    const command = request.command.args[1] ?? "";
    this.records.push({
      taskId: request.task.taskId,
      environmentNames:
        request.delivery?.environment?.map(({ name }) => name) ?? [],
    });
    try {
      if (this.blockCommands.has(command)) {
        this.blockedExecutionCount += 1;
        const waiters = [...this.blockedWaiters];
        this.blockedWaiters.clear();
        for (const waiter of waiters) waiter();
        await new Promise<void>((resolve) => this.blockedReleases.add(resolve));
      }
      const rawStdout = command === "emit-first-environment-secret"
        ? Buffer.from(request.delivery?.environment?.[0]?.value ?? [])
        : Buffer.from("safe-worker-output");
      const stdout = await request.guardOutput({
        stream: "stdout",
        bytes: rawStdout,
        final: false,
      });
      await request.onOutput?.({ stream: "stdout", bytes: stdout });
      const tail = await request.guardOutput({
        stream: "stdout",
        bytes: Buffer.alloc(0),
        final: true,
      });
      await request.onOutput?.({ stream: "stdout", bytes: tail });
      return {
        exitCode: 0,
        signal: null,
        stdout: Buffer.concat([Buffer.from(stdout), Buffer.from(tail)]),
        stderr: Buffer.alloc(0),
      };
    } finally {
      this.concurrentExecutions -= 1;
    }
  }

  async waitForBlockedExecutions(count: number): Promise<void> {
    if (this.blockedExecutionCount >= count) return;
    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.blockedExecutionCount >= count) resolve();
        else this.blockedWaiters.add(check);
      };
      this.blockedWaiters.add(check);
    });
  }

  releaseBlockedExecutions(): void {
    for (const release of this.blockedReleases) release();
    this.blockedReleases.clear();
  }

  async destroyTask(task: SecureExecutionTask) {
    this.destroyed.push(task.taskId);
    this.activeTasks.delete(task.taskId);
    return true;
  }

  async recoverOrphans() {
    return { destroyedSandboxIds: [] };
  }
}

function managerDescriptor(
  agentId: string,
  profileId: string,
  cwd: string,
): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: "manager",
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd,
    model: { provider: "openai", modelId: "test" },
    sessionFile: `/tmp/${agentId}.jsonl`,
    profileId,
  } as AgentDescriptor;
}

function workerDescriptor(
  agentId: string,
  managerId: string,
  profileId: string,
  cwd: string,
  assignmentId: string,
  provider = "openai",
): AgentDescriptor {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: "worker",
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd,
    model: { provider, modelId: "test" },
    sessionFile: `/tmp/${agentId}.jsonl`,
    profileId,
    workerParentContext: {
      schemaVersion: 1,
      assignmentId,
      managerId,
      assignedAt: NOW,
      outputTarget: { kind: "manager" },
    },
  } as AgentDescriptor;
}
