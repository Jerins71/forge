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

it("drops legacy work-mode, roster and route fields from persisted profiles and descriptors", () => {
  const descriptor = {
    agentId: "forge", managerId: "forge", displayName: "forge", role: "manager", status: "idle",
    createdAt: NOW, updatedAt: NOW, cwd: "/tmp", model: { ...DEFAULT_MODEL }, sessionFile: "/tmp/forge-data/x.jsonl", profileId: "forge",
    managerPosture: "delegation_first", managerPostureOrigin: "session_override",
    delegationRosterId: "balanced", delegationRosterOrigin: "global_default",
  };
  const worker = {
    ...descriptor, agentId: "w1", role: "worker",
    managerPosture: undefined, specialistId: "route:builder", specialistDisplayName: "Builder", specialistTier: "deep", specialistLens: "planner",
    delegationRouteId: "builder", delegationRouteLabel: "Builder", delegationRosterRevision: 0,
    delegationFallbackModel: "broken", delegationCapabilityEscalationRouteId: "",
  };
  const decoded = decodeAgentsStoreFile(JSON.stringify({
    agents: [descriptor, worker],
    profiles: [{ ...profile("forge"), defaultManagerPosture: "from_the_future", defaultDelegationRosterId: "balanced" }],
  }), storeOptions());

  expect(decoded.skippedDescriptorCount).toBe(0);
  const legacyKeys = /Posture|delegation|specialistTier|specialistLens/;
  for (const record of [...decoded.store.agents, ...(decoded.store.profiles ?? [])]) {
    expect(Object.keys(record).filter((key) => legacyKeys.test(key))).toEqual([]);
  }
  expect(decoded.store.agents[1]).toMatchObject({ specialistId: "route:builder", specialistDisplayName: "Builder" });
});
