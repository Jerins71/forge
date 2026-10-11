import { SpecialistFallbackPolicy } from "../specialist-fallback-policy.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { installPiProviderContextImageResize } from "../runtime/pi/pi-runtime-creator.js";
import type { SecureRuntimeBinding } from "../secure-sessions/runtime/secure-runtime-binding.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, streamSimple } from "../pi/pi-ai-compat.js";
import { installOpenRouterRequestPolicy, withOpenRouterRequestPolicy } from "../runtime/pi/openrouter-request-policy.js";
import { modelCatalogService } from "../catalog/model-catalog-service.js";
import { writeOpenRouterModels } from "../catalog/openrouter-models.js";
import { getOpenRouterModelsPath } from "../data-paths.js";
import { PiGenerationTelemetryAdapter } from "../runtime/generation-telemetry.js";
import { shouldRetrySpecialistSpawnWithFallback } from "../swarm-manager-utils.js";

let root: string;
let bodies: Record<string, unknown>[];
let headers: Headers[];
const model = getModel("openrouter", "openai/gpt-4.1");
const context = { messages: [{ role: "user" as const, content: "Synthetic routing test", timestamp: 1 }] };
let respond: (() => Response | Promise<Response>) | undefined;
function ok() {
  return new Response('data: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"summary"},"finish_reason":null}]}\n\ndata: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-routing-"));
  await modelCatalogService.loadOverrides(root);
  bodies = []; headers = []; respond = undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(new URL(request.url).hostname).toBe("openrouter.ai");
    bodies.push(JSON.parse(await request.text()));
    headers.push(request.headers);
    return respond?.() ?? ok();
  }));
});
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function save(routingDefaults: Record<string, unknown>) {
  await writeOpenRouterModels(root, { version: 1, models: {}, routingDefaults });
  await modelCatalogService.reloadOpenRouterModels();
}
async function sessionFor(sessionManager = SessionManager.inMemory(root), customTools: ToolDefinition[] = []) {
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } } });
  const authStorage = AuthStorage.inMemory({});
  authStorage.setRuntimeApiKey("openrouter", "synthetic-test-key");
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, authStorage, modelRegistry, model, thinkingLevel: "off", sessionManager, resourceLoader, settingsManager, noTools: "builtin", customTools });
  installOpenRouterRequestPolicy(session);
  const telemetry = new PiGenerationTelemetryAdapter({ session, reasoningLevel: null, onGenerationEvent: () => {} });
  telemetry.install();
  return { session, telemetry };
}

describe("OpenRouter request boundary (real Pi HTTP serialization, synthetic transport only)", () => {
  it("enforces routing on the supported secure-bound Pi path after context guarding", async () => {
    await save({ zdr: true });
    const { session } = await sessionFor();
    const binding: SecureRuntimeBinding = {
      executeBash: vi.fn(), createOutputGuard: vi.fn(),
      guardValue: <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll("synthetic-canary", "guarded")) as T,
    };
    // Secure Sessions keeps model dispatch in the host Pi session; only tools execute in the guest.
    installPiProviderContextImageResize(session, binding);
    await session.prompt("synthetic-canary");
    expect(bodies[0].provider).toEqual({ zdr: true });
    expect(JSON.stringify(bodies[0])).not.toContain("synthetic-canary");
    expect(JSON.stringify(bodies[0])).toContain("guarded");
    await save({ data_collection: "deny" });
    await session.prompt("after secure-bound save");
    expect(bodies[1].provider).toEqual({ data_collection: "deny" });
    session.dispose();
  });

  it("restores final policy after payload extensions strip/mutate it; rejects model fallback overrides before transport", async () => {
    await save({ zdr: true, only: ["azure"], allow_fallbacks: false });
    const stream = withOpenRouterRequestPolicy(streamSimple);
    const result = await (await stream(model, context, { apiKey: "synthetic", onPayload: (payload, callbackModel) => {
      callbackModel.compat!.openRouterRouting!.only!.push("untrusted");
      return { ...payload as object, provider: { zdr: false } };
    } })).result();
    expect(result.stopReason).toBe("stop");
    expect(bodies[0].provider).toEqual({ zdr: true, only: ["azure"], allow_fallbacks: false });
    for (const override of [{ model: "other/model" }, { models: ["other/model"] }, { route: "fallback" }]) {
      const result = await (await stream(model, context, { apiKey: "synthetic", onPayload: (payload) => ({ ...payload as object, ...override }) })).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("routing rejected");
    }
    expect(bodies).toHaveLength(1);
  });

  it("fails closed on unreadable saved policy and custom endpoints while leaving non-OpenRouter unchanged", async () => {
    const stream = withOpenRouterRequestPolicy(streamSimple);
    await save({});
    await writeFile(getOpenRouterModelsPath(root), "{broken");
    await expect(modelCatalogService.reloadOpenRouterModels()).rejects.toThrow();
    expect(() => stream(model, context, { apiKey: "synthetic" })).toThrow("unreadable");
    expect(() => stream({ ...model, baseUrl: "https://other.example/api/v1" }, context)).toThrow("cannot be enforced");
    const otherStream = vi.fn(() => "sentinel" as never);
    const other = { ...model, provider: "unrelated" };
    expect(withOpenRouterRequestPolicy(otherStream)(other, context)).toBe("sentinel");
    expect(otherStream).toHaveBeenCalledWith(other, context, undefined);
    expect(bodies).toHaveLength(0);
  });

  it.each([{ zdr: true }, { only: ["azure"] }])("blocks cross-model/provider fallback with hard policy %j", async (policy) => {
    await save(policy);
    expect(shouldRetrySpecialistSpawnWithFallback(new Error("429 rate limit"), { provider: "openrouter", modelId: model.id })).toBe(false);
    expect(shouldRetrySpecialistSpawnWithFallback(new Error("invalid api key"), { provider: "openrouter", modelId: model.id })).toBe(false);
    expect(shouldRetrySpecialistSpawnWithFallback(new Error("429 rate limit"), { provider: "openai", modelId: "gpt-4.1" })).toBe(true);
    const capacity=vi.fn(model=>model);
    const worker={role:'worker',model:{provider:'openrouter',modelId:model.id},delegationFallbackModel:{provider:'openai',modelId:'gpt-4.1'}} as import('../types.js').AgentDescriptor;
    const fallback = new SpecialistFallbackPolicy({descriptors:new Map(),resolveSpecialistRosterForProfile:async()=>[],resolveSpawnModelWithCapacityFallback:capacity});
    expect(await fallback.resolveSpecialistFallbackModelForDescriptor(worker)).toBeUndefined();expect(capacity).not.toHaveBeenCalled();

  });
});
