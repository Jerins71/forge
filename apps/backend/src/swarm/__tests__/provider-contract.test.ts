import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ProviderCapabilitiesSchema, type ProviderCapabilities } from "@forge/protocol";
import { assertProviderRequirements, UnsupportedProviderBehaviorError, type ProviderAdapter } from "../runtime/provider-contract.js";
import { RuntimeFactory } from "../runtime/runtime-factory.js";

export const capabilities: ProviderCapabilities = {
  version: 1, provider: "synthetic", adapterVersion: "1",
  instructions: { channels: ["system"], update: "on_open", nativeBase: "none" },
  tools: { registration: "immutable", host: "loopback_mcp", nativeCallIdentity: true, cancellation: "abort_signal", extensionHooks: true },
  streaming: { text: "delta", reasoning: "none", tools: "final", usage: "final", terminal: "authoritative" },
  native: { resume: true, fork: false, steer: false, compact: false, readContext: false, interrupt: true },
  approvals: { lifetime: "live_callback", nativeRequestIdentity: true, childRequests: true },
  secureSessions: { supported: false, mechanism: "none" },
};

describe("provider behavior admission", () => {
  it.each(["nativeFork", "nativeSteer", "nativeCompact", "readContext", "instructionRefresh", "toolRefresh", "persistentApprovals", "secureSessions"] as const)("rejects required %s before dispatch", behavior => {
    const dispatch = vi.fn();
    expect(() => { assertProviderRequirements(capabilities, { [behavior]: true }); dispatch(); }).toThrow(UnsupportedProviderBehaviorError);
    expect(dispatch).not.toHaveBeenCalled();
    try { assertProviderRequirements(capabilities, { [behavior]: true }); } catch (error) {
      expect(error).toMatchObject({ code: "PROVIDER_BEHAVIOR_UNSUPPORTED", provider: "synthetic", behavior });
    }
  });
  it("accepts supported requirements and round-trips the snapshot", () => {
    expect(() => assertProviderRequirements(capabilities, { nativeResume: true, instructionChannel: "system" })).not.toThrow();
    expect(Value.Check(ProviderCapabilitiesSchema, JSON.parse(JSON.stringify(capabilities)))).toBe(true);
    expect(() => assertProviderRequirements(capabilities, { instructionChannel: "developer" })).toThrow(UnsupportedProviderBehaviorError);
  });
  it("admits actual adapter capabilities and cleans up rejected resources before dispatch", async () => {
    const prepare = vi.fn(async () => undefined);
    const terminate = vi.fn(async () => {});
    const start = vi.fn();
    const runtime = { providerAdapter: { capabilities: () => capabilities, start }, terminate };
    const factory = new RuntimeFactory({ getSecureRuntimeBinding: prepare } as never);
    const creator = (factory as unknown as { cursorSdkRuntimeCreator: { createRuntimeForDescriptor: () => Promise<unknown> } }).cursorSdkRuntimeCreator;
    const create = vi.spyOn(creator, "createRuntimeForDescriptor").mockResolvedValue(runtime);
    const descriptor = { agentId: "actor", role: "manager", managerId: "actor",
      model: { provider: "cursor-sdk", modelId: "composer-2.5", thinkingLevel: "medium" } } as never;
    await expect(factory.createRuntimeForDescriptor(descriptor, "instructions", 1,
      { providerRequirements: { nativeFork: true } })).rejects.toMatchObject({ code: "PROVIDER_BEHAVIOR_UNSUPPORTED", provider: "synthetic", behavior: "nativeFork" });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledExactlyOnceWith({ abort: true });
    expect(start).not.toHaveBeenCalled();

    terminate.mockClear();
    await expect(factory.createRuntimeForDescriptor(descriptor, "instructions", 2,
      { providerRequirements: { nativeResume: true, instructionChannel: "system" } })).resolves.toBe(runtime);
    expect(terminate).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it("keeps the adapter surface independent of the legacy lifecycle runtime", () => {
    const methodNames: Array<keyof ProviderAdapter> = ["capabilities", "open", "resume", "start", "steer", "interrupt", "respond", "compact", "fork", "readContext", "close", "drain", "observations"];
    expect(methodNames).toHaveLength(13);
  });
});
