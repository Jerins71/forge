import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createControlCore, type ControlCore } from "../database.js";
import type { ControlCoreOptions } from "../effect-types.js";
import type { ProviderAdapter, ProviderBinding } from "../../../swarm/runtime/provider-contract.js";
import { piProviderCapabilities } from "../../../swarm/runtime/pi/pi-provider-adapter.js";
import { loadState, rebuildLifecycleProjections } from "./store.js";
import type { ChoiceQuestion, ProviderObservation } from "@forge/protocol";
import { SwarmChoiceService } from "../../../swarm/swarm-choice-service.js";
import { createCoreChoicePort } from "./choice-port.js";
import { createDetailStream } from "../../streams/detail-stream.js";
import { requestChoiceId } from "./request-projection.js";

const roots: string[] = []; const cores: ControlCore[] = [];
afterEach(async () => { for (const core of cores.splice(0)) await core.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const principal = { deviceSessionId: "device", scopes: new Set(["session:operate" as const]) };
const answerId = "00000000-0000-4000-8000-000000000001";
const questions: ChoiceQuestion[] = [{ id: "permission", question: "Allow the operation?", options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }] }];
const answers = [{ questionId: "permission", selectedOptionIds: ["allow"] }];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-core-requests-")); roots.push(root);
  let serial = 0; let now = 1_800_000_000_000;
  const responses: unknown[] = []; const caps = piProviderCapabilities();
  const adapter: ProviderAdapter = {
    capabilities: () => caps, open: async () => { throw new Error("port supplies binding"); }, resume: async () => { throw new Error("unused"); },
    start: async input => ({ status: "accepted", turn: { ...input.binding.scope, kind: "turn", conversationId: "native", nativeId: "turn" } }),
    steer: async () => { throw new Error("unused"); }, interrupt: async () => {}, respond: async input => { responses.push(input); }, compact: async () => {},
    async *observations() {}, close: async () => {}, drain: async () => ({ status: "clean" }),
  };
  const options: ControlCoreOptions = { databasePath: path.join(root, "control.sqlite"), clock: () => now, random: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`, isDeviceRevoked: () => false,
    artifacts: { validateInput: () => [], pinInput: () => {} }, workspace: { prepareLaunch: async () => { throw new Error("unused"); }, isLaunchCurrent: () => true, ensure: async () => ({ cwd: root, branch: null }), reconcile: async () => "retry" },
    swarm: { ensureSession: async () => ({ materialized: true }), stopSession: async () => ({ stopped: true }), applyChoice: async () => { throw new Error("Native requests must go through the kernel"); },
      acquireProvider: async scope => ({ adapter, binding: { scope, conversation: { ...scope, kind: "conversation", nativeId: "native" }, capabilities: caps, instructionRevision: "fixture", toolContractRevision: "fixture" } satisfies ProviderBinding }),
      applyInput: async input => ({ entryId: input.inputId, runtimeMessage: { text: input.message.text } }),
    } };
  const open = async () => { const core = await createControlCore(options); cores.push(core); await core.reconcileOnBoot(); return core; };
  const core = await open();
  core.eventSink.transaction(tx => core.eventSink.append(tx, { topic: "shell", sessionId: "manager", event: { type: "session.upsert", session: { sessionId: "manager", projectId: "project", title: "fixture", status: "idle", attention: "none", unread: 0, workerCount: 0, archived: false, updatedAt: new Date(now).toISOString(), sortKey: "fixture", workspace: { kind: "current_checkout", cwd: root, branch: null } } } }));
  await core.controlService.submitInput({ commandId: "initial", threadId: "manager", message: { text: "fixture", artifactIds: [] } }); await core.effectWorker.drain();
  function observation(kind: "approval" | "user_input", expiresAt?: string): Extract<ProviderObservation, { type: "request_opened" }> {
    const state = loadState(core.database); const attempt = state.attempts[state.runs["run-initial"].activeAttemptId]; const binding = state.bindings[attempt.bindingId];
    return { type: "request_opened", scope: binding.scope, attemptId: attempt.attemptId, sequence: attempt.lastSequence + 1,
      origin: { kind: "root", conversation: binding.conversation, turn: attempt.turn }, request: { ...binding.scope, kind: "request", conversationId: "native", nativeId: kind },
      lifetime: { kind: "live_callback", generation: binding.scope.generation, ...(expiresAt ? { expiresAt } : {}) }, requestKind: kind, payload: { questions } };
  }
  function publish(value: ProviderObservation) { core.controlService.record({ type: "provider.observe", commandId: `observation-${++serial}`, now, observation: value }); return Object.values(loadState(core.database).requests).at(-1)!; }
  return { core, open, adapter, responses, observation, publish, advance: () => { now += 60_000; } };
}
function choice(core: ControlCore, requestId: string) { const row = core.database.prepare("SELECT choice_json FROM control_choices WHERE choice_id=?").get(requestId) as { choice_json: string } | undefined; return row && JSON.parse(row.choice_json); }

async function snapshotChoices(core: ControlCore) {
  const abort = new AbortController();
  const stream = createDetailStream({ database: core.database, subscribeCommitted: listener => core.eventSink.subscribe(listener),
    getDescriptor: () => { throw new Error("Detail snapshot does not read the descriptor"); }, withReadBarrier: fn => core.eventSink.readBarrier(fn).value }).detail(principal, { sessionId: "manager" }, abort.signal);
  try { const frame = (await stream.next()).value; if (frame?.kind !== "snapshot") throw new Error("Expected fresh detail snapshot"); return frame.snapshot.choices; }
  finally { abort.abort(); await stream.return(undefined); }
}

describe("authoritative native choices", () => {
  it.each(["approval", "user_input"] as const)("projects and answers %s through the retained request and outbox", async kind => {
    const f = await fixture(); const published: unknown[] = [];
    f.core.eventSink.subscribe(event => { if (event.event.type === "choice.upsert") { expect(f.core.database.inTransaction).toBe(false); published.push(event.event.choice); } });
    const request = f.publish(f.observation(kind));
    expect(choice(f.core, request.requestId)).toEqual({ choiceId: request.requestId, agentId: "manager", status: "pending", questions });
    expect(published).toHaveLength(1);
    const input = { commandId: answerId, sessionId: "manager", choiceId: request.requestId, answers };
    await f.core.controlService.execute(principal, "session.choose", input); await f.core.effectWorker.drain();
    expect(f.responses).toEqual([expect.objectContaining({ request: request.ref, lifetime: request.lifetime, response: answers })]);
    expect(loadState(f.core.database).requests[request.requestId].state).toBe("resolved"); expect(choice(f.core, request.requestId).status).toBe("answered");
    expect((await f.core.controlService.execute(principal, "session.choose", input)).state).toBe("succeeded"); expect(f.responses).toHaveLength(1);
    await expect(f.core.controlService.execute(principal, "session.choose", { ...input, commandId: "00000000-0000-4000-8000-000000000002" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.core.database.prepare("SELECT 1 FROM effects WHERE kind='choice.apply'").get()).toBeUndefined();
  });
  it("rolls back the request, choice projection and publication together", async () => {
    const f = await fixture(); const observation = f.observation("approval"); const count = f.core.eventSink.highWater;
    expect(() => f.core.eventSink.transaction(tx => { f.core.eventSink.commitCommand(tx, { type: "provider.observe", commandId: "rollback", now: 1_800_000_000_000, observation }); throw new Error("rollback"); })).toThrow("rollback");
    expect(loadState(f.core.database).requests).toEqual({}); expect(f.core.database.prepare("SELECT COUNT(*) n FROM control_choices").get()).toEqual({ n: 0 }); expect(f.core.eventSink.highWater).toBe(count);
  });
  it.each(["approval", "user_input"] as const)("expires %s on reboot and bootstraps the retained non-answerable question", async kind => {
    const f = await fixture(); const request = f.publish(f.observation(kind));
    expect(await snapshotChoices(f.core)).toEqual([choice(f.core, request.requestId)]);
    expect(choice(f.core, request.requestId)?.status).toBe("pending"); await f.core.close(); const reboot = await f.open();
    expect(loadState(reboot.database).requests[request.requestId].state).toBe("expired"); expect(choice(reboot, request.requestId).status).toBe("expired");
    const before = choice(reboot, request.requestId); reboot.database.prepare("DELETE FROM control_choices WHERE choice_id=?").run(request.requestId); rebuildLifecycleProjections(reboot.database);
    expect(choice(reboot, request.requestId)).toEqual(before);
    expect(await snapshotChoices(reboot)).toEqual([before]);
    await expect(reboot.controlService.execute(principal, "session.choose", { commandId: answerId, sessionId: "manager", choiceId: request.requestId, answers })).rejects.toMatchObject({ code: "CONFLICT" });
    await reboot.effectWorker.drain(); expect(f.responses).toEqual([]);
  });
  it("bounds closed choice history while retaining every pending choice in a fresh snapshot", async () => {
    const f = await fixture(); const closed: string[] = [];
    for (let index = 0; index < 21; index++) {
      const observation = f.observation("user_input"); observation.request.nativeId = `closed-${index}`;
      const request = f.publish(observation); closed.push(request.requestId);
      f.core.controlService.record({ type: "request.expire", commandId: `expire-${index}`, now: 1_800_000_000_000, threadId: "manager", requestId: request.requestId });
    }
    const pending = f.publish(f.observation("approval")); const choices = await snapshotChoices(f.core);
    expect(choices).toHaveLength(20); expect(choices).toContainEqual(choice(f.core, pending.requestId));
    expect(choices.some(choice => choice.choiceId === closed[0])).toBe(false);
    expect(Object.values(loadState(f.core.database).requests)).toHaveLength(22);
  });
  it("rejects an expired answer and settles the projection without calling the provider", async () => {
    const f = await fixture(); const request = f.publish(f.observation("approval", new Date(1_800_000_030_000).toISOString())); f.advance();
    await expect(f.core.controlService.execute(principal, "session.choose", { commandId: answerId, sessionId: "manager", choiceId: request.requestId, answers })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(loadState(f.core.database).requests[request.requestId].state).toBe("expired"); expect(choice(f.core, request.requestId).status).toBe("expired"); expect(f.responses).toEqual([]);
  });
  it("settles pending callbacks and the choice projection on stop before releasing the provider", async () => {
    const f = await fixture(); const request = f.publish(f.observation("approval"));
    await f.core.controlService.execute(principal, "session.stop", { commandId: answerId, sessionId: "manager" });
    expect(loadState(f.core.database).requests[request.requestId].state).toBe("cancelled"); expect(choice(f.core, request.requestId).status).toBe("cancelled");
    await f.core.effectWorker.drain(); expect(f.responses).toEqual([]);
  });
  it("exposes the same request through the facade and CLI choice owner reads", async () => {
    const f = await fixture(); const request = f.publish(f.observation("user_input"));
    const service = new SwarmChoiceService({ now: () => new Date(1_800_000_000_000).toISOString(), getDescriptor: () => undefined, emitChoiceRequest() {}, emitAgentsSnapshot() {} });
    service.installCore(createCoreChoicePort({ database: f.core.database, controlService: f.core.controlService, clock: () => 1_800_000_000_000, random: () => "facade-answer" }));
    expect(service.hasPendingChoicesForSession("manager")).toBe(true); expect(service.getPendingChoiceIdsForSession("manager")).toEqual([request.requestId]);
    expect(service.getPendingChoice(request.requestId)).toEqual({ agentId: "manager", sessionAgentId: "manager", questions });
    expect(service.getPendingChoiceRequestsForSession("manager")).toEqual([expect.objectContaining({ choiceId: request.requestId, status: "pending" })]);
    service.resolveChoiceRequest(request.requestId, answers); await f.core.effectWorker.drain();
    expect(f.responses).toHaveLength(1); expect(service.getPendingChoice(request.requestId)).toBeUndefined(); expect(service.hasPendingChoicesForSession("manager")).toBe(false);
  });
  it("cancels a native choice through lifecycle admission and the kernel", async () => {
    const f = await fixture(); const request = f.publish(f.observation("user_input"));
    await f.core.controlService.admitLifecycle(principal, { commandId: answerId, command: "session.choice.cancel", sessionIds: ["manager"], intent: "cancel-choice", choiceId: request.requestId, request: {}, receipt: { method: "session.choice.cancel", sessionId: "manager" } }, async () => {
      expect(loadState(f.core.database).requests[request.requestId].state).toBe("cancelled"); return {};
    });
    expect(choice(f.core, request.requestId).status).toBe("cancelled"); expect(f.responses).toEqual([]);
  });
  it("maps a native stale-callback rejection to an expired choice and typed receipt error", async () => {
    const f = await fixture(); const request = f.publish(f.observation("approval"));
    f.adapter.respond = async () => { throw Object.assign(new Error("Provider callback expired"), { code: "PROVIDER_REQUEST_REJECTED" }); };
    await f.core.controlService.execute(principal, "session.choose", { commandId: answerId, sessionId: "manager", choiceId: request.requestId, answers }); await f.core.effectWorker.drain();
    expect(loadState(f.core.database).requests[request.requestId].state).toBe("expired"); expect(choice(f.core, request.requestId).status).toBe("expired");
    expect(await f.core.controlService.getReceipt(principal, answerId)).toMatchObject({ state: "interrupted", error: { code: "CONFLICT", retryable: false } });
    expect(loadState(f.core.database).recovery).toBeNull(); expect(loadState(f.core.database).runs["run-initial"].state).toBe("running");
  });
  it("projects native cancellation as cancelled rather than answered", async () => {
    const f = await fixture(); const opened = f.observation("user_input"); const request = f.publish(opened);
    f.publish({ type: "request_resolved", scope: opened.scope, attemptId: opened.attemptId, sequence: opened.sequence + 1, origin: opened.origin, request: opened.request, resolution: "cancelled" });
    expect(loadState(f.core.database).requests[request.requestId].state).toBe("cancelled"); expect(choice(f.core, request.requestId).status).toBe("cancelled");
  });
  it("bounds long native identities on the wire and still dispatches to the original request", async () => {
    const f = await fixture(); const opened = f.observation("user_input"); opened.request.nativeId = "native-request-".repeat(30); const request = f.publish(opened);
    const choiceId = requestChoiceId(request.requestId); expect(choiceId.length).toBeLessThanOrEqual(128);
    expect(choice(f.core, choiceId)).toMatchObject({ choiceId, status: "pending" });
    await f.core.controlService.execute(principal, "session.choose", { commandId: answerId, sessionId: "manager", choiceId, answers }); await f.core.effectWorker.drain();
    expect(f.responses).toEqual([expect.objectContaining({ request: opened.request, response: answers })]);
  });
});
