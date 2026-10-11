import { fork } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { Type } from "@sinclair/typebox";
import { ProviderObservationSchema, type ProviderConversationRef, type ProviderObservation, type InstructionBundle, type ToolHostSnapshot, type ProviderScope } from "@forge/protocol";
import { createTempConfig } from "../../test-support/temp-config.js";
import { getNativeCodexHome, getSessionFilePath } from "../storage/data-paths.js";
import { createCodexAppServerClient } from "../codex-app-server/codex-app-server-client.js";
import { createTaskNotesTool } from "../task-notes-tool.js";
import { TaskNotesStore } from "../task-notes-store.js";
import type { AgentDescriptor } from "../types.js";
import { createInstructionBundle } from "../runtime/instruction-bundle.js";
import { bindRuntimeToolHost } from "../runtime/runtime-tool-plan.js";
import { createReplayHarness, ReplaySignals, watchdog, type ReplayTranscript } from "../runtime/replay/replay-harness.js";
import { nativeCodexEnvironment, CodexRuntimeAuth } from "../runtime/codex/codex-runtime-auth.js";
import { ProviderDispatchRejectedError, ProviderRefreshRequiredError, ProviderRequestRejectedError } from "../runtime/provider-contract.js";
import { CodexProviderAdapter } from "../runtime/codex/codex-provider-adapter.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0).reverse()) await clean(); });
const directory = fileURLToPath(new URL("../runtime/codex/", import.meta.url));
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function fixture(scenario: string, options: { persistedPath?: string; codexHome?: string; changedSchema?: boolean; decision?: "accept" | "decline" } = {}) {
  const handle = await createTempConfig({ prefix: "forge-codex-adapter-", port: 0 });
  cleanup.push(handle.cleanup);
  const root = await realpath(handle.tempRootDir);
  const codexHome = options.codexHome ?? join(root, "codex-home");
  await mkdir(codexHome, { recursive: true });
  await mkdir(dirname(handle.config.paths.sharedAuthFile), { recursive: true });
  await writeFile(handle.config.paths.sharedAuthFile, JSON.stringify({ "openai-codex": { type: "api_key", key: "forge-fixture-inert-not-a-provider-key" } }));
  const descriptor: AgentDescriptor = { agentId: "adapter-agent", role: "manager", managerId: "adapter-agent", profileId: "profile",
    status: "idle", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", cwd: root,
    sessionFile: join(root, "session.jsonl"), model: { provider: "codex-native", modelId: "gpt-6-sol", thinkingLevel: "high" } };
  const scope: ProviderScope = { threadId: descriptor.agentId, bindingId: `binding-${scenario}`, generation: scenario === "resume" ? 2 : 7 };
  const instructions = createInstructionBundle(descriptor, "Forge replay contract");
  const notes = new TaskNotesStore({ dataDir: handle.config.paths.dataDir }).forActor({ profileId: "profile", sessionAgentId: descriptor.agentId, actorAgentId: descriptor.agentId });
  const tool = createTaskNotesTool(notes);
  if (options.changedSchema) tool.parameters = Type.Object({ changed: Type.String() });
  const toolHost = bindRuntimeToolHost({ descriptor, tools: [tool], mechanism: "dynamic_tools", scope });
  const transcript = JSON.parse(await readFile(join(directory, `fixtures/codex-${scenario}.json`), "utf8")) as ReplayTranscript;
  const replay = await createReplayHarness(() => ({ ...transcript, bindings: { ...transcript.bindings, $persistedPath: options.persistedPath,
    ...(options.decision ? { $decision: options.decision } : {}) } }));
  cleanup.push(replay.close);
  await writeFile(join(codexHome, "replay-peer.json"), JSON.stringify({ port: replay.port }));
  const auth = new CodexRuntimeAuth({ config: handle.config, descriptor });
  await auth.initialize();
  const adapter = new CodexProviderAdapter({ codexHome, projectTrusted: false, auth,
    createClient: handlers => createCodexAppServerClient(handlers, { command: process.execPath,
      args: [fileURLToPath(new URL("../runtime/codex/codex-scripted-peer.mjs", import.meta.url))],
      spawnOptions: { cwd: root, env: nativeCodexEnvironment(codexHome) } }) });
  const input = { scope, instructions, toolHost, model: descriptor.model };
  const binding = scenario === "resume" ? await adapter.resume({ ...input, conversation: { ...scope, generation: 1, kind: "conversation", nativeId: "native-root" } })
    : scenario === "fork" ? await adapter.fork({ ...input, source: { ...scope, bindingId: "binding-seed", kind: "conversation", nativeId: "native-root" },
      through: { ...scope, bindingId: "binding-seed", kind: "turn", nativeId: "turn-source", conversationId: "native-root" } }) : await adapter.open(input);
  cleanup.push(async () => { await adapter.close(binding); });
  const events: ProviderObservation[] = [];
  const signals = new ReplaySignals<ProviderObservation>();
  const consume = (async () => {
    for await (const event of adapter.observations(binding)) {
      expect(Value.Check(ProviderObservationSchema, event)).toBe(true);
      events.push(event);
      const phase = "phase" in event ? event.phase : "outcome" in event ? event.outcome : "request" in event ? event.request.nativeId : "";
      signals.observe(`${event.type}:${event.origin.kind}:${phase}`, event);
      signals.observe(`attempt:${event.attemptId}:${event.type}:${phase}`, event);
      signals.observe(`conversation:${event.origin.conversation.nativeId}:${event.type}:${phase}`, event);
    }
  })();
  cleanup.push(async () => { await adapter.close(binding); await consume; });
  const start = () => adapter.start({ binding, runId: "run", attemptId: "attempt", input: { text: "Work" } });
  const wait = (label: string) => watchdog(label, signals.wait(label));
  const release = async (label: string) => { await watchdog(label, replay.signals.wait(`1:${label}:held`)); replay.release(`1:${label}`); };
  const evidence = async () => {
    expect(replay.failures).toEqual([]);
    await adapter.close(binding);
    await consume;
    expect(await adapter.drain(binding)).toEqual({ status: "clean" });
    expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index));
    for (const event of events) { expect(event.scope).toEqual(scope); expect(event.attemptId).toMatch(/attempt|compact/); }
    const path = join(process.cwd(), "../../.internal/core/evidence", `codex-${scenario}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ scenario, provenance: transcript.provenance, trace: replay.trace,
      scope, capabilities: adapter.capabilities(), promptSha256: digest("Forge replay contract"), toolSchemaSha256: digest(toolHost.snapshot.tools),
      assertions: { rawTransportMatches: replay.failures.length === 0, observationsValidate: true, ordered: true, drain: "clean" },
      observations: events.map(event => ({ type: event.type, origin: event.origin.kind, attemptId: event.attemptId,
        ...(event.type === "terminal" ? { authority: event.terminalAuthority, outcome: event.outcome } : {}) })) }, null, 2));
  };
  return { adapter, binding, input, scope, instructions, toolHost, notes, root, codexHome, events, start, wait, release, replay, evidence };
}

describe("Codex ProviderAdapter over production JSON-RPC and raw replay", () => {
  it("round trips native user-input questions as Forge choice answers", async () => {
    const f = await fixture("choice-input");
    await f.start();
    await f.release("choice");
    const request = await f.wait("request_opened:root:number:1001");
    if (request.type !== "request_opened") throw new Error("Expected choice request");
    expect(request.requestKind).toBe("user_input");
    expect(request.payload).toMatchObject({ method: "item/tool/requestUserInput", params: { itemId: "choice-item" }, questions: [
      { id: "color", header: "Color", question: "Choose a color.", options: [
        { id: "0", label: "Blue", description: "A cool color." }, { id: "1", label: "Green", description: "A natural color." }] },
      { id: "note", header: "Note", question: "Add a note." },
    ] });
    await expect(f.adapter.respond({ binding: f.binding, request: request.request, lifetime: request.lifetime,
      response: { answers: [] } })).rejects.toThrow(/choice answers/i);
    const answers = [{ questionId: "color", selectedOptionIds: ["1"] }, { questionId: "note", selectedOptionIds: [], text: "Remember this." }];
    await f.adapter.respond({ binding: f.binding, request: request.request, lifetime: request.lifetime, response: answers });
    expect(await f.replay.signals.wait("1:answer")).toEqual({ id: 1001, result: {
      answers: { color: { answers: ["Green"] }, note: { answers: ["Remember this."] } },
    } });
    expect(f.events.filter(event => event.type === "request_resolved")).toHaveLength(1);
    const duplicate = await f.adapter.respond({ binding: f.binding, request: request.request, lifetime: request.lifetime, response: answers }).catch(error => error);
    expect(duplicate).toBeInstanceOf(ProviderRequestRejectedError);
    expect(duplicate).toMatchObject({ code: "PROVIDER_REQUEST_REJECTED", reason: "unknown_request" });
    await f.release("terminal");
    await f.wait("terminal:root:completed");
    await f.evidence();
  });

  it.each(["accept", "decline"] as const)("converts command approval %s through the existing Codex bridge", async decision => {
    const f = await fixture("choice-command", { decision });
    await f.start();
    await f.release("choice");
    const request = await f.wait("request_opened:root:number:1001");
    if (request.type !== "request_opened") throw new Error("Expected approval");
    expect(request.requestKind).toBe("approval");
    expect(request.payload).toMatchObject({ method: "item/commandExecution/requestApproval", questions: [{
      id: "approval", header: "Codex permission", question: expect.stringContaining("echo replay"),
      options: [{ id: "decline", label: "Deny" }, { id: "accept", label: "Allow once" }],
    }] });
    expect(JSON.stringify(request.payload)).toContain("example.test");
    await f.adapter.respond({ binding: f.binding, request: request.request, lifetime: request.lifetime,
      response: [{ questionId: "approval", selectedOptionIds: [decision] }] });
    expect(await f.replay.signals.wait("1:answer")).toEqual({ id: 1001, result: { decision } });
    await f.release("terminal");
    await f.wait("terminal:root:completed");
    await f.evidence();
  });

  it("projects the complete proposed file change and converts its approval", async () => {
    const f = await fixture("choice-file");
    await f.start();
    await f.release("choice");
    const request = await f.wait("request_opened:root:number:1001");
    if (request.type !== "request_opened") throw new Error("Expected file approval");
    expect(request.payload).toMatchObject({ method: "item/fileChange/requestApproval", params: {
      forgeFileChanges: expect.stringContaining("-before\\n+after"),
    }, questions: [{ id: "approval", question: expect.stringContaining("fixture.txt") }] });
    await f.adapter.respond({ binding: f.binding, request: request.request, lifetime: request.lifetime,
      response: [{ questionId: "approval", selectedOptionIds: ["accept"] }] });
    expect(await f.replay.signals.wait("1:answer")).toEqual({ id: 1001, result: { decision: "accept" } });
    await f.release("terminal");
    await f.wait("terminal:root:completed");
    await f.evidence();
  });

  it.each([{ legacy: false, appendCrash: false }, { legacy: true, appendCrash: false }, { legacy: false, appendCrash: true }])(
    "projects canonical output and one end without queueing: %j", async ({ legacy, appendCrash }) => {
    const handle = await createTempConfig({ prefix: "forge-codex-projection-", port: 0,
      defaultModel: { provider: "codex-native", modelId: "gpt-6-sol", thinkingLevel: "high" },
      sharedAuthContent: { "openai-codex": { type: "api_key", key: "forge-fixture-inert-not-a-provider-key" } } });
    cleanup.push(handle.cleanup);
    const root = await realpath(handle.tempRootDir);
    handle.config.defaultCwd = root;
    const descriptor: AgentDescriptor = { agentId: "adapter-agent", displayName: "Adapter replay", role: "manager", managerId: "adapter-agent", profileId: "adapter-agent",
      status: "idle", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", cwd: root,
      sessionFile: getSessionFilePath(handle.config.paths.dataDir, "adapter-agent", "adapter-agent"), model: handle.config.defaultModel };
    await writeFile(handle.config.paths.agentsStoreFile, JSON.stringify({ agents: [descriptor] }));
    const transcript = JSON.parse(await readFile(join(directory, "fixtures/codex-projection.json"), "utf8")) as ReplayTranscript;
    const crashTranscript = JSON.parse(await readFile(join(directory, "fixtures/codex-append-crash.json"), "utf8")) as ReplayTranscript;
    const resumeTranscript = JSON.parse(await readFile(join(directory, "fixtures/codex-append-resume.json"), "utf8")) as ReplayTranscript;
    let persistedPath: string | undefined;
    const replay = await createReplayHarness(runtime => appendCrash
      ? runtime === 1 ? crashTranscript : { ...resumeTranscript, bindings: { $persistedPath: persistedPath } } : transcript);
    cleanup.push(replay.close);
    const configPath = join(root, "projection-input.json");
    const childOptions = {
      cwd: root, execPath: process.execPath, execArgv: ["--import", join(process.cwd(), "node_modules/tsx/dist/loader.mjs")], stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "USER", "TMPDIR", "FORGE_INSTALLATION_STATE_DIR"].includes(key))) } as const;
    let conversation: ProviderConversationRef | undefined;
    if (appendCrash) {
      await writeFile(configPath, JSON.stringify({ config: handle.config, descriptor, port: replay.port, legacy: false, appendCrash: true }));
      const first = fork(fileURLToPath(new URL("../runtime/codex/codex-projection-replay-child.ts", import.meta.url)), [configPath], { ...childOptions, stdio: [...childOptions.stdio] });
      cleanup.push(async () => { if (first.exitCode === null && first.signalCode === null) { const exit = once(first, "exit"); first.kill(); await exit; } });
      first.stdout!.resume();
      first.stderr!.resume();
      conversation = await watchdog("durable append before crash", new Promise<ProviderConversationRef>((resolve, reject) => {
        first.on("message", message => { const m = message as { appended?: ProviderConversationRef; error?: string }; if (m.error) reject(new Error(m.error)); else if (m.appended) resolve(m.appended); });
        first.once("exit", code => { if (code) reject(new Error(`Append child failed: ${code}`)); });
      }));
      const exit = once(first, "exit");
      first.kill("SIGKILL");
      await watchdog("append crash exit", exit);
      const peerPid = await replay.signals.wait("1:connected");
      persistedPath = join(getNativeCodexHome(handle.config.paths.dataDir), `replay-rollout-${peerPid}.jsonl`);
      const before = await readFile(descriptor.sessionFile, "utf8");
      expect(before).toContain('"hasStartedTurn":false');
      expect(before).toContain('"id":"append-input"');
      expect(conversation).toMatchObject({ nativeId: "native-root", generation: 1 });
    }
    await writeFile(configPath, JSON.stringify({ config: handle.config, descriptor, port: replay.port, legacy, conversation }));
    const child = fork(fileURLToPath(new URL("../runtime/codex/codex-projection-replay-child.ts", import.meta.url)), [configPath], { ...childOptions, stdio: [...childOptions.stdio] });
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; } });
    let stderr = "";
    child.stderr!.on("data", data => { stderr += String(data); });
    child.stdout!.resume();
    interface Result {
      activeStatus: string; status: string; pending: number; statuses: string[]; ends: number;
      busy: unknown; earlyLegacyBusy?: unknown; legacyBusy?: unknown; events: Array<{ type: string; message?: { role: string; content: string } }>;
      jsonl: Array<{ type: string; customType?: string; data?: { role: string; text: string; turnId?: string }; message?: { role: string; content: Array<{ type: string; text: string }> } }>;
      observations: ProviderObservation[]; conversation: ProviderConversationRef; drain: { status: string };
    }
    const resultPromise = new Promise<Result>((resolve, reject) => {
      child.on("message", message => {
        const response = message as { error?: string; result?: Result; ready?: boolean };
        if (response.error) reject(new Error(response.error));
        else if (response.result) resolve(response.result);
        else if (response.ready) void watchdog("output held", replay.signals.wait(`${appendCrash ? 2 : 1}:output:held`)).then(() => replay.release(`${appendCrash ? 2 : 1}:output`)).catch(reject);
      });
      child.once("exit", code => { if (code) reject(new Error(`Projection child failed: ${stderr}`)); });
    });
    const result = await watchdog("projection child", Promise.race([resultPromise,
      replay.signals.wait("failure").then(failure => { throw new Error(`Raw projection replay failed: ${failure}`); }),
    ]));
    const busy = { name: "ProviderDispatchRejectedError", code: "PROVIDER_DISPATCH_REJECTED", delivery: "not_dispatched", reason: "busy", sharedClass: true };
    expect(result.activeStatus).toBe("streaming");
    expect(result.status).toBe("idle");
    expect(result.statuses).toEqual(["streaming", "idle"]);
    expect(result.pending).toBe(0);
    expect(result.ends).toBe(1);
    expect(result.busy).toMatchObject(busy);
    if (!legacy) {
      expect(result.earlyLegacyBusy).toMatchObject(busy);
      expect(result.legacyBusy).toMatchObject(busy);
    }
    for (const type of ["agent_start", "turn_start", "turn_end", "agent_end"]) expect(result.events.filter(event => event.type === type)).toHaveLength(1);
    expect(result.events.filter(event => event.type === "message_start" && event.message?.role === "user")).toHaveLength(1);
    expect(result.jsonl.filter(entry => entry.type === "message" && entry.message?.role === "assistant").map(entry => entry.message!.content)).toContainEqual([{ type: "text", text: "Canonical adapter output." }]);
    expect(result.jsonl.filter(entry => entry.customType === "swarm_conversation_entry" && entry.data?.role === "assistant").map(entry => entry.data!.text)).toEqual(["Canonical adapter output."]);
    if (!legacy) {
      expect(result.observations.every(event => event.attemptId === "projection-attempt")).toBe(true);
      const outbound = await replay.signals.wait(`${appendCrash ? 2 : 1}:start`) as { params: { clientUserMessageId: string } };
      expect(outbound.params.clientUserMessageId).toBe("projection-run");
    }
    expect(result.observations.filter(event => event.type === "terminal" && event.origin.kind === "root")).toHaveLength(1);
    expect(result.drain).toEqual({ status: "clean" });
    expect(replay.trace.filter(entry => entry.direction === "outbound" && (entry.frame as { method?: string }).method === "turn/start")).toHaveLength(1);
    if (appendCrash) {
      expect(result.conversation).toMatchObject({ nativeId: conversation!.nativeId, generation: 2 });
      expect(result.observations.every(event => event.scope.generation === 2)).toBe(true);
      expect(result.jsonl.filter(entry => entry.customType === "swarm_conversation_entry" && entry.data?.role === "user")).toHaveLength(1);
      expect(replay.trace.filter(entry => entry.direction === "outbound" && (entry.frame as { method?: string }).method === "thread/start")).toHaveLength(1);
      expect(replay.trace.filter(entry => entry.direction === "outbound" && (entry.frame as { method?: string }).method === "thread/resume")).toHaveLength(1);
    }
    expect(replay.failures).toEqual([]);
    const evidencePath = join(process.cwd(), "../../.internal/core/evidence", `codex-projection-${appendCrash ? "append-crash" : legacy ? "legacy" : "adapter"}.json`);
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify({ scenario: appendCrash ? "append-crash" : transcript.scenario, legacy, trace: replay.trace, statuses: result.statuses,
      ends: result.ends, busy: result.busy, pending: result.pending, assertions: { canonicalAssistantOutput: true, exactlyOneProjection: true, queueOwnedByKernel: true } }, null, 2));
  }, 60_000);

  it("exposes the same adapter through the real creator and reports the exact final native instructions and schemas", async () => {
    const handle = await createTempConfig({ prefix: "forge-codex-prepared-", port: 0,
      sharedAuthContent: { "openai-codex": { type: "api_key", key: "forge-fixture-inert-not-a-provider-key" } } });
    cleanup.push(handle.cleanup);
    const transcript = JSON.parse(await readFile(join(directory, "fixtures/codex-prepared.json"), "utf8")) as ReplayTranscript;
    const replay = await createReplayHarness(() => transcript);
    cleanup.push(replay.close);
    const descriptor: AgentDescriptor = { agentId: "adapter-agent", role: "manager", managerId: "adapter-agent", profileId: "profile",
      status: "idle", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", cwd: await realpath(handle.tempRootDir),
      sessionFile: join(handle.tempRootDir, "session.jsonl"), model: { provider: "codex-native", modelId: "gpt-6-sol", thinkingLevel: "high" } };
    const configPath = join(handle.tempRootDir, "prepared-input.json");
    await writeFile(configPath, JSON.stringify({ config: handle.config, descriptor, port: replay.port }));
    const child = fork(fileURLToPath(new URL("../runtime/codex/codex-prepared-replay-child.ts", import.meta.url)), [configPath], {
      cwd: handle.tempRootDir, execPath: process.execPath, execArgv: ["--import", join(process.cwd(), "node_modules/tsx/dist/loader.mjs")], stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "USER", "TMPDIR", "FORGE_INSTALLATION_STATE_DIR"].includes(key))) });
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; } });
    let stderr = "";
    child.stderr!.on("data", data => { stderr += String(data); });
    child.stdout!.resume();
    const result = await watchdog("prepared child", new Promise<{ instructions: InstructionBundle; tools: ToolHostSnapshot; scope: ProviderScope; calls: number; adapterBound: boolean; authFailureDrained: boolean }>((resolve, reject) => {
      child.on("message", message => { const response = message as { error?: string; result?: Parameters<typeof resolve>[0] }; if (response.error) reject(new Error(response.error)); else if (response.result) resolve(response.result); });
      child.once("exit", code => { if (code) reject(new Error(`Prepared child failed: ${stderr}`)); });
    }));
    expect(result.calls).toBe(1);
    expect(result.adapterBound).toBe(true);
    expect(result.authFailureDrained).toBe(true);
    expect(result.scope).toEqual({ threadId: descriptor.agentId, bindingId: "core-prepared", generation: 23 });
    const outbound = await replay.signals.wait("1:open") as { params: { developerInstructions: string; dynamicTools: Array<{ tools: Array<{ name: string; description: string; inputSchema: unknown }> }> } };
    expect(outbound.params.developerInstructions).toBe(result.instructions.parts.map(part => part.separator + part.text).join(""));
    expect(outbound.params.dynamicTools.flatMap(namespace => namespace.tools).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).toEqual(result.tools.tools);
    expect(result.tools.tools.map(tool => tool.name)).toContain("secure_bash");
    expect(result.tools.tools.map(tool => tool.name)).toContain("notes");
    expect(replay.failures).toEqual([]);
    const evidencePath = join(process.cwd(), "../../.internal/core/evidence/codex-prepared.json");
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify({ scenario: "prepared", trace: replay.trace, calls: result.calls,
      scope: result.scope, instructionRevision: result.instructions.revision, toolSchemaSha256: digest(result.tools.tools),
      assertions: { exactPreparedInstructions: true, exactPreparedToolSchemas: true, adapterBound: result.adapterBound, authFailureDrained: result.authFailureDrained } }, null, 2));
  }, 30_000);

  it("starts, steers, fences approvals, maps native children, terminates, compacts and reads native context", async () => {
    const f = await fixture("lifecycle");
    expect(await f.adapter.open(f.input)).toBe(f.binding);
    expect(await f.adapter.resume({ ...f.input, conversation: f.binding.conversation })).toBe(f.binding);
    const changedInstructions = { ...f.instructions, revision: "different" };
    const changedTools = { ...f.toolHost, snapshot: { ...f.toolHost.snapshot, tools: [] } };
    const instructionError = await f.adapter.open({ ...f.input, instructions: changedInstructions }).catch(error => error);
    expect(instructionError).toBeInstanceOf(ProviderRefreshRequiredError);
    expect(instructionError).toMatchObject({ code: "PROVIDER_REFRESH_REQUIRED", changed: "instructions" });
    const toolError = await f.adapter.resume({ ...f.input, conversation: f.binding.conversation, toolHost: changedTools }).catch(error => error);
    expect(toolError).toBeInstanceOf(ProviderRefreshRequiredError);
    expect(toolError).toMatchObject({ changed: "tools" });
    const bothError = await f.adapter.open({ ...f.input, instructions: changedInstructions, toolHost: changedTools }).catch(error => error);
    expect(bothError).toBeInstanceOf(ProviderRefreshRequiredError);
    expect(bothError).toMatchObject({ changed: "both" });
    const started = await f.start();
    expect(started).toMatchObject({ status: "accepted", turn: { ...f.scope, nativeId: "turn-root", conversationId: "native-root" } });
    if (started.status !== "accepted") throw new Error("Expected acceptance");
    expect(await f.adapter.steer({ binding: f.binding, turn: started.turn, runId: "run", attemptId: "attempt", input: { text: "Steer" } })).toEqual(started);
    await f.release("approval");
    const approval = await f.wait("request_opened:root:number:801");
    if (approval.type !== "request_opened") throw new Error("Expected request");
    await expect(f.adapter.respond({ binding: f.binding, request: { ...approval.request, generation: 6 }, lifetime: approval.lifetime, response: [{ questionId: "approval", selectedOptionIds: ["accept"] }] })).rejects.toThrow(/stale|scope/i);
    await f.adapter.respond({ binding: f.binding, request: approval.request, lifetime: approval.lifetime, response: [{ questionId: "approval", selectedOptionIds: ["accept"] }] });
    await expect(f.adapter.respond({ binding: f.binding, request: approval.request, lifetime: approval.lifetime, response: [{ questionId: "approval", selectedOptionIds: ["accept"] }] })).rejects.toThrow(/expired|resolved/i);
    await f.release("child");
    await f.release("child-approval");
    const childApproval = await f.wait("request_opened:child:string:child-permission");
    if (childApproval.type !== "request_opened") throw new Error("Expected child approval");
    await f.adapter.respond({ binding: f.binding, request: childApproval.request, lifetime: childApproval.lifetime, response: [{ questionId: "approval", selectedOptionIds: ["decline"] }] });
    await f.release("grandchild");
    const grandchild = await f.wait("conversation:native-grandchild:terminal:completed");
    expect(grandchild).toMatchObject({ terminalAuthority: "native_child", origin: { kind: "child", parentTurn: { ...f.scope, nativeId: "turn-child", conversationId: "native-child" } } });
    await f.release("child-terminal");
    const child = await f.wait("conversation:native-child:terminal:completed");
    expect(child).toMatchObject({ terminalAuthority: "native_child", origin: { parentTurn: started.turn, conversation: { nativeId: "native-child" } } });
    expect(f.events.filter(event => event.type === "terminal" && event.origin.kind === "root")).toHaveLength(0);
    await f.release("terminal");
    await f.wait("terminal:root:completed");
    expect(f.events.filter(event => event.type === "terminal" && event.origin.kind === "root")).toHaveLength(1);
    expect(f.events.find(event => event.type === "message" && event.origin.kind === "child")).toMatchObject({ item: { conversationId: "native-child", turnId: "turn-child" } });
    expect(f.events.find(event => event.type === "message" && event.channel === "reasoning")).toBeDefined();
    expect(f.events.find(event => event.type === "usage")).toMatchObject({ usage: { input: 9, output: 3, total: 12 } });
    await f.adapter.compact({ binding: f.binding, attemptId: "compact-attempt" });
    await f.release("compacted");
    await f.wait("compaction:root:completed");
    await f.wait("attempt:compact-attempt:terminal:completed");
    const context = await f.adapter.readContext({ binding: f.binding });
    expect(context.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Work" }] }, { role: "assistant", content: "Done" }]);
    await f.evidence();
  });

  it("invokes the real file-backed Forge notes tool and cancels live approvals and tools through dynamicTools", async () => {
    const f = await fixture("tools");
    const otherNotes = new TaskNotesStore({ dataDir: join(f.root, "other-data") }).forActor({ profileId: "profile", sessionAgentId: f.scope.threadId, actorAgentId: f.scope.threadId });
    const equivalentHost = bindRuntimeToolHost({ descriptor: { agentId: f.scope.threadId, role: "manager", profileId: "profile" } as AgentDescriptor, tools: [createTaskNotesTool(otherNotes)], mechanism: "dynamic_tools", scope: f.scope });
    expect(await f.adapter.open({ ...f.input, toolHost: equivalentHost })).toBe(f.binding);
    const started = await f.start();
    if (started.status !== "accepted") throw new Error("Expected acceptance");
    await f.release("pending");
    const approval = await f.wait("request_opened:root:number:903");
    expect((await f.notes.read({ path: "checkpoint.md" })).text).toBe("Persisted through dynamicTools");
    expect((await otherNotes.list({})).notes).toEqual([]);
    expect(f.events.filter(event => event.type === "tool" && event.phase === "complete").map(event => event.call.nativeId)).toEqual(["native-write", "native-read"]);
    await f.adapter.interrupt({ binding: f.binding, attemptId: "attempt", turn: started.turn });
    expect(f.events.some(event => event.type === "terminal")).toBe(false);
    if (approval.type !== "request_opened") throw new Error("Expected request");
    await expect(f.adapter.respond({ binding: f.binding, request: approval.request, lifetime: approval.lifetime, response: [{ questionId: "approval", selectedOptionIds: ["accept"] }] })).rejects.toThrow(/expired|resolved/i);
    await f.release("cancelled-tool");
    await f.release("interrupted");
    await f.wait("terminal:root:interrupted");
    expect((await f.notes.list({})).notes.map(note => note.path)).toEqual(["checkpoint.md"]);
    await f.evidence();
  });

  it("resumes with explicit instruction refresh and refuses persisted tools whose schema changed", async () => {
    const first = await fixture("tools");
    const started = await first.start();
    if (started.status !== "accepted") throw new Error("Expected acceptance");
    await first.release("pending");
    const oldRequest = await first.wait("request_opened:root:number:903");
    if (oldRequest.type !== "request_opened") throw new Error("Expected old request");
    await first.adapter.interrupt({ binding: first.binding, attemptId: "attempt", turn: started.turn });
    await first.release("cancelled-tool");
    await first.release("interrupted");
    await first.wait("terminal:root:interrupted");
    await first.adapter.close(first.binding);
    const path = join(first.codexHome, (await readdir(first.codexHome)).find(name => name.startsWith("replay-rollout"))!);
    // A resumed thread remains in the same isolated native home.
    const handle = await fixture("resume", { persistedPath: path, codexHome: first.codexHome, changedSchema: true });
    await handle.start();
    const stale = await handle.adapter.respond({ binding: handle.binding, request: oldRequest.request, lifetime: oldRequest.lifetime,
      response: [{ questionId: "approval", selectedOptionIds: ["accept"] }] }).catch(error => error);
    expect(stale).toBeInstanceOf(ProviderRequestRejectedError);
    expect(stale).toMatchObject({ code: "PROVIDER_REQUEST_REJECTED", reason: "stale_scope" });
    await expect(handle.adapter.respond({ binding: handle.binding, request: { ...oldRequest.request, ...handle.scope },
      lifetime: { ...oldRequest.lifetime, generation: handle.scope.generation }, response: [] }))
      .rejects.toMatchObject({ code: "PROVIDER_REQUEST_REJECTED", reason: "unknown_request" });
    expect(handle.replay.trace.filter(row => row.direction === "outbound" && (row.frame as { id?: unknown }).id === 903)).toEqual([]);
    await handle.release("terminal");
    await handle.wait("terminal:root:completed");
    expect(handle.scope.generation).toBe(2);
    for (const observation of handle.events) {
      expect(observation.scope.generation).toBe(2);
      expect(observation.origin.conversation.generation).toBe(2);
      if ("request" in observation) expect(observation.request.generation).toBe(2);
      if ("call" in observation) expect(observation.call.generation).toBe(2);
      if ("turn" in observation) expect(observation.turn.generation).toBe(2);
    }
    expect(handle.replay.trace.filter(row => row.direction === "outbound" && (row.frame as { method?: string }).method === "thread/start")).toHaveLength(0);
    await handle.evidence();
  });

  it("refreshes instructions explicitly at a dispatch boundary and rejects live tool registration changes", async () => {
    const f = await fixture("refresh");
    await f.start();
    await f.release("terminal");
    await f.wait("terminal:root:completed");
    await expect(f.adapter.start({ binding: f.binding, runId: "next", attemptId: "next-attempt", input: { text: "Changed instructions" },
      toolHost: { ...f.toolHost, snapshot: { ...f.toolHost.snapshot, tools: [] } } })).rejects.toMatchObject({ code: "PROVIDER_BEHAVIOR_UNSUPPORTED", behavior: "toolRefresh" });
    const instructions = createInstructionBundle({ agentId: f.scope.threadId, role: "manager", managerId: f.scope.threadId, cwd: f.root }, "Changed integration contract");
    await f.adapter.start({ binding: f.binding, runId: "next", attemptId: "attempt-next", input: { text: "Changed instructions" }, instructions });
    await f.release("next-terminal");
    await f.wait("attempt:attempt-next:terminal:completed");
    expect(f.events.filter(event => event.type === "terminal" && event.origin.kind === "root")).toHaveLength(2);
    expect(f.binding.instructionRevision).toBe(instructions.revision);
    await f.evidence();
  });

  it("forks through an exact native turn and keeps the inherited immutable tool contract", async () => {
    const source = await fixture("seed");
    await source.adapter.close(source.binding);
    const forked = await fixture("fork", { codexHome: source.codexHome });
    expect(forked.binding.conversation.nativeId).toBe("fork-root");
    await forked.start();
    await forked.release("terminal");
    await forked.wait("terminal:root:completed");
    await forked.evidence();
  });

  it("keeps an ambiguous steer receipt unknown even when the root turn was already accepted", async () => {
    const f = await fixture("steer-unknown");
    const started = await f.start();
    if (started.status !== "accepted") throw new Error("Expected acceptance");
    const steer = f.adapter.steer({ binding: f.binding, turn: started.turn, runId: "steer", attemptId: "attempt", input: { text: "Steer" } });
    await f.release("failure");
    expect(await steer).toEqual({ status: "unknown" });
    expect(f.events.some(event => event.type === "error" && event.delivery === "unknown")).toBe(true);
    expect(f.events.some(event => event.type === "terminal")).toBe(false);
    await f.evidence();
  });

  it("reports lost acceptance as unknown without synthesizing an authoritative terminal or replaying", async () => {
    const f = await fixture("unknown");
    const dispatch = f.start();
    await f.release("failure");
    expect(await dispatch).toEqual({ status: "unknown" });
    expect(await f.wait("error:root:")).toMatchObject({ delivery: "unknown" });
    expect(f.events.filter(event => event.type === "terminal")).toHaveLength(0);
    await expect(f.start()).rejects.toBeInstanceOf(ProviderDispatchRejectedError);
    expect(await f.adapter.drain(f.binding)).toEqual({ status: "pending" });
    await f.evidence();
  });

  it("preserves acknowledged protocol rejection and fails unsupported requirements before connecting", async () => {
    const f = await fixture("rejected");
    await expect(f.start()).rejects.toMatchObject({ code: -32602, message: "Invalid input" });
    expect(await f.wait("error:root:")).toMatchObject({ delivery: "not_dispatched" });
    await f.evidence();
    const denied = new CodexProviderAdapter({ codexHome: f.codexHome, projectTrusted: false,
      auth: new CodexRuntimeAuth({ config: { paths: {} } as never, descriptor: {} as never }) });
    await expect(denied.open({ ...f.input, required: { persistentApprovals: true } })).rejects.toMatchObject({ code: "PROVIDER_BEHAVIOR_UNSUPPORTED" });
  });
});
