import type { AgentDescriptor } from "../swarm/types.js";

export function makeCompactionGuardDescriptor(): AgentDescriptor {
  return {
    agentId: "guard-worker",
    displayName: "Guard Worker",
    role: "worker",
    managerId: "manager",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
    },
    sessionFile: "/tmp/project/session.jsonl",
  };
}
