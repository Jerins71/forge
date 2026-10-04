import { expect, it, vi } from "vitest";

import { decodeAgentsStoreFile } from "../agents/descriptor-store/descriptor-codec.js";
import type { AgentModelDescriptor, ManagerProfile } from "../types.js";

const NOW = "2026-07-13T20:00:00.000Z";
const DEFAULT_MODEL: AgentModelDescriptor = {
  provider: "openai-codex",
  modelId: "gpt-5.5",
  thinkingLevel: "medium",
};

function storeOptions() {
  return {
    dataDir: "/tmp/forge-data",
    storeFilePath: "/tmp/forge-data/swarm/agents.json",
    logDebug: vi.fn(),
    warn: vi.fn(),
  };
}

function profile(profileId: string, overrides: Partial<ManagerProfile> = {}): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: profileId,
    defaultModel: { ...DEFAULT_MODEL },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

it("preserves legacy absence and explicit Secure Sessions choices; malformed persisted values fail closed", () => {
  for (const [value, expected] of [[undefined, undefined], [true, true], [false, false], ["true", false]] as const) {
    const decoded = decodeAgentsStoreFile(JSON.stringify({ agents: [], profiles: [{ ...profile("forge"), secureSessionsEnabled: value }] }), storeOptions());
    expect(decoded.store.profiles?.[0]?.secureSessionsEnabled).toBe(expected);
  }
});
