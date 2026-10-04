import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { AgentDescriptor } from "../types.js";
import { RuntimeFactory } from "../runtime/runtime-factory.js";
import { SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE, SECURE_RUNTIME_GUARD_FAILURE_MESSAGE, type SecureRuntimeBinding } from "../secure-sessions/runtime/secure-runtime-binding.js";

import { guardSecureRuntimeTools } from "../secure-sessions/runtime/pi-secure-tools.js";

import { installPiProviderContextImageResize } from "../runtime/pi/pi-runtime-creator.js";

const SECRET = "secure-canary-value";

function createDescriptor(provider: string): AgentDescriptor {
  return {
    agentId: "worker-1",
    displayName: "Worker 1",
    role: "worker",
    managerId: "manager-1",
    profileId: "profile-1",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/forge-secure-runtime-test",
    model: {
      provider,
      modelId: "test-model",
      thinkingLevel: "medium",
    },
    sessionFile: "/tmp/forge-secure-runtime-test/session.jsonl",
  };
}

function guardUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replaceAll(SECRET, "[guarded]");
  }
  if (Array.isArray(value)) {
    return value.map(guardUnknown);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value.toString("utf8").replaceAll(SECRET, "[guarded]"));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, guardUnknown(entry)]),
    );
  }
  return value;
}

function createBinding(
  overrides: Partial<SecureRuntimeBinding> = {},
): SecureRuntimeBinding {
  return {
    executeBash: vi.fn(async () => ({ exitCode: 0 })),
    createOutputGuard: vi.fn(() => ({
      write: (data: Uint8Array) => Buffer.from(data),
      close: async () => Buffer.alloc(0),
      dispose: vi.fn(),
    })),
    guardValue: <T>(value: T) => guardUnknown(value) as T,
    ...overrides,
  };
}

describe("Secure runtime provider boundary", () => {
  it("replaces binding-resolution failures with a fixed non-secret error", async () => {
    const factory = new RuntimeFactory({
      getSecureRuntimeBinding: () => {
        throw new Error(SECRET);
      },
    } as never);

    await expect(
      factory.createRuntimeForDescriptor(createDescriptor("cursor-sdk"), "system"),
    ).rejects.toThrow(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);
  });
});

describe("Secure Pi runtime interception", () => {
  it("guards tool updates, final results, and thrown errors", async () => {
    const binding = createBinding();
    const guardedTool = guardSecureRuntimeTools(
      [
        {
          name: "test",
          label: "test",
          description: "test",
          parameters: {} as never,
          async execute(_id, _params, _signal, onUpdate) {
            onUpdate?.({
              content: [{ type: "text", text: `update:${SECRET}` }],
              details: undefined,
            });
            return {
              content: [{ type: "text", text: `result:${SECRET}` }],
              details: undefined,
            };
          },
        },
      ],
      binding,
    )[0]!;
    const updates: unknown[] = [];

    const result = await guardedTool.execute(
      "call-1",
      {},
      undefined,
      (update) => updates.push(update),
      {} as never,
    );

    expect(JSON.stringify({ result, updates })).not.toContain(SECRET);
    expect(JSON.stringify({ result, updates })).toContain("[guarded]");

    const failingTool = guardSecureRuntimeTools(
      [
        {
          ...guardedTool,
          async execute() {
            throw new Error(`failure:${SECRET}`);
          },
        },
      ],
      binding,
    )[0]!;

    await expect(
      failingTool.execute("call-2", {}, undefined, undefined, {} as never),
    ).rejects.toThrow("failure:[guarded]");
  });

  it("fails closed when the final provider-context guard fails or changes shape", async () => {
    for (const guardValue of [
      () => {
        throw new Error(SECRET);
      },
      () => "[guarded]",
    ]) {
      const session = {
        agent: {
          transformContext: vi.fn(async (messages: unknown) => messages),
        },
      };
      installPiProviderContextImageResize(
        session as never,
        createBinding({ guardValue: guardValue as never }),
      );

      await expect(
        session.agent.transformContext([], undefined),
      ).rejects.toThrow(SECURE_RUNTIME_GUARD_FAILURE_MESSAGE);
    }
  });
});
