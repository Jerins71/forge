import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createControlCore, type ControlCore } from "../database.js";
import { piProviderCapabilities } from "../../../swarm/runtime/pi/pi-provider-adapter.js";
import { ProviderDispatchRejectedError, type ProviderAdapter, type ProviderBinding } from "../../../swarm/runtime/provider-contract.js";
import type { ControlCoreOptions } from "../effect-types.js";
import { loadState } from "./store.js";
import { createSwarmControlAdapter } from "../swarm-control-adapter.js";
import { createArtifactService } from "../artifact-service.js";
import { UserMessageCoordinator, type HandleUserMessageOptions, type UserMessageCoordinatorOptions } from "../../../swarm/user-message-coordinator.js";
import { ConversationAttachmentService } from "../../../swarm/conversation-attachment-service.js";
import { AgentDirectory } from "../../../swarm/agent-directory.js";
import type { AgentDescriptor } from "../../../swarm/types.js";
const roots: string[] = []; const cores: ControlCore[] = [];
afterEach(async () => { for (const core of cores.splice(0)) await core.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const commandId = "00000000-0000-4000-8000-000000000001";
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-core-executor-")); roots.push(root);
  let serial = 0; let revoked = false; let dispatches = 0;
  const canonical = new Set<string>(); const caps = piProviderCapabilities();
  const adapter: ProviderAdapter = {
    capabilities: () => caps,
    open: async () => { throw new Error("fixture port supplies binding"); }, resume: async () => { throw new Error("unused"); },
    start: async input => { dispatches++; return { status: "accepted", turn: { ...input.binding.scope, kind: "turn", conversationId: "native", nativeId: "turn" } }; },
    steer: async () => { throw new Error("unused"); }, interrupt: async () => {}, respond: async () => {}, compact: async () => {},
    async *observations() {}, close: async () => {}, drain: async () => ({ status: "clean" }),
  };
  const options: ControlCoreOptions = { databasePath: path.join(root, "control.sqlite"), clock: () => 1_800_000_000_000, random: () => `00000000-0000-4000-8000-${String(++serial).padStart(12,"0")}`, isDeviceRevoked: () => revoked,
    artifacts: { validateInput: () => [], pinInput: () => {} }, workspace: { prepareLaunch: async () => { throw new Error("unused"); }, isLaunchCurrent: () => true, ensure: async () => ({ cwd: root, branch: null }), reconcile: async () => "retry" },
    swarm: { ensureSession: async () => ({ materialized: true }), stopSession: async () => ({ stopped: true }), applyChoice: async () => "answered",
      acquireProvider: async scope => ({ adapter, binding: { scope, conversation: { ...scope, kind: "conversation", nativeId: "native" }, capabilities: caps, instructionRevision: "fixture", toolContractRevision: "fixture" } satisfies ProviderBinding }),
      applyInput: async input => { canonical.add(input.inputId); return { entryId: input.inputId, runtimeMessage: { text: input.message.text } }; },
    } };
  const open = async () => { const core = await createControlCore(options); cores.push(core); await core.reconcileOnBoot(); return core; };
  const core = await open();
  core.eventSink.transaction(tx => core.eventSink.append(tx, { topic: "shell", sessionId: "manager", event: { type: "session.upsert", session: { sessionId: "manager", projectId: "project", title: "fixture", status: "idle", attention: "none", unread: 0, workerCount: 0, archived: false, updatedAt: new Date(options.clock()).toISOString(), sortKey: "fixture", workspace: { kind: "current_checkout", cwd: root, branch: null } } } }));
  return { core, options, adapter, open, revoke: () => { revoked = true; }, dispatches: () => dispatches, canonical };
}
const principal = { deviceSessionId: "device", scopes: new Set(["session:operate" as const]) };

describe("durable provider outbox", () => {
  it("rebuilds provider images from pinned prepared-message attachments after restart", async () => {
    const f = await fixture(); const root = path.dirname(f.options.databasePath!);
    const descriptor = { agentId: "manager", role: "manager", status: "idle", profileId: "project" } as AgentDescriptor;
    const attachments = new ConversationAttachmentService({ dataDir: root, uploadsDir: path.join(root, "uploads") });
    const coordinator = new UserMessageCoordinator({
      targeting: { descriptors: new Map([["manager", descriptor]]), assertDescriptorNotEffectivelyArchived() {} }, attachments,
      codex: { plugin: { assertWorkerNotUserTargetable() {} } }, projectAgents: { async preflightRuntime() {} },
      runtime: { withRuntimeAdmission: async (_id: string, work: () => Promise<unknown>) => work() },
      inboundConversation: { async append(_target: unknown, input: { attachments: import("../../../swarm/types.js").ConversationAttachment[] }) { return { event: { id: "canonical", timelineEntryId: "canonical" }, runtimeAttachments: input.attachments }; } },
      turns: { async enqueue() {} },
    } as unknown as UserMessageCoordinatorOptions);
    let submit!: (text: string, options: HandleUserMessageOptions) => Promise<void>;
    const acquire = f.options.swarm.acquireProvider;
    const swarm = { installProviderScopeOwner() {}, installAuthoritativeInputOwner(callback: typeof submit) { submit = callback; }, installControlledTurnProjection() {}, reflectControlledTurns() {}, installCoreAgentMessagePort() {},
      getAgentForInternalUse: () => descriptor, acquireControlledProvider: acquire, applyControlledInput: coordinator.applyControlledInput.bind(coordinator),
    } as unknown as Parameters<typeof createSwarmControlAdapter>[0]["swarmManager"];
    const artifactService = createArtifactService({ database: f.core.database, dataDir: root });
    const imageRows = await artifactService.prepareInternalInput({ commandId: "prepared-image", threadId: "manager", projectId: "project", attachments: [{ type: "image", mimeType: "image/png", fileName: "image.png", data: Buffer.from("fixture image bytes").toString("base64") }] });
    f.options.artifacts = artifactService;
    await f.core.controlService.submitInput({ commandId: "prepared-image", threadId: "manager", message: { text: "Prepared text with guidance.", artifactIds: imageRows.map(row => row.artifactId) }, artifactRows: imageRows,
      prepared: { runtimeMessage: { text: "Prepared text with guidance." }, presentation: { source: "agent_message" } } });
    await f.core.close(); const second = await f.open();
    const reloadedArtifacts = createArtifactService({ database: second.database, dataDir: root });
    Object.assign(f.options.swarm, createSwarmControlAdapter({ swarmManager: swarm, database: second.database, eventSink: second.eventSink, controlService: second.controlService, workspaceService: f.options.workspace, artifactService: reloadedArtifacts }));
    let nativeInput: import("../../../swarm/runtime-contracts.js").RuntimeUserMessage | undefined;
    f.adapter.start = async input => { nativeInput = input.input; return { status: "accepted", turn: { ...input.binding.scope, kind: "turn", conversationId: "native", nativeId: "turn" } }; };
    await second.effectWorker.drain();
    expect(nativeInput).toEqual({ text: "Prepared text with guidance.", images: [{ mimeType: "image/png", data: Buffer.from("fixture image bytes").toString("base64") }] });
  });
  it("persists every user input option and pinned attachment through restart before dispatch", async () => {
    const f = await fixture(); let submit!: (text: string, options: HandleUserMessageOptions) => Promise<void>;
    const delivered: Array<HandleUserMessageOptions> = []; const acquire = f.options.swarm.acquireProvider;
    const descriptor = { agentId: "manager", role: "manager", profileId: "project", managerId: "manager", model: { provider: "pi", modelId: "fixture" } };
    const swarm = {
      installProviderScopeOwner() {}, installAuthoritativeInputOwner(callback: typeof submit) { submit = callback; }, installControlledTurnProjection() {}, reflectControlledTurns() {}, installCoreAgentMessagePort() {},
      getAgentForInternalUse: () => descriptor, acquireControlledProvider: acquire,
      async applyControlledInput(text: string, options: HandleUserMessageOptions) { delivered.push(options); return { entryId: "canonical", runtimeMessage: { text } }; },
    } as unknown as Parameters<typeof createSwarmControlAdapter>[0]["swarmManager"];
    const compose = (core: ControlCore) => {
      const artifacts = createArtifactService({ database: core.database, dataDir: path.dirname(f.options.databasePath!) });
      const adapter = createSwarmControlAdapter({ swarmManager: swarm, database: core.database, eventSink: core.eventSink, controlService: core.controlService, workspaceService: f.options.workspace, artifactService: artifacts });
      Object.assign(f.options.swarm, adapter); f.options.artifacts = artifacts;
    };
    compose(f.core);
    const options: HandleUserMessageOptions = { targetAgentId: "manager", delivery: "auto", sourceContext: { channel: "cli", messageId: "source-id" }, replyTo: { messageId: "reply-id" }, clientRequestId: "client-id", commandId: "user-input-command", sessionReferenceAgentIds: ["peer-1", "peer-2"],
      attachments: [{ type: "text", mimeType: "text/plain", fileName: "input.txt", text: "Pinned input bytes" }] };
    await submit("input with options", options); await f.core.close();
    const second = await f.open(); compose(second); await second.effectWorker.drain();
    const { attachments, ...metadata } = options;
    expect(delivered).toHaveLength(1); expect(delivered[0]).toMatchObject(metadata);
    expect(delivered[0].attachments).toEqual([expect.objectContaining(attachments![0])]);
    expect(delivered[0].attachments?.[0].filePath).toContain("artifacts");
    const saved = second.database.prepare("SELECT prepared_json FROM orchestration_run_inputs WHERE run_id=?").get("run-user-input-command") as { prepared_json: string };
    expect(JSON.parse(saved.prepared_json).userOptions).toEqual(metadata);
    expect((await second.controlService.submitInput({ commandId: "unrelated", threadId: "manager", message: { text: "queued", artifactIds: [] } })).receipt.delivery).toBe("pending");
  });
  it("cancels an unmaterialized launch transactionally without creating or stopping a runtime", async () => {
    const f = await fixture(); let materialized = 0; let stops = 0;
    f.options.workspace.prepareLaunch = async input => ({ project: { projectId: "project", title: "Project", cwd: "/fixture", repository: null, isGit: false, defaultBranch: null, updatedAt: new Date(f.options.clock()).toISOString(), sortKey: "project", archived: false }, revision: "1", cwd: "/fixture", model: input.model,
      reservation: { reservationId: input.commandId, repositoryRoot: "/fixture", repositoryCommonDir: "/fixture/.git", kind: input.workspaceStrategy.kind, path: "/fixture", pathKey: "/fixture", branch: null, baseCommit: null, owned: false } });
    f.options.swarm.ensureSession = async () => { materialized++; return { materialized: true }; };
    f.options.swarm.stopSession = async () => { stops++; return { stopped: true }; };
    await f.core.controlService.execute(principal, "session.launch", { commandId, projectId: "project", title: "launch", workspaceStrategy: { kind: "current_checkout" }, initialMessage: { text: "launch", artifactIds: [] } });
    const stopId = "00000000-0000-4000-8000-000000000002"; const threadId = `v2-${commandId}`;
    await f.core.controlService.execute(principal, "session.stop", { commandId: stopId, sessionId: threadId });
    expect(loadState(f.core.database).runs[`run-${commandId}`].state).toBe("terminal");
    await f.core.effectWorker.drain();
    expect({ materialized, stops, dispatches: f.dispatches() }).toEqual({ materialized: 0, stops: 0, dispatches: 0 });
    expect((await f.core.controlService.getReceipt(principal, stopId)).state).toBe("succeeded");
    expect(f.core.database.prepare("SELECT COUNT(*) n FROM workspace_reservations").get()).toEqual({ n: 1 });
  });
  it.each(["clear_session", "delete_session", "archive_session", "stop_all_agents"])("%s fences a claimed canonical append and waits for kernel drain before mutation", async command => {
    const f = await fixture(); let entered!: () => void; let release!: () => void; let mutated = false;
    const enteredAppend = new Promise<void>(resolve => { entered = resolve; }); const heldAppend = new Promise<void>(resolve => { release = resolve; });
    f.options.swarm.applyInput = async input => { entered(); await heldAppend; return { entryId: input.inputId, runtimeMessage: { text: input.message.text } }; };
    await f.core.controlService.execute(principal, "session.send", { commandId, sessionId: "manager", message: { text: "held", artifactIds: [] } });
    const drain = f.core.effectWorker.drain(); await enteredAppend;
    const mutation = f.core.controlService.admitLifecycle(principal, { commandId: "00000000-0000-4000-8000-000000000002", command, sessionIds: ["manager"], intent: "stop", request: { command } }, async () => { expect(loadState(f.core.database).threads.manager.shutdown).toBe("clean"); mutated = true; return { completed: true }; });
    const outcome = mutation.then(value => ({ value }), error => ({ error }));
    const desired = loadState(f.core.database).threads.manager.desired; const mutatedBeforeRelease = mutated;
    release(); await drain;
    expect(desired).toBe("stopped"); expect(mutatedBeforeRelease).toBe(false);
    expect(await outcome).toEqual({ value: { completed: true } });
    expect(f.dispatches()).toBe(0);
    expect((await f.core.controlService.getReceipt(principal, commandId))).toMatchObject({ state: "interrupted", delivery: "none" });
    expect(loadState(f.core.database).runs[`run-${commandId}`].state).toBe("terminal");
  });
  it.each(["session.stop", "worker.kill"] as const)("%s stops the worker in the kernel while preserving its manager", async method => {
    const f = await fixture(); const stopped: string[] = [];
    f.options.swarm.resolveSession = agentId => agentId === "worker" ? { sessionId: "manager", workerId: "worker" } : { sessionId: agentId };
    f.options.swarm.stopSession = async input => { stopped.push(input.sessionId); return { stopped: true }; };
    f.core.eventSink.transaction(tx => f.core.eventSink.append(tx, { topic: "detail", sessionId: "manager", event: { type: "worker.upsert", worker: { agentId: "worker", title: "Worker", status: "idle" } } }));
    await f.core.controlService.submitInput({ commandId: "worker-input", threadId: "worker", thread: { role: "worker", projectId: "project", managerId: "manager" }, message: { text: "worker", artifactIds: [] } });
    await f.core.effectWorker.drain();
    await f.core.controlService.execute(principal, method, method === "worker.kill" ? { commandId, sessionId: "manager", workerId: "worker" } : { commandId, sessionId: "worker" });
    await f.core.effectWorker.drain();
    const state = loadState(f.core.database);
    expect(state.threads.worker).toMatchObject({ desired: "stopped", shutdown: "clean" });
    expect(state.threads.manager.desired).toBe("running");
    expect(stopped).toEqual(["worker"]);
    const row = f.core.database.prepare("SELECT worker_json FROM control_workers WHERE agent_id='worker'").get() as { worker_json: string };
    expect(JSON.parse(row.worker_json).status).toBe("terminated");
    await f.core.close(); const reboot = await f.open();
    expect(JSON.parse((reboot.database.prepare("SELECT worker_json FROM control_workers WHERE agent_id='worker'").get() as typeof row).worker_json).status).toBe("terminated");
    expect((await reboot.controlService.getReceipt(principal, commandId)).state).toBe("succeeded");
  });
  it("accepts and dispatches an input once while receipt completion is independent of run completion", async () => {
    const f = await fixture(); const input = { commandId, sessionId: "manager", message: { text: "fixture", artifactIds: [] } };
    await f.core.controlService.execute(principal, "session.send", input); await f.core.effectWorker.drain();
    const receipt = await f.core.controlService.execute(principal, "session.send", input);
    expect(receipt.delivery).toBe("dispatched"); expect(receipt.state).toBe("succeeded"); expect(f.dispatches()).toBe(1); expect(f.canonical.size).toBe(1);
    expect(loadState(f.core.database).runs[`run-${commandId}`].state).toBe("running");
  });
  it("rechecks revocation after runtime acquisition and before native dispatch", async () => {
    const f = await fixture(); f.options.swarm.applyInput = async input => { f.revoke(); return { entryId: input.inputId, runtimeMessage: { text: input.message.text } }; };
    await f.core.controlService.execute(principal, "session.send", { commandId, sessionId: "manager", message: { text: "fixture", artifactIds: [] } }); await f.core.effectWorker.drain();
    expect(f.dispatches()).toBe(0); expect((await f.core.controlService.getReceipt(principal, commandId)).state).toBe("interrupted");
  });
  it("retains a marked unknown dispatch through two restarts without invoking the provider again", async () => {
    const f = await fixture(); f.adapter.start = async () => { throw new Error("lost acknowledgment"); };
    await f.core.controlService.execute(principal, "session.send", { commandId, sessionId: "manager", message: { text: "fixture", artifactIds: [] } }); await f.core.effectWorker.drain();
    const before = loadState(f.core.database).recovery!; expect(before).not.toBeNull(); await f.core.close();
    const second = await f.open(); await second.effectWorker.drain(); expect(loadState(second.database).recovery?.recoveryId).toBe(before.recoveryId); await second.close();
    const third = await f.open(); await third.effectWorker.drain(); expect(loadState(third.database).recovery?.recoveryId).toBe(before.recoveryId);
    expect((await third.controlService.getReceipt(principal, commandId)).delivery).toBe("unknown");
  });
  it.each(["busy", "closed", "stale_scope"] as const)("keeps a typed %s pre-dispatch rejection out of unknown recovery", async reason => {
    const f = await fixture();
    f.adapter.start = async () => { throw new ProviderDispatchRejectedError(reason); };
    await f.core.controlService.execute(principal, "session.send", { commandId, sessionId: "manager", message: { text: "rejected", artifactIds: [] } });
    await f.core.effectWorker.drain();
    const state = loadState(f.core.database); const run = state.runs[`run-${commandId}`];
    expect(state.attempts[run.activeAttemptId]).toMatchObject({ state: "terminal", delivery: "pending", outcome: "failed" });
    expect(run.state).toBe("terminal");
    expect(state.recovery).toBeNull();
    expect(state.threads.manager.shutdown).toBe("clean");
    const receipt = await f.core.controlService.getReceipt(principal, commandId);
    expect(receipt.state).toBe("failed"); expect(receipt.delivery).toBe("none");
    await f.core.controlService.execute(principal, "session.send", { commandId: "00000000-0000-4000-8000-000000000002", sessionId: "manager", message: { text: "retry", artifactIds: [] } });
    f.adapter.start = async input => ({ status: "accepted", turn: { ...input.binding.scope, kind: "turn", conversationId: "native", nativeId: "retry-turn" } });
    await f.core.effectWorker.drain();
    expect((await f.core.controlService.getReceipt(principal, "00000000-0000-4000-8000-000000000002")).delivery).toBe("dispatched");
  });
  it("gives internal scoped calls the same durable input, receipt and outbox admission", async () => {
    const f = await fixture();
    const input = { commandId: "tool:manager:attempt:call-1:manager", threadId: "manager", message: { text: "tool input", artifactIds: [] } };
    const first = await f.core.controlService.submitInput(input);
    const second = await f.core.controlService.submitInput(input);
    expect(second.runId).toBe(first.runId);
    expect(second.receipt.acceptedSequence).toBe(first.receipt.acceptedSequence);
    expect(f.core.database.prepare("SELECT COUNT(*) n FROM control_inputs").get()).toEqual({ n: 1 });
    await f.core.effectWorker.drain();
    expect(f.dispatches()).toBe(1);
    expect(JSON.parse((f.core.database.prepare("SELECT receipt_json FROM command_receipts WHERE command_id=?").get(input.commandId) as {receipt_json:string}).receipt_json).delivery).toBe("dispatched");
  });
  it("resumes with the retained conversation locator and a new generation scope", async () => {
    const f = await fixture();
    const acquired: Array<{ scope: import("@forge/protocol").ProviderScope; conversation?: import("@forge/protocol").ProviderConversationRef }> = [];
    const original = f.options.swarm.acquireProvider;
    f.options.swarm.acquireProvider = async (scope, conversation) => { acquired.push({ scope, conversation }); return original(scope, conversation); };
    await f.core.controlService.execute(principal, "session.send", { commandId, sessionId: "manager", message: { text: "fixture", artifactIds: [] } });
    await f.core.effectWorker.drain();
    const old = acquired[0]; await f.core.close();
    const second = await f.open(); const state = loadState(second.database);
    second.controlService.record({ type:"recovery.resume", commandId:"resume", now:f.options.clock(), recoveryId:state.recovery!.recoveryId,
      attempts:{[`run-${commandId}`]:"new-attempt"}, bindingIds:{manager:"new-binding"} });
    await second.effectWorker.drain();
    expect(acquired.at(-1)?.conversation).toEqual({ ...old.scope, kind:"conversation", nativeId:"native" });
    expect(acquired.at(-1)?.scope).toEqual({ threadId:"manager", bindingId:"new-binding", generation:old.scope.generation+1 });
  });

  it("acquires the fallback model selected in the assignment transaction", async () => {
    const f=await fixture(); const models:Array<{threadId:string;model?: {provider:string;modelId:string}}>=[]; const original=f.options.swarm.acquireProvider;
    f.options.swarm.acquireProvider=async (scope,conversation,model)=>{ models.push({ threadId:scope.threadId,model }); return original(scope,conversation,model); };
    await f.core.controlService.execute(principal,"session.send",{ commandId,sessionId:"manager",message:{ text:"parent",artifactIds:[] } });
    await f.core.effectWorker.drain();
    await f.core.controlService.submitInput({ commandId:"assign-call",threadId:"worker",thread:{ role:"worker",projectId:"project",managerId:"manager" },message:{ text:"assignment",artifactIds:[] },
      assignment:{ assignmentId:"assignment",parentThreadId:"manager",parentRunId:`run-${commandId}`,selection:{ specialistId:"specialist",provider:"codex",modelId:"unavailable",maxConcurrent:1,
        candidates:[{ provider:"codex",modelId:"unavailable",available:false },{ provider:"codex",modelId:"selected-fallback",available:true }] } } });
    await f.core.effectWorker.drain();
    expect(models.find(value=>value.threadId === "worker")).toEqual({ threadId:"worker",model:{ provider:"codex",modelId:"selected-fallback" } });
    expect(loadState(f.core.database).assignments.assignment.selection.modelId).toBe("selected-fallback");
  });

});

it("projects authoritative worker status across all directory reads without changing the descriptor", () => {
  const manager = { agentId: "manager", role: "manager", status: "idle", createdAt: "2026-01-01", updatedAt: "2026-01-01", model: { provider: "pi", modelId: "fixture" } } as AgentDescriptor;
  const worker = { ...manager, agentId: "worker", managerId: "manager", role: "worker" } as AgentDescriptor;
  const directory = new AgentDirectory({ descriptors: new Map([["manager", manager], ["worker", worker]]), profiles: new Map(), getPendingChoiceCount: () => 0 });
  directory.installLifecycleStatus(id => id === "worker" ? "terminated" : undefined);
  expect(directory.getAgent("worker")?.status).toBe("terminated");
  expect(directory.getAgentForInternalUse("worker")?.status).toBe("terminated");
  expect(directory.listAgents().find(agent => agent.agentId === "worker")?.status).toBe("terminated");
  expect(directory.listAgentsForInternalUse().find(agent => agent.agentId === "worker")?.status).toBe("terminated");
  expect(directory.listWorkersForSession("manager")[0].status).toBe("terminated");
  expect(worker.status).toBe("idle");
});
