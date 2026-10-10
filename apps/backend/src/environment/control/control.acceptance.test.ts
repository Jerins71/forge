import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectSummary, RpcInput } from "@forge/protocol/environment-v2";
import { executeStreamDeckAction } from "../../ws/http/routes/stream-deck-routes.js";
import { createControlCore } from "./database.js";
import type { SwarmControlPort, Principal } from "./control-types.js";
import type { ControlCoreOptions, WorkspacePort } from "./effect-types.js";

const COMMAND = "00000000-0000-4000-8000-000000000001";
const STOP = "00000000-0000-4000-8000-000000000002";
const SEND = "00000000-0000-4000-8000-000000000003";
const principal: Principal = { deviceSessionId: "device-a", scopes: new Set(["session:operate", "workspace:write"]) };
const launch: RpcInput<"session.launch"> = {
  commandId: COMMAND,
  projectId: "project",
  title: "Test",
  workspaceStrategy: { kind: "current_checkout" },
  initialMessage: { text: "synthetic input", artifactIds: [] },
};
const project: ProjectSummary = {
  projectId: "project",
  title: "Project",
  cwd: "/fixture",
  repository: null,
  isGit: false,
  defaultBranch: null,
  updatedAt: "2026-10-04T00:00:00.000Z",
  sortKey: "project",
  archived: false,
};
const roots: string[] = [];
const cores: Awaited<ReturnType<typeof createControlCore>>[] = [];
afterEach(async () => {
  for (const core of cores.splice(0)) await core.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(overrides: Partial<SwarmControlPort> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-control-"));
  roots.push(root);
  const databasePath = path.join(root, "control.sqlite");
  let serial = 0;
  let revoked = false;
  let preflightCount = 0;
  let dispatchCount = 0;
  let materialized = 0;
  let stops = 0;
  const canonical = new Map<string, string>();
  const workspace: WorkspacePort = {
    async prepareLaunch(input) {
      preflightCount++;
      return {
        project,
        revision: "1",
        cwd: project.cwd,
        model: input.model,
        reservation: {
          reservationId: input.commandId,
          repositoryRoot: "/fixture",
          repositoryCommonDir: "/fixture/.git",
          kind: input.workspaceStrategy.kind,
          path: "/fixture",
          pathKey: "/fixture",
          branch: null,
          baseCommit: null,
          owned: false,
        },
      };
    },
    isLaunchCurrent: () => true,
    async ensure() {
      return { cwd: "/fixture", branch: null };
    },
    async reconcile() {
      return "retry";
    },
  };
  const swarm: SwarmControlPort = {
    async ensureSession() {
      materialized++;
      return { materialized: true };
    },
    async applyInput(input) {
      if (!canonical.has(input.inputId)) canonical.set(input.inputId, "entry-" + input.inputId);
      await input.onCanonicalAppend(canonical.get(input.inputId)!);
      if ((await input.beforeDispatch()) === "do-not-dispatch") return { delivery: "unknown" };
      dispatchCount++;
      await input.onDispatchAccepted();
      return { delivery: "dispatched" };
    },
    async applyChoice() {
      return "answered";
    },
    async stopSession() {
      stops++;
      return { stopped: true };
    },
    ...overrides,
  };
  const options: ControlCoreOptions = {
    databasePath,
    clock: () => Date.parse("2026-10-04T00:00:00.000Z"),
    random: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`,
    swarm,
    workspace,
    artifacts: {
      validateInput() {
        return [];
      },
      pinInput() {},
    },
    isDeviceRevoked: () => revoked,
  };
  const open = async () => {
    const core = await createControlCore(options);
    cores.push(core);
    return core;
  };
  return {
    core: await open(),
    open,
    swarm,
    workspace,
    options,
    canonical,
    revoke() {
      revoked = true;
    },
    counts: () => ({ preflightCount, dispatchCount, materialized, stops, canonical: canonical.size }),
  };
}
function count(core: Awaited<ReturnType<typeof createControlCore>>, table: string) {
  return (core.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe("durable control acceptance on real SQLite", () => {
  it("rolls back acceptance before COMMIT without publishing or executing anything", async () => {
    const f = await fixture();
    const published: number[] = [];
    f.core.eventSink.subscribe((event) => published.push(event.sequence));
    f.core.database.exec(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END",
    );
    await expect(f.core.controlService.execute(principal, "session.launch", launch)).rejects.toThrow("fixture rollback");
    for (const table of ["commands", "effects", "control_sessions", "workspace_reservations", "control_inputs", "events"]) {
      expect(count(f.core, table)).toBe(0);
    }
    expect(f.core.eventSink.highWater).toBe(0);
    expect(published).toEqual([]);
    expect(f.counts().dispatchCount).toBe(0);
    f.core.database.exec("DROP TRIGGER fail_receipt");
    await f.core.controlService.execute(principal, "session.launch", launch);
    expect(count(f.core, "commands")).toBe(1);
  });

  it("deduplicates lost acknowledgments before preflight and rejects changed body/principal", async () => {
    const f = await fixture();
    const receipt = await f.core.controlService.execute(principal, "session.launch", launch);
    const events = count(f.core, "events");
    expect(await f.core.controlService.execute(principal, "session.launch", launch)).toEqual(receipt);
    expect(f.counts().preflightCount).toBe(1);
    for (const table of ["commands", "control_sessions", "workspace_reservations", "control_inputs"]) expect(count(f.core, table)).toBe(1);
    expect(count(f.core, "effects")).toBe(3);
    expect(count(f.core, "events")).toBe(events);
    await expect(f.core.controlService.execute(principal, "session.launch", { ...launch, title: "changed" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      f.core.controlService.execute({ ...principal, deviceSessionId: "device-b" }, "session.launch", launch),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(f.core.controlService.getReceipt({ ...principal, deviceSessionId: "device-b" }, COMMAND)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await f.core.effectWorker.drain();
    expect(f.counts()).toMatchObject({ dispatchCount: 1, materialized: 1, canonical: 1 });
    expect((await f.core.controlService.execute(principal, "session.launch", launch)).state).toBe("succeeded");
  });

  it("publishes actual receipt sequences after commit and preserves order during listener reentry", async () => {
    const f = await fixture();
    const published: number[] = [];
    let reentered = false;
    f.core.eventSink.subscribe((event) => {
      expect(f.core.database.inTransaction).toBe(false);
      expect(f.core.database.prepare("SELECT sequence FROM events WHERE sequence = ?").get(event.sequence)).toBeDefined();
      published.push(event.sequence);
      if (!reentered) {
        reentered = true;
        f.core.eventSink.transaction((tx) =>
          f.core.eventSink.append(tx, {
            topic: "shell",
            sessionId: null,
            event: { type: "project.upsert", project },
          }),
        );
      }
    });
    const receipt = await f.core.controlService.execute(principal, "session.launch", launch);
    const row = f.core.database.prepare("SELECT sequence, payload_json FROM events WHERE event_type = 'receipt.upsert'").get() as {
      sequence: number;
      payload_json: string;
    };
    expect(receipt.acceptedSequence).toBe(row.sequence);
    expect(receipt.updatedSequence).toBe(row.sequence);
    expect(JSON.parse(row.payload_json).receipt).toEqual(receipt);
    expect(published).toEqual([...published].sort((a, b) => a - b));
    expect(new Set(published).size).toBe(published.length);
  });

  it("preserves epoch/high water and reconciles a claimed identity-safe effect after reopen", async () => {
    const f = await fixture();
    await f.core.controlService.execute(principal, "session.launch", launch);
    const epoch = f.core.eventSink.streamEpoch;
    const highWater = f.core.eventSink.highWater;
    f.core.database.prepare("UPDATE effects SET state = 'claimed', claimed_boot_id = 'dead-boot', attempt = 1 WHERE ordinal = 0").run();
    await f.core.close();
    const reopened = await f.open();
    expect(reopened.eventSink.streamEpoch).toBe(epoch);
    expect(reopened.eventSink.highWater).toBe(highWater);
    await reopened.reconcileOnBoot();
    await reopened.effectWorker.drain();
    expect((await reopened.controlService.getReceipt(principal, COMMAND)).state).toBe("succeeded");
    expect(f.counts().dispatchCount).toBe(1);
    const row = reopened.database.prepare("SELECT attempt, claimed_boot_id FROM effects WHERE ordinal = 0").get() as {
      attempt: number;
      claimed_boot_id: string;
    };
    expect(row.attempt).toBe(2);
    expect(row.claimed_boot_id).not.toBe("dead-boot");
  });

  it("never re-dispatches an ambiguous provider handoff on restart or retry", async () => {
    let calls = 0;
    const f = await fixture({
      async applyInput(input) {
        calls++;
        await input.onCanonicalAppend("stable-entry");
        expect(await input.beforeDispatch()).toBe("dispatch");
        throw new Error("provider transport broke after marker");
      },
    });
    await f.core.controlService.execute(principal, "session.launch", launch);
    await f.core.effectWorker.drain();
    expect(await f.core.controlService.getReceipt(principal, COMMAND)).toMatchObject({ state: "interrupted", delivery: "unknown" });
    const epoch = f.core.eventSink.streamEpoch;
    await f.core.close();
    const reopened = await f.open();
    await reopened.reconcileOnBoot();
    await reopened.effectWorker.drain();
    expect(await reopened.controlService.execute(principal, "session.launch", launch)).toMatchObject({
      state: "interrupted",
      delivery: "unknown",
    });
    expect(reopened.eventSink.streamEpoch).toBe(epoch);
    expect(calls).toBe(1);
  });

  it("reconciles a dead claimed dispatch marker to unknown without executing the input", async () => {
    const f = await fixture();
    await f.core.controlService.execute(principal, "session.launch", launch);
    f.core.database.prepare("UPDATE effects SET state = 'done' WHERE ordinal < 2").run();
    f.core.database.prepare("UPDATE effects SET state = 'claimed', claimed_boot_id = 'dead' WHERE ordinal = 2").run();
    f.core.database
      .prepare("UPDATE control_inputs SET append_state = 'recorded', canonical_entry_id = 'persisted', delivery_state = 'dispatching'")
      .run();
    await f.core.close();
    const reopened = await f.open();
    await reopened.reconcileOnBoot();
    await reopened.effectWorker.drain();
    expect(await reopened.controlService.getReceipt(principal, COMMAND)).toMatchObject({ state: "interrupted", delivery: "unknown" });
    expect(f.counts().dispatchCount).toBe(0);
  });

  it("fences a claimed older input when stop is accepted and recovers stopped sends explicitly", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let crossed = false;
    const f = await fixture({
      async applyInput(input) {
        await input.onCanonicalAppend("persisted");
        entered.resolve();
        await release.promise;
        crossed = (await input.beforeDispatch()) === "dispatch";
        if (crossed) await input.onDispatchAccepted();
        return { delivery: crossed ? "dispatched" : "unknown" };
      },
    });
    await f.core.controlService.execute(principal, "session.launch", launch);
    const draining = f.core.effectWorker.drain();
    await entered.promise;
    await f.core.controlService.execute(principal, "session.stop", { commandId: STOP, sessionId: "v2-" + COMMAND });
    await expect(
      f.core.controlService.execute(principal, "session.send", {
        commandId: SEND,
        sessionId: "v2-" + COMMAND,
        message: { text: "later", artifactIds: [] },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    release.resolve();
    await draining;
    expect(crossed).toBe(false);
    expect(await f.core.controlService.getReceipt(principal, STOP)).toMatchObject({ state: "succeeded" });
    expect(await f.core.controlService.getReceipt(principal, COMMAND)).toMatchObject({ state: "interrupted", delivery: "none" });
    await f.core.controlService.execute(principal, "session.send", {
      commandId: SEND,
      sessionId: "v2-" + COMMAND,
      message: { text: "explicit recovery", artifactIds: [] },
    });
    expect(
      (f.core.database.prepare("SELECT run_generation FROM control_sessions").get() as { run_generation: number }).run_generation,
    ).toBe(2);
  });

  it("cancels revoked unclaimed effects and retains an unmaterialized stopped reservation", async () => {
    const f = await fixture();
    await f.core.controlService.execute(principal, "session.launch", launch);
    f.revoke();
    await f.core.effectWorker.drain();
    expect(f.counts()).toMatchObject({ materialized: 0, dispatchCount: 0 });
    expect(await f.core.controlService.getReceipt(principal, COMMAND)).toMatchObject({ state: "interrupted", delivery: "none" });
    expect(count(f.core, "workspace_reservations")).toBe(1);
    await expect(
      f.core.controlService.execute(principal, "session.stop", { commandId: STOP, sessionId: "v2-" + COMMAND }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("runs at most four sessions concurrently and excludes a second effect for an active session", async () => {
    const f = await fixture();
    const release = deferred<void>();
    const fourEntered = deferred<void>();
    const sessions = new Set<string>();
    let maximum = 0;
    let active = 0;
    f.swarm.ensureSession = async (input) => {
      expect(sessions.has(input.sessionId)).toBe(false);
      sessions.add(input.sessionId);
      active++;
      maximum = Math.max(maximum, active);
      if (active === 4) fourEntered.resolve();
      await release.promise;
      active--;
      sessions.delete(input.sessionId);
      return { materialized: true };
    };
    for (let n = 1; n <= 5; n++)
      await f.core.controlService.execute(principal, "session.launch", {
        ...launch,
        commandId: `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
      });
    const draining = f.core.effectWorker.drain();
    await fourEntered.promise;
    expect(maximum).toBe(4);
    expect(count(f.core, "control_inputs")).toBe(5);
    expect(f.counts().dispatchCount).toBe(0);
    release.resolve();
    await draining;
    expect(f.counts().dispatchCount).toBe(5);
    expect(f.core.database.prepare("SELECT effect_id FROM effects WHERE state != 'done'").all()).toEqual([]);
  });

  it("reconciles a canonical append whose locator transaction was lost without duplicating input", async () => {
    const f = await fixture();
    await f.core.controlService.execute(principal, "session.launch", launch);
    f.core.database.prepare("UPDATE effects SET state = 'done' WHERE ordinal < 2").run();
    f.core.database.prepare("UPDATE effects SET state = 'claimed', claimed_boot_id = 'dead' WHERE ordinal = 2").run();
    f.canonical.set("input-" + COMMAND, "already-persisted-in-jsonl");
    await f.core.close();
    const reopened = await f.open();
    await reopened.reconcileOnBoot();
    await reopened.effectWorker.drain();
    expect(f.counts()).toMatchObject({ canonical: 1, dispatchCount: 1 });
    expect(reopened.database.prepare("SELECT canonical_entry_id, append_state FROM control_inputs").get()).toMatchObject({
      canonical_entry_id: "already-persisted-in-jsonl",
      append_state: "recorded",
    });
  });

  it("reserves one valid choice answer and interrupts old continuations on restart", async () => {
    const f = await fixture();
    const sessionId = "v2-" + COMMAND;
    await f.core.controlService.execute(principal, "session.launch", { ...launch, initialMessage: undefined });
    await f.core.effectWorker.drain();
    const choice = {
      choiceId: "choice",
      agentId: sessionId,
      status: "pending" as const,
      questions: [{ id: "q", question: "Pick", options: [{ id: "yes", label: "Yes" }] }],
    };
    f.core.eventSink.transaction((tx) => {
      f.core.database
        .prepare("INSERT INTO control_choices VALUES (?, ?, ?, ?, ?, NULL, 0)")
        .run("choice", sessionId, "old-runtime", "pending", JSON.stringify(choice));
      f.core.eventSink.append(tx, { topic: "detail", sessionId, event: { type: "choice.upsert", choice } });
    });
    const answer = { commandId: SEND, sessionId, choiceId: "choice", answers: [{ questionId: "q", selectedOptionIds: ["yes"] }] };
    const receipt = await f.core.controlService.execute(principal, "session.choose", answer);
    expect(await f.core.controlService.execute(principal, "session.choose", answer)).toEqual(receipt);
    await expect(f.core.controlService.execute(principal, "session.choose", { ...answer, commandId: STOP })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await f.core.close();
    const reopened = await f.open();
    await reopened.reconcileOnBoot();
    await reopened.effectWorker.drain();
    expect(await reopened.controlService.getReceipt(principal, SEND)).toMatchObject({ state: "interrupted" });
    expect(reopened.database.prepare("SELECT state FROM control_choices").get()).toMatchObject({ state: "interrupted" });
  });

  it("stops an unmaterialized launch without a swarm call and retains its reservation", async () => {
    const f = await fixture();
    const sessionId = "v2-" + COMMAND;
    await f.core.controlService.execute(principal, "session.launch", launch);
    await f.core.controlService.execute(principal, "session.stop", { commandId: STOP, sessionId });
    await f.core.effectWorker.drain();
    expect(f.counts()).toMatchObject({ stops: 0, materialized: 0, dispatchCount: 0 });
    expect(await f.core.controlService.getReceipt(principal, STOP)).toMatchObject({ state: "succeeded" });
    expect(count(f.core, "workspace_reservations")).toBe(1);
  });

  it("keeps unsafe shutdown in stopping state and prevents another writer", async () => {
    const f = await fixture({
      async stopSession() {
        return { stopped: false };
      },
    });
    const sessionId = "v2-" + COMMAND;
    await f.core.controlService.execute(principal, "session.launch", launch);
    await f.core.effectWorker.drain();
    await f.core.controlService.execute(principal, "session.stop", { commandId: STOP, sessionId });
    await f.core.effectWorker.drain();
    expect(await f.core.controlService.getReceipt(principal, STOP)).toMatchObject({ state: "interrupted" });
    await expect(
      f.core.controlService.execute(principal, "session.send", {
        commandId: SEND,
        sessionId,
        message: { text: "blocked", artifactIds: [] },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rechecks profile revision and validates and pins artifacts within acceptance", async () => {
    const f = await fixture();
    let revisions = 0;
    f.workspace.isLaunchCurrent = () => ++revisions > 1;
    f.options.artifacts.validateInput = () => {
      expect(f.core.database.inTransaction).toBe(true);
      return [];
    };
    f.options.artifacts.pinInput = (inputId) => {
      expect(f.core.database.inTransaction).toBe(true);
      expect(f.core.database.prepare("SELECT input_id FROM control_inputs WHERE input_id = ?").get(inputId)).toBeDefined();
    };
    await f.core.controlService.execute(principal, "session.launch", launch);
    expect(f.counts().preflightCount).toBe(2);
    expect(count(f.core, "commands")).toBe(1);
    expect(count(f.core, "effects")).toBe(3);
  });

  it("keeps epoch/high water and command knowledge after journal prefix retention", async () => {
    const f = await fixture();
    const receipt = await f.core.controlService.execute(principal, "session.launch", launch);
    const highWater = f.core.eventSink.highWater;
    f.core.database.prepare("UPDATE events SET created_at = 0").run();
    f.core.eventSink.prune();
    expect(count(f.core, "events")).toBe(0);
    expect(f.core.eventSink.highWater).toBe(highWater);
    await f.core.close();
    const reopened = await f.open();
    expect(reopened.eventSink.highWater).toBe(highWater);
    expect(await reopened.controlService.execute(principal, "session.launch", launch)).toEqual(receipt);
    const sequence = reopened.eventSink.transaction((tx) =>
      reopened.eventSink.append(tx, { topic: "shell", sessionId: null, event: { type: "project.upsert", project } }),
    );
    expect(sequence).toBeGreaterThan(highWater);
  });

  it("keeps already dispatched work running when a revoked device loses another pending send", async () => {
    const f = await fixture();
    const sessionId = "v2-" + COMMAND;
    await f.core.controlService.execute(principal, "session.launch", launch);
    await f.core.effectWorker.drain();
    await f.core.controlService.execute(principal, "session.send", {
      commandId: SEND,
      sessionId,
      message: { text: "queued", artifactIds: [] },
    });
    f.revoke();
    await f.core.effectWorker.drain();
    expect(f.counts().dispatchCount).toBe(1);
    expect(await f.core.controlService.getReceipt(principal, COMMAND)).toMatchObject({ state: "succeeded", delivery: "dispatched" });
    expect(await f.core.controlService.getReceipt(principal, SEND)).toMatchObject({ state: "interrupted", delivery: "none" });
    expect(
      JSON.parse((f.core.database.prepare("SELECT summary_json FROM control_sessions").get() as { summary_json: string }).summary_json)
        .status,
    ).toBe("running");
  });

  it("requires lifecycle shutdown after an attempted ensure that may have materialized before failing", async () => {
    let attempts = 0;
    let stops = 0;
    const f = await fixture({
      async ensureSession() {
        attempts++;
        throw new Error("meta persisted before process failed");
      },
      async stopSession() {
        stops++;
        return { stopped: true };
      },
    });
    await f.core.controlService.execute(principal, "session.launch", launch);
    await f.core.effectWorker.drain();
    await f.core.controlService.execute(principal, "session.stop", { commandId: STOP, sessionId: "v2-" + COMMAND });
    await f.core.effectWorker.drain();
    expect(attempts).toBe(1);
    expect(stops).toBe(1);
    expect(await f.core.controlService.getReceipt(principal, STOP)).toMatchObject({ state: "succeeded" });
  });

  it("rejects unavailable initial-input routes before durable launch acceptance", async () => {
    const f = await fixture();
    const error = { code: "UNAVAILABLE" as const, message: "Input route has no dispatch marker", retryable: false };
    f.options.inputRoute = {
      async preflight(input) {
        expect(f.core.database.inTransaction).toBe(false);
        expect(input).toEqual({ projectId: launch.projectId, message: launch.initialMessage });
        return { ok: false, error };
      },
    };
    await expect(f.core.controlService.execute(principal, "session.launch", launch)).rejects.toMatchObject(error);
    for (const table of ["commands", "control_sessions", "workspace_reservations", "control_inputs", "effects", "events"])
      expect(count(f.core, table)).toBe(0);
    expect(f.core.eventSink.highWater).toBe(0);
    expect(f.counts()).toMatchObject({ preflightCount: 0, materialized: 0, dispatchCount: 0 });
  });

  it("checks new sends outside acceptance and keeps deduplicated receipts when routing changes", async () => {
    const f = await fixture();
    const sessionId = "v2-" + COMMAND;
    await f.core.controlService.execute(principal, "session.launch", launch);
    let available = true;
    let calls = 0;
    const error = { code: "UNAVAILABLE" as const, message: "Input route unavailable", retryable: true, retryAfterMs: 250 };
    f.options.inputRoute = {
      async preflight(input) {
        calls++;
        expect(f.core.database.inTransaction).toBe(false);
        expect(input).toEqual({ sessionId, message: { text: "next", artifactIds: [] } });
        return available ? { ok: true } : { ok: false, error };
      },
    };
    const input = { commandId: SEND, sessionId, message: { text: "next", artifactIds: [] } };
    const receipt = await f.core.controlService.execute(principal, "session.send", input);
    available = false;
    expect(await f.core.controlService.execute(principal, "session.send", input)).toEqual(receipt);
    expect(calls).toBe(1);
    const eventCount = count(f.core, "events");
    await expect(f.core.controlService.execute(principal, "session.send", { ...input, commandId: STOP })).rejects.toMatchObject(error);
    expect(count(f.core, "commands")).toBe(2);
    expect(count(f.core, "control_inputs")).toBe(2);
    expect(count(f.core, "effects")).toBe(4);
    expect(count(f.core, "events")).toBe(eventCount);
    expect(calls).toBe(2);
  });
});

it("resumes stopped control state under the writer barrier, preserves input identity and fences failed/revoked resumes", async () => {
  const f = await fixture();
  const service = f.core.controlService;
  const receipt = await service.execute(principal, "session.launch", launch);
  await f.core.effectWorker.drain();
  await service.execute(principal, "session.stop", { commandId: STOP, sessionId: receipt.sessionId! });
  await f.core.effectWorker.drain();
  const before = f.core.database
    .prepare("SELECT desired_state,run_generation FROM control_sessions WHERE session_id=?")
    .get(receipt.sessionId!) as { desired_state: string; run_generation: number };
  expect(before.desired_state).toBe("stopped");
  const inputCount = count(f.core, "control_inputs");
  await expect(
    service.admitLifecycle!(principal, { commandId: "10000000-0000-4000-8000-000000000001", command: "resume_session", sessionIds: [receipt.sessionId!], intent: "resume", request: {} }, async () => {
      throw new Error("unsafe writer");
    }),
  ).rejects.toThrow("unsafe writer");
  expect(
    (
      f.core.database.prepare("SELECT desired_state FROM control_sessions WHERE session_id=?").get(receipt.sessionId!) as {
        desired_state: string;
      }
    ).desired_state,
  ).toBe("stopped");
  await service.execute(principal, "session.stop", { commandId: "10000000-0000-4000-8000-000000000003", sessionId: receipt.sessionId! });
  await f.core.effectWorker.drain();
  await service.admitLifecycle!(principal, { commandId: "10000000-0000-4000-8000-000000000002", command: "resume_session", sessionIds: [receipt.sessionId!], intent: "resume", request: {} }, async () => {
    expect(f.core.database.inTransaction).toBe(false);
    const state = f.core.database
      .prepare("SELECT desired_state,run_generation FROM control_sessions WHERE session_id=?")
      .get(receipt.sessionId!) as { desired_state: string; run_generation: number };
    expect(state.desired_state).toBe("running");
    expect(state.run_generation).toBeGreaterThan(before.run_generation);
  });
  expect(count(f.core, "control_inputs")).toBe(inputCount);
  expect(f.counts().dispatchCount).toBe(1);
  await service.execute(principal, "session.send", {
    commandId: SEND,
    sessionId: receipt.sessionId!,
    message: { text: "after resume", artifactIds: [] },
  });
  await f.core.effectWorker.drain();
  expect(f.counts().dispatchCount).toBe(2);
  await f.core.close();
  const restarted = await f.open();
  expect(
    (
      restarted.database.prepare("SELECT desired_state FROM control_sessions WHERE session_id=?").get(receipt.sessionId!) as {
        desired_state: string;
      }
    ).desired_state,
  ).toBe("running");
  f.revoke();
  await expect(
    restarted.controlService.admitLifecycle!(principal, { commandId: "10000000-0000-4000-8000-000000000004", command: "resume_session", sessionIds: [receipt.sessionId!], intent: "resume", request: {} }, async () => {
      throw new Error("must not run");
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

// Regression cases are written before implementing lifecycle admission.
describe("lifecycle command admission", () => {
  it.each(["clear_session", "delete_session", "archive_session", "stop_all_agents"])("%s fences a claimed send before touching session state", async command => {
    const entered = deferred<void>(); const release = deferred<void>();
    let dispatched = false; let mutated = false;
    const f = await fixture({ async applyInput(input) {
      await input.onCanonicalAppend("saved"); entered.resolve(); await release.promise;
      dispatched = await input.beforeDispatch() === "dispatch";
      if (dispatched) await input.onDispatchAccepted();
      return { delivery: dispatched ? "dispatched" : "unknown" };
    } });
    await f.core.controlService.execute(principal, "session.launch", launch);
    const drain = f.core.effectWorker.drain(); await entered.promise;
    const mutation = Promise.resolve().then(() => f.core.controlService.admitLifecycle!(principal, {
      commandId: STOP, command, sessionIds: ["v2-" + COMMAND], intent: "stop", request: { command },
    }, async () => { mutated = true; return { completed: true }; }));
    // Attach before releasing the held effect so failure cannot strand teardown.
    const outcome = mutation.then(value => ({ value }), error => ({ error }));
    await Promise.resolve(); expect(mutated).toBe(false);
    const send = f.core.controlService.execute(principal, "session.send", {
      commandId: SEND, sessionId: "v2-" + COMMAND, message: { text: "racing", artifactIds: [] },
    });
    const sendOutcome = send.then(value => ({ value }), error => ({ error }));
    release.resolve(); await drain;
    expect(await outcome).toEqual({ value: { completed: true } });
    expect(await sendOutcome).toMatchObject({ error: { code: "CONFLICT" } });
    expect(dispatched).toBe(false);
    expect(await f.core.controlService.getReceipt(principal, COMMAND)).toMatchObject({ state: "interrupted", delivery: "none" });
  });

  it.each(["resume_session", "resume_restart_recovery", "fork_session"])("%s refuses to bypass an accepted stop or send", async command => {
    const f = await fixture(); const sessionId = "v2-" + COMMAND;
    await f.core.controlService.execute(principal, "session.launch", launch); let calls = 0;
    await expect(f.core.controlService.admitLifecycle!(principal, {
      commandId: STOP, command, sessionIds: [sessionId], intent: command === "resume_session" ? "resume" : "inspect", request: {},
    }, async () => { calls++; })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls).toBe(0); await f.core.effectWorker.drain();
    await f.core.controlService.execute(principal, "session.stop", { commandId: STOP, sessionId });
    await expect(f.core.controlService.admitLifecycle!(principal, {
      commandId: SEND, command, sessionIds: [sessionId], intent: command === "resume_session" ? "resume" : "inspect", request: {},
    }, async () => { calls++; })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls).toBe(0);
  });

  it("choice_cancel conflicts with an accepted answer", async () => {
    const f = await fixture(); const sessionId = "v2-" + COMMAND;
    await f.core.controlService.execute(principal, "session.launch", { ...launch, initialMessage: undefined }); await f.core.effectWorker.drain();
    const choice = { choiceId: "cancel", agentId: sessionId, status: "pending", questions: [{ id: "q", question: "Pick", options: [{ id: "yes", label: "Yes" }] }] };
    f.core.database.prepare("INSERT INTO control_choices VALUES (?, ?, ?, ?, ?, NULL, 0)").run("cancel", sessionId, "runtime", "pending", JSON.stringify(choice));
    await f.core.controlService.execute(principal, "session.choose", { commandId: SEND, sessionId, choiceId: "cancel", answers: [{ questionId: "q", selectedOptionIds: ["yes"] }] });
    await expect(f.core.controlService.admitLifecycle!(principal, { commandId: STOP, command: "choice_cancel", sessionIds: [sessionId], intent: "cancel-choice", choiceId: "cancel", request: {} }, async () => {})).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("fork replays a completed result after restart without repeating the mutation", async () => {
    const f = await fixture(); const sessionId = "v2-" + COMMAND;
    await f.core.controlService.execute(principal, "session.launch", { ...launch, initialMessage: undefined }); await f.core.effectWorker.drain(); let calls = 0;
    const input = { commandId: SEND, command: "fork_session", sessionIds: [sessionId], intent: "inspect" as const, request: { label: "fork" } };
    expect(await f.core.controlService.admitLifecycle!(principal, input, async () => { calls++; return { forkId: "one" }; })).toEqual({ forkId: "one" });
    await f.core.close(); const reopened = await f.open(); await reopened.reconcileOnBoot();
    expect(await reopened.controlService.admitLifecycle!(principal, input, async () => { calls++; return { forkId: "two" }; })).toEqual({ forkId: "one" }); expect(calls).toBe(1);
    await expect(reopened.controlService.admitLifecycle!(principal, { ...input, request: { label: "other" } }, async () => {})).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("kill_agent via typed worker stop preserves manager intent and shares effect admission", async () => {
    const f = await fixture(); const sessionId = "v2-" + COMMAND;
    await f.core.controlService.execute(principal, "session.launch", { ...launch, initialMessage: undefined }); await f.core.effectWorker.drain();
    f.swarm.resolveSession = id => id === "worker" ? { sessionId, workerId: id } : { sessionId: id };
    const calls: string[] = []; f.swarm.stopSession = async input => { calls.push(input.sessionId); return { stopped: true }; };
    await f.core.controlService.execute(principal, "session.stop", { commandId: STOP, sessionId: "worker" }); await f.core.effectWorker.drain();
    expect(calls).toEqual(["worker"]);
    expect(f.core.database.prepare("SELECT desired_state FROM control_sessions WHERE session_id=?").get(sessionId)).toEqual({ desired_state: "running" });
    expect(await f.core.controlService.execute(principal, "session.stop", { commandId: STOP, sessionId: "worker" })).toMatchObject({ state: "succeeded" }); expect(calls).toHaveLength(1);
  });
});


it.each(["resume_session", "toggle_session"] as const)("Stream Deck %s enters lifecycle admission before resuming", async type => {
  const f = await fixture(); const sessionId = "v2-" + COMMAND;
  await f.core.controlService.execute(principal, "session.launch", launch);
  let resumes = 0;
  const options = { swarmManager: { getAgent: () => ({ agentId: sessionId, role: "manager", status: "stopped" }), resumeSession: async () => { resumes++; } },
    environmentControl: { control: f.core.controlService },
  } as unknown as Parameters<typeof executeStreamDeckAction>[0];
  await expect(executeStreamDeckAction(options, { type, requestId: "deck-resume", sessionAgentId: sessionId }, principal)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(resumes).toBe(0);
});

it("an interrupted resume remains fenced on restart and is never replayed", async () => {
  const f = await fixture(); const sessionId = "v2-" + COMMAND;
  await f.core.controlService.execute(principal, "session.launch", { ...launch, initialMessage: undefined }); await f.core.effectWorker.drain();
  await f.core.controlService.execute(principal, "session.stop", { commandId: STOP, sessionId }); await f.core.effectWorker.drain();
  const input = { commandId: SEND, command: "resume_session", sessionIds: [sessionId], intent: "resume" as const, request: {} };
  await f.core.controlService.admitLifecycle!(principal, input, async () => ({}));
  // Simulate loss after runtime creation, before result COMMIT.
  f.core.database.prepare("UPDATE effects SET state='claimed',payload_json=? WHERE command_id=?").run(JSON.stringify({ kind: "lifecycle.admit", intent: "resume" }), SEND);
  await f.core.close(); const reopened = await f.open(); await reopened.reconcileOnBoot();
  expect(reopened.database.prepare("SELECT desired_state FROM control_sessions WHERE session_id=?").get(sessionId)).toEqual({ desired_state: "stopped" });
  await expect(reopened.controlService.admitLifecycle!(principal, input, async () => { throw new Error("must not replay"); })).rejects.toMatchObject({ code: "CONFLICT", retryable: false });
});

it("clear retry cannot erase a later send and failed shutdown stays fenced", async () => {
  const f = await fixture(); const sessionId = "v2-" + COMMAND;
  await f.core.controlService.execute(principal, "session.launch", { ...launch, initialMessage: undefined }); await f.core.effectWorker.drain();
  let clears = 0;
  const input = { commandId: SEND, command: "clear_session", sessionIds: [sessionId], intent: "stop" as const, request: {} };
  await f.core.controlService.admitLifecycle!(principal, input, async () => { clears++; return {}; });
  await f.core.controlService.execute(principal, "session.send", { commandId: STOP, sessionId, message: { text: "new input after clear", artifactIds: [] } }); await f.core.effectWorker.drain();
  await f.core.controlService.admitLifecycle!(principal, input, async () => { clears++; return {}; }); expect(clears).toBe(1); expect(f.counts().dispatchCount).toBe(1);
});

it("profile teardown includes an unmaterialized accepted launch and excludes another launch", async () => {
  const f = await fixture(); await f.core.controlService.execute(principal, "session.launch", launch);
  const entered = deferred<void>(); const release = deferred<void>();
  const mutation = f.core.controlService.admitLifecycle!(principal, { commandId: STOP, command: "archive_profile", sessionIds: [], projectIds: ["project"], intent: "stop", request: { profileId: "project" } }, async () => { entered.resolve(); await release.promise; return {}; });
  await entered.promise;
  const next = f.core.controlService.execute(principal, "session.launch", { ...launch, commandId: SEND }).then(value => ({ value }), error => ({ error }));
  const prior = await f.core.controlService.getReceipt(principal, COMMAND);
  const nextOutcome = await next; release.resolve(); await mutation;
  expect(nextOutcome).toMatchObject({ error: { code: "CONFLICT" } });
  expect(prior).toMatchObject({ state: "interrupted", delivery: "none" });
});

it("rejected lifecycle preflight preserves accepted intent and creates no mutation journal", async () => {
  const f = await fixture(); await f.core.controlService.execute(principal, "session.launch", launch);
  const mutation = f.core.controlService.admitLifecycle!(principal, {
    commandId: STOP, command: "delete_session", sessionIds: ["v2-" + COMMAND], intent: "stop", request: {},
    preflight: () => { throw Object.assign(new Error("Forbidden lifecycle target"), { code: "FORBIDDEN" }); },
  }, async () => ({}));
  const outcome = await mutation.then(value => ({ value }), error => ({ error }));
  expect(outcome).toMatchObject({ error: { code: "FORBIDDEN" } });
  expect(count(f.core, "commands")).toBe(1);
  expect(await f.core.controlService.getReceipt(principal, COMMAND)).toMatchObject({ state: "accepted" });
});

it("holds the parent project lane against session lifecycle callbacks during project publication", async () => {
  const f = await fixture();
  await f.core.controlService.execute(principal, "session.launch", launch);
  await f.core.effectWorker.drain();
  const entered = deferred<void>(); const release = deferred<void>();
  const projectMutation = f.core.controlService.admitLifecycle!(principal, { commandId: STOP, command: "project.update", sessionIds: [], projectIds: ["project"], intent: "inspect", request: {} }, async () => { entered.resolve(); await release.promise; return {}; });
  await entered.promise;
  const summary = JSON.parse((f.core.database.prepare("SELECT summary_json FROM control_sessions WHERE session_id=?").get("v2-" + COMMAND) as { summary_json: string }).summary_json);
  const sessionId = "newly-published";
  f.core.eventSink.transaction(tx => f.core.eventSink.append(tx, { topic: "shell", sessionId, event: { type: "session.upsert", session: { ...summary, sessionId } } }));
  let sessionCallback = false;
  try {
    await expect(f.core.controlService.admitLifecycle!(principal, { commandId: SEND, command: "rename_session", sessionIds: [sessionId], intent: "inspect", request: {} }, async () => { sessionCallback = true; })).rejects.toMatchObject({ code: "CONFLICT", retryable: true });
    expect(sessionCallback).toBe(false);
  } finally { release.resolve(); await projectMutation; }
});
