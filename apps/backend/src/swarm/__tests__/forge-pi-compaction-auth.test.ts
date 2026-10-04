import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { createTempConfig, type TempConfigHandle } from "../../test-support/temp-config.js";
import { makeCompactionGuardDescriptor } from "../../test-support/compaction-guard-harness.js";
import {
  resolveConfiguredForgePiCompactionAuth,
} from "../compaction/forge-pi-compaction-auth.js";
import type { OpenAIAuthBrokerLeaseHandle, OpenAIAuthBrokerRuntimeService } from "../openai-auth/openai-auth-broker-runtime-service.js";

const mocks = vi.hoisted(() => ({
  createPiModelRegistry: vi.fn(),
}));

vi.mock("../catalog/pi-model-registry.js", () => ({
  createPiModelRegistry: mocks.createPiModelRegistry,
}));

const handles: TempConfigHandle[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(handles.splice(0).map((handle) => handle.cleanup()));
});

describe("configured Forge Pi compaction auth", () => {
  it("uses OpenAI broker auth directly for configured OpenAI compaction from an Anthropic runtime", async () => {
    const handle = await makeHandle();
    const descriptor = makeCompactionGuardDescriptor();
    descriptor.model = { provider: "anthropic", modelId: "claude-opus-4-5", thinkingLevel: "medium" };
    const compactionModel = { provider: "openai-codex", id: "gpt-5.5", reasoning: true };
    const registry = {
      find: vi.fn((provider: string, modelId: string) => {
        if (provider === "openai-codex" && modelId === "gpt-5.5") {
          return compactionModel;
        }
        return undefined;
      }),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true as const,
        apiKey: "broker-compaction-key",
        headers: { Authorization: "Bearer broker-compaction-key" },
      })),
    };
    mocks.createPiModelRegistry.mockReturnValue(registry);
    const brokerService = makeBrokerService();

    const resolved = await resolveConfiguredForgePiCompactionAuth({
      config: handle.config,
      descriptor,
      getPiModelsJsonPath: () => "/tmp/pi-models.json",
      getOpenAIAuthBrokerRuntimeService: () => brokerService,
      compactionSettings: {
        timeoutMs: 300_000,
        model: { provider: "openai-codex", modelId: "gpt-5.5" },
        reasoningLevel: "low",
      },
      sessionModel: { provider: "anthropic", id: "claude-opus-4-5" } as never,
    });

    expect(brokerService.isBrokerModeActive).toHaveBeenCalledTimes(1);
    expect(brokerService.acquireForRuntime).toHaveBeenCalledWith(descriptor);
    expect(mocks.createPiModelRegistry).toHaveBeenCalledWith(brokerService.authStorage, "/tmp/pi-models.json");
    expect(resolved).toMatchObject({
      model: compactionModel,
      apiKey: "broker-compaction-key",
      authSource: "broker",
    });

    await resolved.complete?.({ outcome: "success" });
    expect(brokerService.report).toHaveBeenCalledWith(brokerService.handle, "success");
    expect(brokerService.release).toHaveBeenCalledWith(brokerService.handle, "compaction_success");
  });

  it("fails configured OpenAI broker auth without falling back to local or active-session auth", async () => {
    const handle = await makeHandle({
      sharedAuthContent: {
        "openai-codex": { type: "api_key", key: "local-openai-key" },
        anthropic: { type: "api_key", key: "active-anthropic-key" },
      },
    });
    const descriptor = makeCompactionGuardDescriptor();
    descriptor.model = { provider: "anthropic", modelId: "claude-opus-4-5", thinkingLevel: "medium" };
    const compactionModel = { provider: "openai-codex", id: "gpt-5.5", reasoning: true };
    const registry = {
      find: vi.fn(() => compactionModel),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: false as const,
        error: "broker lease was rejected",
      })),
    };
    mocks.createPiModelRegistry.mockReturnValue(registry);
    const brokerService = makeBrokerService();

    await expect(resolveConfiguredForgePiCompactionAuth({
      config: handle.config,
      descriptor,
      getPiModelsJsonPath: () => "/tmp/pi-models.json",
      getOpenAIAuthBrokerRuntimeService: () => brokerService,
      compactionSettings: {
        timeoutMs: 300_000,
        model: { provider: "openai-codex", modelId: "gpt-5.5" },
        reasoningLevel: "low",
      },
      sessionModel: { provider: "anthropic", id: "claude-opus-4-5" } as never,
    })).rejects.toMatchObject({
      details: expect.objectContaining({
        recoveryStage: "forge_compaction_auth_unavailable",
        authPolicy: "configured_compaction_provider_auth",
        fallbackPolicy: "reject_without_default_compaction_fallback",
        authSource: "broker",
        configuredProvider: "openai-codex",
        runtimeSessionProvider: "anthropic",
      }),
    });

    expect(mocks.createPiModelRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.createPiModelRegistry).toHaveBeenCalledWith(brokerService.authStorage, "/tmp/pi-models.json");
    expect(registry.getApiKeyAndHeaders).toHaveBeenCalledWith(compactionModel);
    expect(brokerService.report).not.toHaveBeenCalled();
    expect(brokerService.release).toHaveBeenCalledWith(brokerService.handle, "compaction_auth_resolution_failed");
  });

  it("fails closed when the only pooled credential is paused", async () => {
    const handle = await makeHandle();
    const descriptor = makeCompactionGuardDescriptor();
    const pool = {
      getPoolSize: vi.fn(async () => 0),
      getTotalPoolSize: vi.fn(async () => 1),
      select: vi.fn(),
    };

    await expect(resolveConfiguredForgePiCompactionAuth({
      config: handle.config,
      descriptor,
      getPiModelsJsonPath: () => "/tmp/pi-models.json",
      getCredentialPoolService: () => pool as never,
      compactionSettings: {
        timeoutMs: 300_000,
        model: { provider: "anthropic", modelId: "claude-opus-4-5" },
        reasoningLevel: "low",
      },
    })).rejects.toThrow("All pooled anthropic credentials are paused");

    expect(pool.select).not.toHaveBeenCalled();
  });
});

async function makeHandle(options: Parameters<typeof createTempConfig>[0] = {}): Promise<TempConfigHandle> {
  const handle = await createTempConfig({ prefix: "forge-compaction-auth-", ...options });
  handles.push(handle);
  return handle;
}

function makeBrokerService(): OpenAIAuthBrokerRuntimeService & {
  authStorage: AuthStorage;
  handle: OpenAIAuthBrokerLeaseHandle;
  isBrokerModeActive: ReturnType<typeof vi.fn>;
  acquireForRuntime: ReturnType<typeof vi.fn>;
  report: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const authStorage = AuthStorage.inMemory({
    "openai-codex": { type: "api_key", key: "broker-compaction-key" },
  });
  const handle: OpenAIAuthBrokerLeaseHandle = {
    leaseId: "lease-compaction-1",
    identity: { clientId: "forge", instanceId: "forge-test" },
    renewedAtMs: Date.now(),
    lease: {
      leaseId: "lease-compaction-1",
      credential: { type: "api_key", access: "broker-compaction-key" },
    },
  };

  return {
    authStorage,
    handle,
    isBrokerModeActive: vi.fn(async () => true),
    acquireForRuntime: vi.fn(async () => ({ authStorage, handle })),
    report: vi.fn(async () => handle),
    release: vi.fn(async () => undefined),
  } as never;
}
