import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ToolHostSnapshotSchema } from "@forge/protocol";
import { bindRuntimeToolHost, buildBaseRuntimeTools, planRuntimeTools } from "../runtime/runtime-tool-plan.js";
import { createProviderBoundaryFixture } from "./provider-boundary-fixture.js";

const ref = { kind: "tool_call" as const, threadId: "manager", bindingId: "binding", generation: 3,
  conversationId: "native-thread", turnId: "turn", nativeId: "native-call" };

describe("production tool host binding", () => {
  it("retains schemas and invokes a real Forge choice tool through existing extension hooks", async () => {
    const fixture = await createProviderBoundaryFixture();
    try {
      const descriptor = fixture.descriptor("codex-native");
      const requestUserChoice = vi.fn(async () => [{ questionId: "q", selectedOptionIds: [], text: "chosen" }]);
      const before = vi.fn(async () => undefined);
      const after = vi.fn(async () => undefined);
      const host = { ...fixture.deps.host, requestUserChoice };
      const forgeExtensionHost = { ...fixture.deps.forgeExtensionHost, dispatchToolBefore: before, dispatchToolAfter: after };
      const plan = planRuntimeTools({ host, descriptor, forgeExtensionHost, preparedForgeBindings: { bindingToken: "extensions" } } as never);
      const binding = bindRuntimeToolHost({ ...fixture.deps, host, descriptor, forgeExtensionHost,
        tools: plan.swarmTools, preparedForgeBindings: { bindingToken: "extensions" }, mechanism: "dynamic_tools" } as never);
      expect(binding.snapshot.tools).toEqual(buildBaseRuntimeTools(host as never, descriptor).map(tool => ({ name: tool.name, description: tool.description,
        inputSchema: JSON.parse(JSON.stringify(tool.parameters)) })));
      expect(Value.Check(ToolHostSnapshotSchema, JSON.parse(JSON.stringify(binding.snapshot)))).toBe(true);
      const result = await binding.invoke({ ref, name: "present_choices", args: { questions: [{ id: "q", question: "Choose", isOther: true }] }, context: {} as never });
      expect(result.content).toHaveLength(1);
      expect(requestUserChoice).toHaveBeenCalledWith("manager", [{ id: "q", question: "Choose", isOther: true }]);
      expect(before).toHaveBeenCalledWith("extensions", expect.objectContaining({ toolCallId: "native-call" }));
      expect(after).toHaveBeenCalledWith("extensions", expect.objectContaining({ toolCallId: "native-call", result: expect.objectContaining({ ok: true }) }));
      expect(() => JSON.stringify(binding)).toThrow("ephemeral");
    } finally { await fixture.cleanup(); }
  });
  it("preserves AbortSignal and updates and rejects a different actor before invocation", async () => {
    const descriptor = { agentId: "manager", role: "manager", profileId: "profile" } as never;
    const execute = vi.fn(async (_id, _args, signal, update) => { signal.throwIfAborted(); update?.({ content: [{ type: "text", text: "update" }], details: undefined });
      return { content: [{ type: "text" as const, text: "result" }], details: undefined }; });
    const binding = bindRuntimeToolHost({ descriptor, tools: [{ name: "synthetic", label: "Synthetic", description: "Test cancellation", parameters: Type.Object({}), execute }] } as never);
    const controller = new AbortController();
    const update = vi.fn();
    await binding.invoke({ ref, name: "synthetic", args: {}, signal: controller.signal, onUpdate: update, context: {} as never });
    expect(execute.mock.calls[0]).toEqual(["native-call", {}, controller.signal, update, {}]);
    expect(update).toHaveBeenCalledOnce();
    controller.abort(new Error("cancelled"));
    await expect(binding.invoke({ ref, name: "synthetic", args: {}, signal: controller.signal, context: {} as never })).rejects.toThrow("cancelled");
    await expect(binding.invoke({ ref: { ...ref, threadId: "another" }, name: "synthetic", args: {}, context: {} as never })).rejects.toThrow("actor");
    expect(execute).toHaveBeenCalledOnce();
  });
});
