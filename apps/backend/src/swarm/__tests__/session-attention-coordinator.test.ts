import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentDescriptor, ManagerProfile } from "@forge/protocol";
import { describe, expect, it } from "vitest";

import {
  SessionAttentionCoordinator,
  type SessionAttentionSessionSnapshot,
} from "../session/session-attention-coordinator.js";
import { isSessionAttentionEligible } from "../session/session-attention-eligibility.js";
import { SessionAttentionStore } from "../session/session-attention-store.js";

// Failure modes covered: a completed run that is not preceded by an observed streaming edge (a
// provider/settings switch rebinds the runtime) leaves the earlier failure visible forever; the
// supersede rule over-reaches and clears a failure that is still true (an errored worker) or a
// decision the user still owes; a worker's success clears its manager's failure.
const manager = { agentId: "session", managerId: "session", role: "manager", profileId: "profile", status: "idle" } as AgentDescriptor;
const profile = { profileId: "profile" } as ManagerProfile;
const session = (overrides: Partial<SessionAttentionSessionSnapshot> = {}): SessionAttentionSessionSnapshot => ({
  manager, profile, activeWorkerCount: 0, pendingChoiceCount: 0, hasTerminallyErroredWorker: false, pendingTurnContextCount: 0, ...overrides,
});

async function failedSession() {
  const coordinator = new SessionAttentionCoordinator({
    store: new SessionAttentionStore({ dataDir: await mkdtemp(join(tmpdir(), "session-attention-")) }),
    isEligible: isSessionAttentionEligible,
  });
  await coordinator.initialize();
  await coordinator.observeRunOutcome(session(), "failed");
  expect(coordinator.getSnapshot().attentions.map(row => row.reason)).toEqual(["work_failed"]);
  return coordinator;
}

describe("SessionAttentionCoordinator failure supersede", () => {
  it("a later completed manager run clears earlier failure attention", async () => {
    const coordinator = await failedSession();
    await coordinator.observeRunOutcome(session(), "completed");
    expect(coordinator.getSnapshot().attentions).toEqual([]);
  });

  it("keeps failure attention while an owned worker is still errored", async () => {
    const coordinator = await failedSession();
    await coordinator.observeRunOutcome(session({ hasTerminallyErroredWorker: true }), "completed");
    expect(coordinator.getSnapshot().attentions.map(row => row.reason)).toEqual(["work_failed"]);
  });

  it("a worker's completed run does not clear its manager's failure", async () => {
    const coordinator = await failedSession();
    await coordinator.observeRunOutcome(session(), "completed", "owned_worker");
    expect(coordinator.getSnapshot().attentions.map(row => row.reason)).toEqual(["work_failed"]);
  });

  it("a completed run does not clear a pending decision", async () => {
    const coordinator = await failedSession();
    await coordinator.observeAggregateChange(session({ pendingChoiceCount: 1 }));
    await coordinator.observeRunOutcome(session({ pendingChoiceCount: 1 }), "completed");
    expect(coordinator.getSnapshot().attentions.map(row => row.reason)).toEqual(["decision_waiting"]);
  });
});
