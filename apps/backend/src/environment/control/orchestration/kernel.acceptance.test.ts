import { describe, expect, it } from "vitest";
import { decide, emptyState, evolve } from "./kernel.js";
import type { CoreCommand, CoreState, Decision } from "./types.js";
import { piProviderCapabilities } from "../../../swarm/runtime/pi/pi-provider-adapter.js";

const now = 1_800_000_000_000;
const caps = piProviderCapabilities();
function apply(state: CoreState, command: CoreCommand): { state: CoreState; decision: Decision } {
  const frozen = JSON.stringify(state);
  const decision = decide(state, command);
  expect(JSON.stringify(state)).toBe(frozen);
  return { state: decision.events.reduce(evolve, state), decision };
}
function fixture() {
  let state = emptyState();
  const run = (command: CoreCommand) => {
    const result = apply(state, command); state = result.state; return result.decision;
  };
  run({ type: "thread.create", commandId: "create", now, threadId: "manager", role: "manager", projectId: "project" });
  const submit = (id: string, delivery: "queue" | "steer" = "queue") => run({ type: "run.submit", commandId: id, now, threadId: "manager", inputId: `input-${id}`, runId: `run-${id}`, attemptId: `attempt-${id}`, bindingId: "binding", input: { text: id, artifactIds: [] }, delivery });
  const record = (id: string) => run({ type: "input.recorded", commandId: `record-${id}`, now, threadId: "manager", inputId: `input-${id}`, entryId: `entry-${id}` });
  const acquire = () => run({ type: "binding.acquired", commandId: "acquire", now, threadId: "manager", binding: { scope: { threadId: "manager", bindingId: "binding", generation: 0 }, conversation: { threadId: "manager", bindingId: "binding", generation: 0, kind: "conversation", nativeId: "native" }, capabilities: caps, instructionRevision: "prompt", toolContractRevision: "tools" } });
  const observe = (attemptId: string, sequence: number, type: "accepted" | "terminal", generation = 0, child = false) => run({ type: "provider.observe", commandId: `obs-${attemptId}-${sequence}-${generation}`, now,
    observation: { scope: { threadId: "manager", bindingId: "binding", generation }, attemptId, sequence,
      origin: child ? { kind: "child", conversation: { threadId: "manager", bindingId: "binding", generation, kind: "conversation", nativeId: "native" }, parentTurn: { threadId: "manager", bindingId: "binding", generation, kind: "turn", conversationId: "native", nativeId: "turn" } } : { kind: "root", conversation: { threadId: "manager", bindingId: "binding", generation, kind: "conversation", nativeId: "native" } },
      ...(type === "accepted" ? { type, turn: { threadId: "manager", bindingId: "binding", generation, kind: "turn", conversationId: "native", nativeId: "turn" } } : { type, outcome: "completed", terminalAuthority: child ? "native_child" : "root_attempt" }) } });
  const dispatch = (id: string, authorized = true) => run({ type: "attempt.dispatch", commandId: `dispatch-${id}`, now, threadId: "manager", attemptId: `attempt-${id}`, authorized });
  return { run, submit, record, acquire, observe, dispatch, state: () => state };
}

describe("authoritative run decisions", () => {
  it("chooses and retains the native creation scope before input admission", () => {
    const f=fixture();
    f.run({ type:"thread.prepare_binding",commandId:"prepare",now,threadId:"manager",bindingId:"prepared-binding" });
    const first=f.state().threads.manager;
    f.run({ type:"thread.prepare_binding",commandId:"prepare-again",now,threadId:"manager",bindingId:"ignored-binding" });
    expect(f.state().threads.manager).toEqual(first);
    expect(first.bindingId).toBe("prepared-binding");
  });

  it.each([false, true])("restarts canonical pre-dispatch work with acquired=%s and fences its old attempt", acquired => {
    const f = fixture(); f.submit("one"); f.record("one"); if (acquired) f.acquire();
    const oldAttempt = f.state().runs["run-one"].activeAttemptId;
    const reboot = f.run({ type: "environment.recover", commandId: "reboot", now, recoveryId: "reboot", bootId: "reboot", reports: [] });
    const run = f.state().runs["run-one"]; const owner = f.state().threads.manager;
    expect(owner.activeRunId).toBe(run.runId); expect(run.state).toBe("running"); expect(run.activeAttemptId).not.toBe(oldAttempt);
    expect(reboot.effects).toContainEqual({ kind: "runtime.acquire", threadId: "manager", bindingId: owner.bindingId, generation: owner.generation });
    expect(f.state().recovery).toBeNull();
    expect(f.run({ type: "attempt.dispatch", commandId: "stale-dispatch", now, threadId: "manager", attemptId: oldAttempt, authorized: true }).events).toEqual([]);
    expect(f.state().runs["run-one"].state).toBe("running");
  });

  it("queues accepted input behind the current root and advances only on its terminal", () => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one"); f.observe("attempt-one", 1, "accepted");
    const queued = f.submit("two"); f.record("two");
    expect(queued.effects.some(e => e.kind === "provider.start")).toBe(false);
    f.observe("attempt-one", 2, "terminal", 0, true);
    expect(f.state().runs["run-one"].state).toBe("running");
    const terminal = f.observe("attempt-one", 3, "terminal");
    expect(f.state().runs["run-one"].outcome).toBe("completed");
    expect(terminal.effects.map(e => e.kind)).toContain("provider.start");
  });
  it("steers canonical input into the active root without interruption or a second native start", () => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one"); f.observe("attempt-one", 1, "accepted");
    const submitted = f.submit("two", "steer"); const recorded = f.record("two");
    expect(submitted.effects).toEqual([{ kind: "transcript.append", threadId: "manager", inputId: "input-two", runId: "run-two" }]);
    expect(recorded.effects).toEqual([{ kind: "provider.steer", threadId: "manager", attemptId: "attempt-two", targetAttemptId: "attempt-one" }]);
    expect(f.state().threads.manager.activeRunId).toBe("run-one");
    f.run({ type: "attempt.dispatch", commandId: "steer-dispatch", now, threadId: "manager", attemptId: "attempt-two", targetAttemptId: "attempt-one", authorized: true });
    f.run({ type: "attempt.accepted", commandId: "steer-accepted", now, threadId: "manager", attemptId: "attempt-two", turn: f.state().attempts["attempt-one"].turn! });
    expect(f.state().runs["run-two"]).toMatchObject({ state: "terminal", outcome: "completed" });
    expect(f.state().runs["run-one"].state).toBe("running");
    expect(f.observe("attempt-one", 2, "terminal").effects).toEqual([]);
  });
  it("queues a steer when the root ends before native dispatch", () => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one"); f.observe("attempt-one", 1, "accepted");
    f.submit("two", "steer"); f.record("two"); f.observe("attempt-one", 2, "terminal");
    const decision = f.run({ type: "attempt.dispatch", commandId: "stale-steer", now, threadId: "manager", attemptId: "attempt-two", targetAttemptId: "attempt-one", authorized: true });
    expect(decision.effects).toEqual([{ kind: "provider.start", threadId: "manager", attemptId: "attempt-two" }]);
    expect(f.state().threads.manager.activeRunId).toBe("run-two");
    expect(f.state().attempts["attempt-two"].state).toBe("created");
  });
  it("a rejected steer fails its own input and keeps the root running", () => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one"); f.observe("attempt-one", 1, "accepted");
    f.submit("two", "steer"); f.record("two");
    f.run({ type: "effect.failed", commandId: "steer-failed", now, threadId: "manager", attemptId: "attempt-two", kind: "provider.steer", delivery: "not_dispatched" });
    expect(f.state().threads.manager.activeRunId).toBe("run-one"); expect(f.state().runs["run-one"].state).toBe("running");
    expect(f.state().runs["run-two"]).toMatchObject({ state: "terminal", outcome: "failed" });
  });
  it("keeps explicit steering queued when the provider cannot steer", () => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one"); f.observe("attempt-one", 1, "accepted");
    const state = f.state(); state.bindings.binding.capabilities = { ...caps, native: { ...caps.native, steer: false } };
    f.submit("two", "steer"); const recorded = f.record("two");
    expect(recorded.effects).toEqual([]); expect(f.state().runs["run-two"].state).toBe("queued");
    expect(f.observe("attempt-one", 2, "terminal").effects).toEqual([{ kind: "provider.start", threadId: "manager", attemptId: "attempt-two" }]);
  });
  it("ignores duplicate, out-of-order and old-generation observations", () => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one"); f.observe("attempt-one", 4, "accepted");
    expect(f.observe("attempt-one", 3, "terminal").events).toEqual([]);
    expect(f.observe("attempt-one", 4, "terminal").events).toEqual([]);
    expect(f.observe("attempt-one", 5, "terminal", 99).events).toEqual([]);
    expect(f.state().runs["run-one"].state).toBe("running");
  });
  it("quarantines unknown delivery in process until writer drain precedes explicit recovery", () => {
    const f=fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one");
    const decision=f.run({type:"attempt.unknown",commandId:"unknown",now,threadId:"manager",attemptId:"attempt-one"});
    expect(f.state().threads.manager.shutdown).toBe("pending");
    expect(decision.effects).toContainEqual({kind:"provider.release",threadId:"manager",bindingId:"binding"});
    const recoveryId=f.state().recovery!.recoveryId;
    const resume={type:"recovery.resume" as const,commandId:"resume",now,recoveryId,attempts:{"run-one":"retry"},bindingIds:{manager:"replacement"}};
    expect(()=>f.run(resume)).toThrow("confirmed writer shutdown");
    f.run({type:"binding.drained",commandId:"drain",now,threadId:"manager",bindingId:"binding",status:"clean"});
    expect(f.state().runs["run-one"].state).toBe("recovery");
    expect(f.state().threads.manager.generation).toBe(1);
    f.run(resume); expect(f.state().attempts.retry.generation).toBe(1);
  });
  it("holds newer canonical input behind unresolved in-process recovery", () => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one");
    f.run({ type: "attempt.unknown", commandId: "unknown", now, threadId: "manager", attemptId: "attempt-one" });
    f.run({ type: "binding.drained", commandId: "drain", now, threadId: "manager", bindingId: "binding", status: "clean" });
    f.submit("newer"); const queued = f.record("newer");
    expect(f.state().runs["run-newer"].state).toBe("queued"); expect(queued.effects).toEqual([]);
    f.run({ type: "recovery.resume", commandId: "resume", now, recoveryId: f.state().recovery!.recoveryId, attempts: { "run-one": "retry" }, bindingIds: { manager: "replacement" } });
    expect(f.state().threads.manager.activeRunId).toBe("run-one"); expect(f.state().runs["run-newer"].state).toBe("queued");
  });
  it("does not clear another active run when resuming a retained recovery run", () => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one");
    f.run({ type: "attempt.unknown", commandId: "unknown", now, threadId: "manager", attemptId: "attempt-one" });
    f.run({ type: "binding.drained", commandId: "drain", now, threadId: "manager", bindingId: "binding", status: "clean" });
    f.submit("newer"); f.record("newer");
    const state = f.state(); const owner = { ...state.threads.manager, activeRunId: "run-newer", bindingId: "newer-binding" };
    const live = { ...state, threads: { manager: owner }, runs: { ...state.runs, "run-newer": { ...state.runs["run-newer"], state: "running" as const } } };
    const result = apply(live, { type: "recovery.resume", commandId: "resume", now, recoveryId: state.recovery!.recoveryId, attempts: { "run-one": "retry" }, bindingIds: { manager: "replacement" } });
    expect(result.state.threads.manager).toEqual(owner); expect(result.state.runs["run-one"].state).toBe("queued"); expect(result.decision.effects).toEqual([]);
  });
  it("quarantines a pending drain and permits no replacement writer until confirmed clean", () => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one");
    f.run({ type: "thread.stop", commandId: "stop", now, threadId: "manager" });
    f.run({ type: "binding.drained", commandId: "pending", now, threadId: "manager", bindingId: "binding", status: "pending" });
    expect(() => f.run({ type: "thread.resume", commandId: "resume", now, threadId: "manager" })).toThrow(/shutdown/i);
    f.run({ type: "binding.drained", commandId: "clean", now, threadId: "manager", bindingId: "binding", status: "clean" });
    f.run({ type: "thread.resume", commandId: "resume", now, threadId: "manager" });
    expect(f.state().threads.manager.generation).toBe(1);
  });
  it.each([
    ["the provider acknowledges the stop's interrupt first", "interrupted", "cancelled"],
    ["the provider says nothing before the drain", null, "cancelled"],
    ["the turn finished on its own before the drain", "completed", "completed"],
  ] as const)("a user Stop settles its run the same way whether %s", (_name, reported, outcome) => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one"); f.observe("attempt-one", 0, "accepted");
    f.run({ type: "thread.stop", commandId: "stop", now, threadId: "manager" });
    const conversation = { threadId: "manager", bindingId: "binding", generation: 0, kind: "conversation" as const, nativeId: "native" };
    if (reported) f.run({ type: "provider.observe", commandId: "obs-terminal", now, observation: { scope: { threadId: "manager", bindingId: "binding", generation: 0 }, attemptId: "attempt-one", sequence: 1,
      origin: { kind: "root", conversation }, type: "terminal", outcome: reported, terminalAuthority: "root_attempt" } });
    f.run({ type: "binding.drained", commandId: "clean", now, threadId: "manager", bindingId: "binding", status: "clean" });
    expect(f.state().runs["run-one"]).toMatchObject({ state: "terminal", outcome });
    expect(f.state().threads.manager).toMatchObject({ desired: "stopped", shutdown: "clean" }); expect(f.state().threads.manager.activeRunId).toBeUndefined();
  });
  it("keeps a provider's own interruption distinct from a user Stop", () => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one"); f.observe("attempt-one", 0, "accepted");
    const conversation = { threadId: "manager", bindingId: "binding", generation: 0, kind: "conversation" as const, nativeId: "native" };
    f.run({ type: "provider.observe", commandId: "obs-terminal", now, observation: { scope: { threadId: "manager", bindingId: "binding", generation: 0 }, attemptId: "attempt-one", sequence: 1,
      origin: { kind: "root", conversation }, type: "terminal", outcome: "interrupted", terminalAuthority: "root_attempt" } });
    expect(f.state().runs["run-one"]).toMatchObject({ state: "terminal", outcome: "interrupted" });
  });
  it.each(["pending", "quarantined"] as const)("settles a stopped thread's stuck run at the process boundary when its drain was %s", shutdown => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one"); f.observe("attempt-one", 0, "accepted");
    f.run({ type: "thread.stop", commandId: "stop", now, threadId: "manager" });
    if (shutdown === "quarantined") f.run({ type: "binding.drained", commandId: "unconfirmed", now, threadId: "manager", bindingId: "binding", status: "pending" });
    expect(f.state().threads.manager).toMatchObject({ desired: "stopped", shutdown, activeRunId: "run-one" });
    f.run({ type: "environment.recover", commandId: "boot", now, recoveryId: "boot", bootId: "boot", reports: [] });
    // The user's stop was already recorded; a restart is not a second decision for them to make.
    expect(f.state().threads.manager).toMatchObject({ desired: "stopped", shutdown: "clean" }); expect(f.state().threads.manager.activeRunId).toBeUndefined();
    expect(f.state().runs["run-one"]).toMatchObject({ state: "terminal", outcome: "cancelled" }); expect(f.state().recovery).toBeNull();
    f.run({ type: "thread.resume", commandId: "resume", now, threadId: "manager" });
    f.submit("two"); const started = f.record("two");
    expect(f.state().threads.manager.activeRunId).toBe("run-two"); expect(started.effects.map(effect => effect.kind)).toEqual(["runtime.acquire"]);
  });
  it("admits canonical input during a switch drain and advances it in the replacement scope", () => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one"); f.observe("attempt-one", 1, "terminal");
    const state = f.state(); const pending = { ...state, threads: { manager: { ...state.threads.manager, shutdown: "pending" as const } } };
    const admitted = apply(pending, { type: "run.submit", commandId: "during-drain", now, threadId: "manager", runId: "queued", inputId: "queued-input", attemptId: "queued-attempt", bindingId: "ignored", input: { text: "queued", artifactIds: [] }, delivery: "queue" });
    const recorded = apply(admitted.state, { type: "input.recorded", commandId: "record-queued", now, threadId: "manager", inputId: "queued-input", entryId: "queued-entry" });
    expect(recorded.state.runs.queued.state).toBe("queued"); expect(recorded.decision.effects).toEqual([]);
    const drained = apply(recorded.state, { type: "binding.drained", commandId: "switch-drained", now, threadId: "manager", bindingId: "binding", status: "clean" });
    expect(drained.state.threads.manager.activeRunId).toBe("queued"); expect(drained.state.runs.queued.state).toBe("running");
    const attempt = drained.state.attempts[drained.state.runs.queued.activeAttemptId]; expect(attempt.generation).toBe(1); expect(attempt.bindingId).not.toBe("binding");
    expect(drained.decision.effects).toContainEqual({ kind: "runtime.acquire", threadId: "manager", bindingId: attempt.bindingId, generation: 1 });
  });
  it("rechecks revocation immediately before provider dispatch", () => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire();
    expect(f.dispatch("one", false).effects.some(e => e.kind === "provider.start")).toBe(false);
    expect(f.state().runs["run-one"].outcome).toBe("cancelled");
  });
  it("expires approvals at response and never answers callbacks from an earlier boot", () => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one");
    f.run({ type: "provider.observe", commandId: "approval", now, observation: { type: "request_opened", sequence: 1, attemptId: "attempt-one", scope: { threadId: "manager", bindingId: "binding", generation: 0 }, origin: { kind: "root", conversation: { kind: "conversation", threadId: "manager", bindingId: "binding", generation: 0, nativeId: "native" } }, request: { kind: "request", threadId: "manager", bindingId: "binding", generation: 0, conversationId: "native", nativeId: "approval" }, requestKind: "approval", lifetime: { kind: "live_callback", generation: 0, expiresAt: new Date(now).toISOString() }, payload: {} } });
    const decision = f.run({ type: "request.respond", commandId: "answer", now: now + 1, threadId: "manager", requestId: "binding:0:approval", response: true });
    expect(decision.effects).toEqual([]);
    expect(f.state().requests["binding:0:approval"].state).toBe("expired");
  });
  it("keeps unknown delivery through repeated crashes and resumes explicitly with a new attempt", () => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one");
    const crash = (id: string, reports: { deliveryId: string; fromAgentId: string; toAgentId: string }[] = []) => f.run({ type: "environment.recover", commandId: id, now, recoveryId: id, bootId: id, reports });
    crash("boot-two", [{ deliveryId: "result-one", fromAgentId: "worker", toAgentId: "manager" }]);
    const id = f.state().recovery!.recoveryId;
    crash("boot-three", [{ deliveryId: "result-two", fromAgentId: "worker", toAgentId: "manager" }]);
    expect(f.state().recovery!.recoveryId).toBe(id);
    expect(f.state().recovery!.undeliveredReports.map(r => r.deliveryId)).toEqual(["result-one", "result-two"]);
    expect(f.state().attempts["attempt-one"].delivery).toBe("unknown");
    expect(f.state().threads.manager.shutdown).toBe("clean");
    f.run({ type: "recovery.resume", commandId: "explicit-resume", now, recoveryId: id, attempts: { "run-one": "attempt-recovered" }, bindingIds: { manager: "new-binding" } });
    expect(f.state().runs["run-one"].activeAttemptId).toBe("attempt-recovered");
    expect(f.state().attempts["attempt-one"].delivery).toBe("unknown");
  });
  it("terminalizes known provider errors and serializes compaction with goal continuation", () => {
    const f = fixture(); f.submit("one"); f.record("one"); f.acquire(); f.dispatch("one");
    f.run({ type: "provider.observe", commandId: "error", now, observation: { type: "error", sequence: 1, attemptId: "attempt-one", scope: { threadId: "manager", bindingId: "binding", generation: 0 }, origin: { kind: "root", conversation: { kind: "conversation", threadId: "manager", bindingId: "binding", generation: 0, nativeId: "native" } }, code: "TRANSPORT", message: "fixture", delivery: "not_dispatched" } });
    expect(f.state().runs["run-one"].outcome).toBe("failed");
    f.run({ type: "thread.compact", commandId: "compact", now, threadId: "manager", attemptId: "compaction" });
    f.submit("goal"); f.record("goal");
    expect(f.state().runs["run-goal"].state).toBe("queued");
    const done = f.run({ type: "compaction.completed", commandId: "compacted", now, threadId: "manager", attemptId: "compaction", succeeded: true });
    expect(done.effects.map(e => e.kind)).toContain("provider.start");
  });
});
