import Database from "better-sqlite3";

import { describe, expect, it, vi } from "vitest";
import { SECURE_SECRET_MAX_PROJECT_DEFAULTS, type AgentDescriptor, type SecureSessionSnapshotEvent } from "@forge/protocol";
import type {
  SecureExecutionBackend,
  SecureExecutionRequest,
  SecureExecutionTask,
} from "../secure-sessions/execution/secure-execution-backend.js";
import { SecureExecutionError } from "../secure-sessions/execution/secure-execution-error.js";
import { normalizeSshAgentKeyMaterial } from "../secure-sessions/execution/ssh-agent-key-material.js";
import {
  SECURE_OUTPUT_QUARANTINE,
  SecureValueGuard,
} from "../secure-sessions/redaction/secure-value-guard.js";
import { SecureSessionsService } from "../secure-sessions/secure-sessions-service.js";
import type { SecureVaultCipher } from "../secure-sessions/sources/electron-safe-storage-client.js";
import type {
  BitwardenPasswordManagerCollection,
  BitwardenPasswordManagerItemMetadata,
  BitwardenPasswordManagerSource,
  BitwardenPasswordManagerStatus,
} from "../secure-sessions/sources/bitwarden-password-manager-source.js";
import {
  HostOnlySecret,
  SecureSourceError,
  type SecureSecretSource,
} from "../secure-sessions/sources/host-only-secret.js";
import { runSecureSessionMigrations } from "../secure-sessions/storage/secure-session-migrations.js";
import { SecureSessionStore } from "../secure-sessions/storage/secure-session-store.js";

const NOW = "2026-07-23T12:00:00.000Z";
const ALPHA = "alpha-secret-3f4d2c";

function testBitwardenCliSummary() {
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

function createHarness(options: {
  projectSettings?: Record<string, boolean>;
  failProjectSettingsSave?: boolean;
  maxProjectDefaults?: number | (() => number);
  blockProviderStatus?: boolean;
  blockSourceResolution?: boolean;
  blockEnsures?: readonly string[];
  destroyFailures?: readonly string[];
  failSourceResolutionAfter?: number;
  failSourceMaterials?: readonly string[];
  rejectedBitwardenCredentials?: readonly string[];
  probeAvailability?: {
    available: boolean;
    code: "available" | "backend_unavailable" | "image_unavailable" | "unsupported_platform";
  };
  probeThrows?: boolean;
  installAvailability?: {
    available: boolean;
    code: "available" | "backend_unavailable" | "image_unavailable" | "unsupported_platform";
  };
  installThrows?: boolean;
  guardFailures?: number;
  archivedProfiles?: readonly string[];
  systemProfiles?: readonly string[];
  archivedSessions?: readonly string[];
  now?: () => string;
  recoveredSandboxIds?: readonly string[];
  recoveryFailures?: number;
  recycleThrows?: boolean;
  recycleDisposition?: "recycled" | "deferred" | "none";
  recycleDispositionForAgent?: (
    agentId: string,
  ) => "recycled" | "deferred" | "none";
  secureRuntimeReady?: boolean;
  rotatedLocalCiphertext?: string;
  passwordManagerStatus?: BitwardenPasswordManagerStatus;
  passwordManagerCollections?: readonly BitwardenPasswordManagerCollection[];
  passwordManagerItems?: readonly BitwardenPasswordManagerItemMetadata[];
} = {}) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runSecureSessionMigrations(database);
  const now = options.now ?? (() => NOW);
  const store = new SecureSessionStore(database, undefined, () => new Date(now()));
  const descriptors = new Map<string, AgentDescriptor>([
    ["manager-a", descriptor("manager-a", "profile-a", "/workspace-a")],
    ["manager-b", descriptor("manager-b", "profile-b", "/workspace-b")],
  ]);
  const projectSettings = new Map(Object.entries(options.projectSettings ?? {}));
  const archivedProfiles = new Set(options.archivedProfiles ?? []);
  const systemProfiles = new Set(options.systemProfiles ?? []);
  const archivedSessions = new Set(options.archivedSessions ?? []);
  const execution = new FakeExecutionBackend(options);
  const sourceResolutions = new Map<string, number>();
  const resolvedMaterials: HostOnlySecret[] = [];
  const bitwardenTests: Array<{ credential: string; endpointOrigin: string | null }> = [];
  const passwordManagerUnlocks: string[] = [];
  const passwordManagerSyncs: string[] = [];
  const passwordManagerCliInstalls: string[] = [];
  const passwordManagerStatusPaths: Array<string | null> = [];
  const passwordManagerCreates: Array<{
    name: string;
    username: string | null;
    collectionId: string;
    organizationId: string;
    material: string;
  }> = [];
  let sourceResolutionStarted!: () => void;
  let sourceResolutionRelease!: () => void;
  const sourceResolutionStartedPromise = new Promise<void>((resolve) => {
    sourceResolutionStarted = resolve;
  });
  const sourceResolutionReleasePromise = new Promise<void>((resolve) => {
    sourceResolutionRelease = resolve;
  });
  const localSource: SecureSecretSource & {
    testConnection(): Promise<void>;
  } = {
    kind: "local_keychain",
    async testConnection() {},
    async resolve(input) {
      if (options.blockSourceResolution) {
        sourceResolutionStarted();
        await sourceResolutionReleasePromise;
      }
      const bytes = Buffer.from(input.encryptedMaterial ?? []);
      const key = bytes.toString("utf8");
      const resolutionCount = [...sourceResolutions.values()]
        .reduce((total, value) => total + value, 0);
      if (
        options.failSourceResolutionAfter !== undefined
        && resolutionCount >= options.failSourceResolutionAfter
      ) {
        bytes.fill(0);
        throw new SecureSourceError("SECURE_SOURCE_UNAVAILABLE");
      }
      if (options.failSourceMaterials?.includes(key)) {
        bytes.fill(0);
        throw new SecureSourceError("SECURE_SOURCE_UNAVAILABLE");
      }
      sourceResolutions.set(key, (sourceResolutions.get(key) ?? 0) + 1);
      const material = new HostOnlySecret(bytes);
      resolvedMaterials.push(material);
      return {
        material,
        sourceVersion: null,
        resolvedAt: NOW,
        ...(options.rotatedLocalCiphertext
          ? {
              refreshedEncryptedMaterial: Buffer.from(
                options.rotatedLocalCiphertext,
              ),
            }
          : {}),
      };
    },
  };
  const bitwardenSource: SecureSecretSource & {
    testConnection(input: {
      encryptedCredential?: Uint8Array;
      endpointOrigin?: string | null;
    }): Promise<void>;
  } = {
    kind: "bitwarden_secrets_manager",
    async testConnection(input) {
      const credential = Buffer.from(input.encryptedCredential ?? []).toString("utf8");
      bitwardenTests.push({
        credential,
        endpointOrigin: input.endpointOrigin ?? null,
      });
      if (options.rejectedBitwardenCredentials?.includes(credential)) {
        throw new SecureSourceError("SECURE_SOURCE_AUTH_REQUIRED");
      }
    },
    async resolve() {
      const material = new HostOnlySecret(Buffer.from("bitwarden-resolved"));
      resolvedMaterials.push(material);
      return {
        material,
        sourceVersion: null,
        resolvedAt: NOW,
      };
    },
  };
  const bitwardenPasswordManagerSource: BitwardenPasswordManagerSource = {
    kind: "bitwarden_password_manager",
    getCachedMetadata() { return null; },
    async status(configuredExecutablePath) {
      passwordManagerStatusPaths.push(configuredExecutablePath);
      if (options.passwordManagerStatus) return options.passwordManagerStatus;
      return {
          state: "locked",
          accountEmail: null,
          serverUrl: null,
          cli: configuredExecutablePath
            ? {
                ...testBitwardenCliSummary(),
                source: "configured",
                executablePath: configuredExecutablePath,
                configuredExecutablePath,
              }
            : testBitwardenCliSummary(),
        };
    },
    async installCli() {
      passwordManagerCliInstalls.push(now());
      return {
        state: "locked",
        accountEmail: null,
        serverUrl: null,
        cli: {
          ...testBitwardenCliSummary(),
          source: "managed",
          executablePath: "/forge/managed/bw",
        },
      };
    },
    async unlock(encryptedMasterPassword) {
      passwordManagerUnlocks.push(Buffer.from(encryptedMasterPassword).toString("utf8"));
      return {
        state: "available",
        accountEmail: options.passwordManagerStatus?.accountEmail ?? null,
        serverUrl: options.passwordManagerStatus?.serverUrl ?? null,
        cli: options.passwordManagerStatus?.cli ?? testBitwardenCliSummary(),
      };
    },
    async lock() {},
    async sync() { passwordManagerSyncs.push(now()); },
    async listCollections() { return [...(options.passwordManagerCollections ?? [])]; },
    async listItems(collectionIds) {
      return (options.passwordManagerItems ?? []).filter((item) =>
        item.collectionIds.some((collectionId) => collectionIds.includes(collectionId))
      );
    },
    async createItem(input) {
      const material = await input.material.withBytes((bytes) => bytes.toString("utf8"));
      passwordManagerCreates.push({
        name: input.name,
        username: input.username ?? null,
        collectionId: input.collectionId,
        organizationId: input.organizationId,
        material,
      });
      return {
        id: `55555555-5555-4555-8555-${String(passwordManagerCreates.length).padStart(12, "0")}`,
        name: input.name,
        username: input.username ?? null,
        collectionIds: [input.collectionId],
        revisionDate: now(),
      };
    },
    async resolve() {
      const material = new HostOnlySecret(Buffer.from("bitwarden-password-manager-resolved"));
      resolvedMaterials.push(material);
      return { material, sourceVersion: null, resolvedAt: NOW };
    },
    dispose() {},
  };
  const snapshots: SecureSessionSnapshotEvent[] = [];
  const catalogEvents: Array<{ type: string; revision: number }> = [];
  const recycles: string[] = [];
  const accessResultSteers: Array<{
    fromAgentId: string;
    targetAgentId: string;
    message: string;
  }> = [];
  let recycleDisposition = options.recycleDisposition;
  let secureRuntimeReady = options.secureRuntimeReady ?? false;
  let nextId = 0;
  let guardFailures = options.guardFailures ?? 0;
  let providerStatusStarted!: () => void;
  let providerStatusRelease!: () => void;
  const providerStatusStartedPromise = new Promise<void>((resolve) => {
    providerStatusStarted = resolve;
  });
  const providerStatusReleasePromise = new Promise<void>((resolve) => {
    providerStatusRelease = resolve;
  });
  const cipher: SecureVaultCipher & { dispose(): void } = {
    async status() {
      if (options.blockProviderStatus) {
        providerStatusStarted();
        await providerStatusReleasePromise;
      }
      return { available: true };
    },
    async encrypt(bytes) { return Buffer.from(bytes); },
    async decrypt(bytes) {
      return { material: new HostOnlySecret(bytes) };
    },
    dispose() {},
  };
  const service = new SecureSessionsService({
    storeFactory: async () => store,
    cipher,
    localSource,
    bitwardenSource,
    bitwardenPasswordManagerSource,
    probeBitwarden: async () => true,
    execution,
    getDescriptor: (agentId) => descriptors.get(agentId),
    listDescriptors: () => [...descriptors.values()],
    listProfiles: () => [...new Set(
      [...descriptors.values()].flatMap((descriptor) =>
        descriptor.profileId ? [descriptor.profileId] : []
      ),
    )].map((profileId) => ({
      profileId,
      secureSessionsEnabled: projectSettings.get(profileId),
      ...(archivedProfiles.has(profileId) ? { archivedAt: NOW } : {}),
      ...(systemProfiles.has(profileId) ? { profileType: "system" as const } : {}),
    })),
    updateProjectEnabled: async (profileId, enabled) => {
      if (options.failProjectSettingsSave) throw new Error("save failed");
      projectSettings.set(profileId, enabled);
    },
    hasProfile: (profileId) => [...descriptors.values()].some(
      (descriptor) => descriptor.profileId === profileId,
    ),
    isProfileArchived: (profileId) => archivedProfiles.has(profileId),
    isSessionArchived: (agentId) => archivedSessions.has(agentId),
    requireBuilderSession: (agentId) => {
      const value = descriptors.get(agentId);
      if (!value) throw new Error("missing");
      return value;
    },
    emitSnapshot: (event) => snapshots.push(event),
    emitCatalogChanged: (event) => catalogEvents.push(event),
    applyModeRuntimeRecycle: async (agentId) => {
      recycles.push(agentId);
      if (options.recycleThrows) throw new Error("recycle failed");
      return options.recycleDispositionForAgent?.(agentId)
        ?? recycleDisposition
        ?? "recycled";
    },
    hasUsableSecureRuntime: () => secureRuntimeReady,
    sendAccessResultSteer: async (fromAgentId, targetAgentId, message) => {
      accessResultSteers.push({ fromAgentId, targetAgentId, message });
    },
    logDebug: () => undefined,
    createValueGuard: (values) => {
      if (guardFailures > 0) {
        guardFailures -= 1;
        throw new Error("guard preflight failed");
      }
      return new SecureValueGuard(values);
    },
    now,
    createId: () => `id-${++nextId}`,
    getMaxProjectDefaults: () => {
      const configured = typeof options.maxProjectDefaults === "function"
        ? options.maxProjectDefaults()
        : options.maxProjectDefaults;
      return configured ?? SECURE_SECRET_MAX_PROJECT_DEFAULTS;
    },
  });
  return {
    service,
    bitwardenPasswordManagerSource,
    store,
    descriptors,
    archivedProfiles,
    archivedSessions,
    execution,
    sourceResolutions,
    resolvedMaterials,
    bitwardenTests,
    passwordManagerUnlocks,
    passwordManagerSyncs,
    passwordManagerCliInstalls,
    passwordManagerStatusPaths,
    passwordManagerCreates,
    snapshots,
    catalogEvents,
    recycles,
    accessResultSteers,
    setSecureRuntimeReady(value: boolean) {
      secureRuntimeReady = value;
    },
    setRecycleDisposition(value: "recycled" | "deferred" | "none") {
      recycleDisposition = value;
    },
    async waitForBlockedProviderStatus() {
      await providerStatusStartedPromise;
    },
    releaseBlockedProviderStatus() {
      providerStatusRelease();
    },
    async waitForBlockedSourceResolution() {
      await sourceResolutionStartedPromise;
    },
    releaseBlockedSourceResolution() {
      sourceResolutionRelease();
    },
    async close() {
      await service.closeSecureSessions();
    },
  };
}

class FakeExecutionBackend implements SecureExecutionBackend {
  readonly kind = "fake";
  readonly destroyed: string[] = [];
  readonly ensured: string[] = [];
  readonly executed: string[] = [];
  readonly recoveryCalls: SecureExecutionTask[][] = [];
  readonly sshTrustDeliveries: Array<{
    config: string;
    knownHosts: string;
  }> = [];
  readonly sshAgentDeliveryValues: string[][] = [];
  readonly environmentDeliveryNames: string[][] = [];
  readonly destroyUnconfirmed = new Set<string>();
  private readonly blockedExecutions = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private readonly blockedExecutionWaiters = new Map<
    string,
    Set<() => void>
  >();
  private readonly blockedEnsures = new Map<string, () => void>();
  private readonly blockedEnsureWaiters = new Map<string, Set<() => void>>();
  private recoveryFailures: number;
  lastDeliveryValue: Uint8Array | undefined;

  constructor(private readonly options: {
    destroyFailures?: readonly string[];
    recoveredSandboxIds?: readonly string[];
    recoveryFailures?: number;
    blockEnsures?: readonly string[];
    probeAvailability?: {
      available: boolean;
      code: "available" | "backend_unavailable" | "image_unavailable" | "unsupported_platform";
    };
    probeThrows?: boolean;
    installAvailability?: {
      available: boolean;
      code: "available" | "backend_unavailable" | "image_unavailable" | "unsupported_platform";
    };
    installThrows?: boolean;
  } = {}) {
    this.recoveryFailures = options.recoveryFailures ?? 0;
  }

  async probe() {
    if (this.options.probeThrows) throw new Error("RAW-PROBE-FAILURE");
    return this.options.probeAvailability
      ?? { available: true, code: "available" as const };
  }

  async installRunner() {
    if (this.options.installThrows) throw new Error("RAW-INSTALL-FAILURE");
    return this.options.installAvailability
      ?? { available: true, code: "available" as const };
  }

  async ensureTask(task: SecureExecutionTask) {
    this.ensured.push(task.taskId);
    if (this.options.blockEnsures?.includes(task.taskId)) {
      await new Promise<void>((resolve) => {
        this.blockedEnsures.set(task.taskId, resolve);
        const waiters = this.blockedEnsureWaiters.get(task.taskId);
        this.blockedEnsureWaiters.delete(task.taskId);
        for (const waiter of waiters ?? []) waiter();
      });
    }
    return { backend: this.kind, sandboxId: task.taskId };
  }

  async waitForBlockedEnsure(taskId: string): Promise<void> {
    if (this.blockedEnsures.has(taskId)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.blockedEnsureWaiters.get(taskId) ?? new Set();
      waiters.add(resolve);
      this.blockedEnsureWaiters.set(taskId, waiters);
    });
  }

  releaseBlockedEnsure(taskId: string): void {
    const release = this.blockedEnsures.get(taskId);
    this.blockedEnsures.delete(taskId);
    release?.();
  }

  async execute(request: SecureExecutionRequest) {
    this.executed.push(request.task.taskId);
    this.lastDeliveryValue = request.delivery?.environment?.[0]?.value;
    this.environmentDeliveryNames.push(
      (request.delivery?.environment ?? []).map(({ name }) => name),
    );
    this.sshAgentDeliveryValues.push(
      (request.delivery?.sshAgent ?? []).map(({ value }) =>
        Buffer.from(value).toString("utf8")
      ),
    );
    if (request.delivery?.sshTrust) {
      this.sshTrustDeliveries.push({
        config: Buffer.from(request.delivery.sshTrust.config).toString("utf8"),
        knownHosts: Buffer.from(
          request.delivery.sshTrust.knownHosts,
        ).toString("utf8"),
      });
    }
    const command = request.command.args.at(-1);
    if (command === "throw-execution-timeout") {
      throw new SecureExecutionError("EXECUTION_TIMEOUT");
    }
    if (command === "throw-unsafe-backend-error") {
      throw new Error(`unsafe-backend-detail:${ALPHA}`);
    }
    if (command === "wait-for-destroy" || command === "wait-for-release") {
      await new Promise<void>((resolve, reject) => {
        this.blockedExecutions.set(request.task.taskId, { resolve, reject });
        const waiters = this.blockedExecutionWaiters.get(request.task.taskId);
        this.blockedExecutionWaiters.delete(request.task.taskId);
        for (const resolve of waiters ?? []) resolve();
      });
    }
    const raw = command === "emit-normalized-ssh-agent-canary"
      ? normalizeSshAgentKeyMaterial(
        request.delivery?.sshAgent?.[0]?.value ?? Buffer.alloc(0),
      )
      : Buffer.from(
        command === "emit-alpha-canary" || command === "emit-own-canary"
          ? ALPHA
          : command === "emit-public-marker"
            ? SECURE_OUTPUT_QUARANTINE
          : "safe",
      );
    const stdout = await request.guardOutput({
      stream: "stdout",
      bytes: raw,
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
      stdout,
      stderr: Buffer.alloc(0),
    };
  }

  hasBlockedExecution(taskId: string): boolean {
    return this.blockedExecutions.has(taskId);
  }

  async waitForBlockedExecution(taskId: string): Promise<void> {
    if (this.hasBlockedExecution(taskId)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.blockedExecutionWaiters.get(taskId) ?? new Set();
      waiters.add(resolve);
      this.blockedExecutionWaiters.set(taskId, waiters);
    });
  }

  rejectBlockedExecution(taskId: string): void {
    const blocked = this.blockedExecutions.get(taskId);
    this.blockedExecutions.delete(taskId);
    blocked?.reject(new Error("destroyed"));
  }

  releaseBlockedExecution(taskId: string): void {
    const blocked = this.blockedExecutions.get(taskId);
    this.blockedExecutions.delete(taskId);
    blocked?.resolve();
  }

  async destroyTask(task: SecureExecutionTask) {
    this.destroyed.push(task.taskId);
    if (this.options.destroyFailures?.includes(task.taskId)) {
      throw new Error("destroy failed");
    }
    if (this.destroyUnconfirmed.has(task.taskId)) {
      return false;
    }
    return true;
  }

  async recoverOrphans(liveTasks: readonly SecureExecutionTask[]) {
    this.recoveryCalls.push([...liveTasks]);
    if (this.recoveryFailures > 0) {
      this.recoveryFailures -= 1;
      throw new Error("recovery failed");
    }
    return { destroyedSandboxIds: [...(this.options.recoveredSandboxIds ?? [])] };
  }
}

function descriptor(agentId: string, profileId: string, cwd: string): AgentDescriptor {
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

describe("project Secure Sessions policy", () => {
  async function saveDefault(h: ReturnType<typeof createHarness>) {
    const secret = await h.service.createLocalSecureSecret({ displayAlias: "project-policy",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"), scope: { kind: "profile", profileId: "profile-a" },
      bindings: [{ deliveryKind: "environment", targetName: "PROJECT_POLICY_TOKEN" }] });
    await h.service.setSecureSecretProjectDefault(secret.secretId, { profileId: "profile-a", enabled: true });
    return secret;
  }
  const command = (value = "true") => ({ command: value, cwd: "/workspace-a", secretAliases: ["project-policy"], onData: vi.fn() });

  it("preserves legacy behavior and blocks disabled projects before creating bindings, requests or environments", async () => {
    const h = createHarness({ projectSettings: { "profile-a": false } });
    await saveDefault(h);
    expect(h.service.getProjectSecureSessionsSettings("profile-a").enabled).toBe(false);
    expect(h.service.getProjectSecureSessionsSettings("profile-b").enabled).toBe(true);
    expect(await h.service.prepareSecureRuntimeBinding(h.descriptors.get("manager-a")!)).toBeUndefined();
    await expect(h.service.startSecureSession("manager-a")).rejects.toMatchObject({ code: "SECURE_ACCESS_BLOCKED" });
    await expect(h.service.getSecureSessionAgentView("manager-a")).rejects.toMatchObject({ code: "SECURE_ACCESS_BLOCKED" });
    await expect(h.service.requestSecureSshHostTrust("manager-a", "request", {} as never)).rejects.toMatchObject({ code: "SECURE_ACCESS_BLOCKED" });
    expect(h.execution.ensured).toEqual([]);
    await h.close();
  });

  it("revokes a busy project and its old binding, preserves defaults and leaves other projects running", async () => {
    const h = createHarness();
    const destroy = h.execution.destroyTask.bind(h.execution);
    vi.spyOn(h.execution, "destroyTask").mockImplementation(async task => {
      const confirmed = await destroy(task);
      if (confirmed) h.execution.rejectBlockedExecution(task.taskId);
      return confirmed;
    });
    const secret = await saveDefault(h);
    await h.service.startSecureSession("manager-b");
    const binding = (await h.service.prepareSecureRuntimeBinding(h.descriptors.get("manager-a")!))!;
    const executing = binding.executeBash(command("wait-for-destroy")).catch(() => undefined);
    await h.execution.waitForBlockedExecution("manager-a");
    h.setRecycleDisposition("deferred");
    await h.service.updateProjectSecureSessionsSettings("profile-a", false);
    await executing;
    expect(h.execution.destroyed).toContain("manager-a");
    expect(h.execution.destroyed).not.toContain("manager-b");
    await expect(async () => binding.executeBash(command())).rejects.toThrow();
    expect(await h.service.prepareSecureRuntimeBinding(h.descriptors.get("manager-a")!)).toBeUndefined();
    expect(h.store.getSecret(secret.secretId)).not.toBeNull();
    expect(h.store.listProjectDefaults()).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: "profile-a", secretId: secret.secretId })]));
    h.setRecycleDisposition("recycled");
    await h.service.updateProjectSecureSessionsSettings("profile-a", true);
    const restored = (await h.service.prepareSecureRuntimeBinding(h.descriptors.get("manager-a")!))!;
    await restored.executeBash(command());
    expect(h.recycles).toContain("manager-a");
    await h.close();
  });
});
