import { describe, expect, it } from "vitest";

import { cloneDescriptorForPersistence, cloneDescriptorForPublic } from "../agents/descriptor-store/descriptor-clone.js";
import type { AgentDescriptor } from "../types.js";

function codexWorkerDescriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: "mgr-1--codex",
    managerId: "mgr-1",
    displayName: "Codex",
    role: "worker",
    status: "idle",
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
    cwd: "/tmp",
    model: {
      provider: "codex-app-server",
      modelId: "app-server",
      thinkingLevel: "none",
    },
    sessionFile: "/tmp/workers/mgr-1--codex.jsonl",
    externalThread: {
      type: "codex_app_server",
      persisted: true,
      createdByMention: true,
      threadId: "thread-1",
      lastTurnId: "turn-1",
    },
    ...overrides,
  };
}

describe("descriptor clone externalThread", () => {
  it("persists worker parent context without exposing it publicly", () => {
    const source = codexWorkerDescriptor({
      workerParentContext: {
        schemaVersion: 1,
        assignmentId: "assignment-1",
        managerId: "mgr-1",
        assignedAt: "2026-07-16T12:00:00.000Z",
        completedAt: "2026-07-16T12:05:00.000Z",
        outputTarget: {
          kind: "session_transcript",
          channel: "web",
          sourceContext: { channel: "web", channelId: "session-1" },
        },
        rootTurnId: "root-1",
      },
    });

    const persisted = cloneDescriptorForPersistence(source);
    expect(persisted.workerParentContext).toEqual(source.workerParentContext);
    expect(persisted.workerParentContext).not.toBe(source.workerParentContext);
    expect(persisted.workerParentContext?.outputTarget).not.toBe(
      source.workerParentContext?.outputTarget,
    );

    const publicDescriptor = cloneDescriptorForPublic(source);
    expect(publicDescriptor).not.toHaveProperty("workerParentContext");
  });
});
