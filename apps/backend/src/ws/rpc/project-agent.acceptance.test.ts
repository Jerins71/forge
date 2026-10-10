import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempConfig, TestSwarmManager, bootWithDefaultManager } from "../../test-support/index.js";
import { createTestEnvironment } from "../../test-support/environment-auth.js";
import { WsHandler } from "../ws-handler.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const config = await makeTempConfig({ prefix: "v2-project-agent-", omitSharedAuthFile: true, omitSharedSecretsFile: true });
  let manager = new TestSwarmManager(config); await bootWithDefaultManager(manager, config);
  const target = await manager.createManager("manager", { name: "Target", cwd: config.defaultCwd });
  const source = await manager.createSession("manager", { label: "Docs" });
  const sessionId = source.sessionAgent.agentId;
  await manager.setSessionProjectAgent(sessionId, { handle: "docs", whenToUse: "Documentation", systemPrompt: "Write docs" });
  await manager.setProjectAgentReference(sessionId, "guide.md", "Original\n");
  let f = await createTestEnvironment(manager);
  const handler = new WsHandler({ swarmManager: manager, unreadTracker: f.unreadTracker, mobilePushService: {} as never, allowNonManagerSubscriptions: true,
    perf: { recordDuration() {}, increment() {}, readSummary() {}, readRecentSlowEvents() {} } as never });
  let { rpc } = f.environment.composeTransport(handler, null);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://forge.invalid");
    const route = f.environment.routes.find(route => route.methods.split(/,\s*/).includes(req.method!) && route.matches(url.pathname));
    if (route) await route.handle(req, res, url); else { res.writeHead(404); res.end(); }
  });
  server.on("upgrade", (req, socket, head) => { void rpc.handleUpgrade(req, socket, head); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let socket = new WebSocket(base.replace("http", "ws") + "/api/v2/rpc", await f.paired.protocols("rpc"));
  const streams: any[] = [];
  const pending = new Map<string, (frame: any) => void>();
  function listen() { socket.on("message", data => { const frame = JSON.parse(data.toString()); pending.get(frame.requestId)?.(frame); if (frame.type === "stream") streams.push(frame); }); }
  listen(); await once(socket, "open");
  const originalPrincipal = f.paired.principal;
  const originalHeaders = f.paired.headers;
  const reconnect = async () => {
    socket.terminate();
    const ticket = await f.environment.access.issueWsTicket(originalPrincipal, { audience: "rpc", protocolVersion: 1 }, null);
    socket = new WebSocket(base.replace("http", "ws") + "/api/v2/rpc", ["forge.v2", `ticket.${ticket.ticket}`]);
    listen(); await once(socket, "open");
  };
  const restart = async () => {
    socket.terminate();
    for (const agent of manager.listAgents().filter(a => a.role === "manager")) await manager.stopSession(agent.agentId);
    await f.environment.stop();
    await manager.disposeHistoryRecall();
    manager = new TestSwarmManager(config);
    f = await createTestEnvironment(manager, { boot: true });
    const restartedHandler = new WsHandler({ swarmManager: manager, unreadTracker: f.unreadTracker, mobilePushService: {} as never, allowNonManagerSubscriptions: true,
      perf: { recordDuration() {}, increment() {}, readSummary() {}, readRecentSlowEvents() {} } as never });
    rpc = f.environment.composeTransport(restartedHandler, null).rpc;
    const ticket = await f.environment.access.issueWsTicket(originalPrincipal, { audience: "rpc", protocolVersion: 1 }, null);
    socket = new WebSocket(base.replace("http", "ws") + "/api/v2/rpc", ["forge.v2", `ticket.${ticket.ticket}`]);
    listen(); await once(socket, "open");
    return { manager, environment: f.environment };
  };
  cleanups.push(async () => {
    socket.terminate();
    for (const agent of manager.listAgents().filter(a => a.role === "manager")) await manager.stopSession(agent.agentId);
    await f.environment.stop(); await new Promise<void>(resolve => server.close(() => resolve()));
    await manager.disposeHistoryRecall(); await rm(config.paths.dataDir, { recursive: true, force: true });
  });
  const request = (method: string, input: unknown) => new Promise<any>(resolve => { const requestId = randomUUID(); pending.set(requestId, resolve); socket.send(JSON.stringify({ type: "request", requestId, method, input })); });
  const reference = async (method: string, input: unknown) => {
    const response = await fetch(base + "/api/v2/project-agents/reference", { method, headers: { ...originalHeaders, "Content-Type": "application/json", "x-forge-environment-protocol": "1" }, body: JSON.stringify(input) });
    return { status: response.status, output: response.status === 404 ? {} : await response.json() };
  };
  return { ...f, config, manager, target, sessionId, request, reference, restart, reconnect, streams };
}
describe("V2 Project Agent commands against authenticated composed owners", () => {
  it("promotes via projectAgent.set and returns its durable receipt", async () => {
    const f = await fixture(); const commandId = randomUUID();
    expect(await f.request("projectAgent.set", { commandId, sessionId: f.sessionId, projectAgent: { handle: "docs", whenToUse: "Updated" } })).toMatchObject({ type: "result", output: { sessionId: f.sessionId, projectId: "manager", receipt: { commandId, state: "succeeded" } } });
  });
  it("reads config via projectAgent.get", async () => {
    const f = await fixture(); expect(await f.request("projectAgent.get", { sessionId: f.sessionId })).toMatchObject({ type: "result", output: { config: { handle: "docs" }, systemPrompt: "Write docs", references: ["guide.md"] } });
  });
  it("reads sharing via projectAgent.sharing.get", async () => {
    const f = await fixture(); expect(await f.request("projectAgent.sharing.get", { sessionId: f.sessionId })).toMatchObject({ type: "result", output: { grants: [], eligibleTargets: expect.any(Array) } });
  });
  it("changes sharing via projectAgent.sharing.set with a saved receipt", async () => {
    const f = await fixture(); const commandId = randomUUID();
    expect(await f.request("projectAgent.sharing.set", { commandId, sessionId: f.sessionId, targetProjectIds: [f.target.profileId] })).toMatchObject({ type: "result", output: { receipt: { commandId, state: "succeeded" }, grants: [expect.objectContaining({ targetProfileId: f.target.profileId })] } });
  });
  it("reads external directory using a project ID without a selected session", async () => {
    const f = await fixture(); await f.manager.setProjectAgentSharing(f.sessionId, [f.target.profileId]);
    expect(await f.request("projectAgent.directory", { projectId: f.target.profileId })).toMatchObject({ type: "result", output: { projectId: f.target.profileId, entries: [expect.objectContaining({ agentId: f.sessionId })] } });
  });
  it("lists references via projectAgent.references.list", async () => {
    const f = await fixture(); expect(await f.request("projectAgent.references.list", { sessionId: f.sessionId })).toMatchObject({ type: "result", output: { references: ["guide.md"] } });
  });
  it("reads reference bytes and revision via projectAgent.reference.read", async () => {
    const f = await fixture(); expect(await f.request("projectAgent.reference.read", { sessionId: f.sessionId, fileName: "guide.md" })).toMatchObject({ type: "result", output: { content: "Original\n", revision: expect.any(String) } });
  });
  it("writes reference through transient HTTP and rejects concurrent stale edits", async () => {
    const f = await fixture(); const read = await f.request("projectAgent.reference.read", { sessionId: f.sessionId, fileName: "guide.md" });
    const results = await Promise.all(["First", "Second"].map(content => f.reference("PUT", { sessionId: f.sessionId, fileName: "guide.md", expectedRevision: read.output?.revision ?? null, content })));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(await f.manager.getProjectAgentReference(f.sessionId, "guide.md")).toMatch(/^(First|Second)\n$/);
    const stored = await f.manager.getProjectAgentReference(f.sessionId, "guide.md");
    expect(await f.reference("PUT", { sessionId: f.sessionId, fileName: "guide.md", expectedRevision: read.output.revision, content: "Stale write" })).toMatchObject({ status: 409 });
    expect(await f.manager.getProjectAgentReference(f.sessionId, "guide.md")).toBe(stored);
    const journal = JSON.stringify(f.environment.database.prepare("SELECT normalized_json,payload_json FROM commands JOIN effects USING(command_id)").all());
    for (const bytes of ["Original", "First", "Second", "Stale write"]) expect(journal).not.toContain(bytes);
  });
  it("deletes reference with expected revision through transient HTTP", async () => {
    const f = await fixture(); const read = await f.request("projectAgent.reference.read", { sessionId: f.sessionId, fileName: "guide.md" });
    expect(await f.reference("DELETE", { sessionId: f.sessionId, fileName: "guide.md", expectedRevision: read.output?.revision ?? null })).toMatchObject({ status: 200, output: { revision: null } });
    expect(await f.manager.listProjectAgentReferences(f.sessionId)).toEqual([]);
  });
  it("journals recommendations and replays a dropped response without another provider request", async () => {
    const f = await fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider = vi.spyOn(f.manager, "requestProjectAgentRecommendations").mockImplementation(async () => { await gate; return { whenToUse: "Recommended", systemPrompt: "Suggested" }; });
    const input = { commandId: randomUUID(), sessionId: f.sessionId };
    void f.request("projectAgent.recommend", input);
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    await f.reconnect(); release();
    const retried = await f.request("projectAgent.recommend", input);
    expect(retried).toMatchObject({ type: "result", output: { whenToUse: "Recommended", receipt: { state: "succeeded" } } });
    expect(await f.request("projectAgent.recommend", input)).toMatchObject({ type: "result", output: retried.output }); expect(provider).toHaveBeenCalledTimes(1);
  });
  it("replays promotion/recommendation receipts after restart and bootstraps the same metadata and sharing", async () => {
    const f = await fixture();
    const promotion = { commandId: randomUUID(), sessionId: f.sessionId, projectAgent: { handle: "docs", whenToUse: "Restart docs", systemPrompt: "User prompt remains file-backed" } };
    const first = await f.request("projectAgent.set", promotion);
    expect(first.type).toBe("result");
    await f.request("projectAgent.sharing.set", { commandId: randomUUID(), sessionId: f.sessionId, targetProjectIds: [f.target.profileId] });
    const provider = vi.spyOn(f.manager, "requestProjectAgentRecommendations").mockResolvedValue({ whenToUse: "Recommended", systemPrompt: "Suggested" });
    const recommendation = { commandId: randomUUID(), sessionId: f.sessionId };
    expect((await f.request("projectAgent.recommend", recommendation)).type).toBe("result");
    expect(provider).toHaveBeenCalledTimes(1);
    const restarted = await f.restart();
    const newProvider = vi.spyOn(restarted.manager, "requestProjectAgentRecommendations").mockRejectedValue(new Error("Must not call provider on retry"));
    expect(await f.request("projectAgent.set", promotion)).toMatchObject({ type: "result", output: first.output });
    expect(await f.request("projectAgent.recommend", recommendation)).toMatchObject({ type: "result", output: { whenToUse: "Recommended" } });
    expect(newProvider).not.toHaveBeenCalled();
    expect(await f.request("projectAgent.operation.get", { commandId: recommendation.commandId })).toMatchObject({ type: "result", output: { state: "succeeded" } });
    expect(await f.request("projectAgent.directory", { projectId: f.target.profileId })).toMatchObject({ type: "result", output: { entries: [expect.objectContaining({ agentId: f.sessionId })] } });
    expect(await f.request("projectAgent.get", { sessionId: f.sessionId })).toMatchObject({ type: "result", output: { systemPrompt: "User prompt remains file-backed" } });
    const rows = JSON.stringify(restarted.environment.database.prepare("SELECT normalized_json,payload_json FROM commands JOIN effects USING(command_id)").all());
    expect(rows).not.toContain("User prompt remains file-backed");
    await f.request("shell.subscribe", {});
    await vi.waitFor(() => expect(f.streams.some(frame => frame.item.kind === "snapshot")).toBe(true));
    expect(f.streams.find(frame => frame.item.kind === "snapshot").item.snapshot).toMatchObject({ sessions: expect.arrayContaining([expect.objectContaining({ sessionId: f.sessionId, projectAgent: expect.objectContaining({ handle: "docs", whenToUse: "Restart docs" }) })]) });
  });
  it("rejects stale delete, traversal, foreign targets and unknown input fields before mutation", async () => {
    const f = await fixture();
    const read = await f.request("projectAgent.reference.read", { sessionId: f.sessionId, fileName: "guide.md" });
    expect(await f.reference("DELETE", { sessionId: f.sessionId, fileName: "guide.md", expectedRevision: "b".repeat(64) })).toMatchObject({ status: 409 });
    expect(await f.reference("PUT", { sessionId: f.sessionId, fileName: "../outside.md", expectedRevision: null, content: "Escape" })).toMatchObject({ status: 400 });
    expect(await f.reference("PUT", { sessionId: "foreign", fileName: "guide.md", expectedRevision: null, content: "Foreign" })).toMatchObject({ status: 404 });
    expect(await f.reference("PUT", { sessionId: f.sessionId, fileName: "guide.md", expectedRevision: read.output.revision, content: "Unsupported", future: true })).toMatchObject({ status: 400 });
    expect(await f.request("projectAgent.set", { commandId: randomUUID(), sessionId: f.sessionId, projectAgent: { whenToUse: "Future", future: true } })).toMatchObject({ type: "error", error: { code: "INVALID_INPUT" } });
    expect(await f.request("projectAgent.directory", { projectId: "foreign" })).toMatchObject({ type: "error", error: { code: "NOT_FOUND" } });
    expect(await f.manager.getProjectAgentReference(f.sessionId, "guide.md")).toBe("Original\n");
  });
  it("does not repeat an ambiguous recommendation provider request", async () => {
    const f = await fixture(); const provider = vi.spyOn(f.manager, "requestProjectAgentRecommendations").mockRejectedValue(new Error("Provider result unknown"));
    const input = { commandId: randomUUID(), sessionId: f.sessionId };
    expect((await f.request("projectAgent.recommend", input)).type).toBe("error");
    expect(await f.request("projectAgent.operation.get", { commandId: input.commandId })).toMatchObject({ type: "result", output: { state: "interrupted" } });
    expect(await f.request("projectAgent.recommend", input)).toMatchObject({ type: "error", error: { code: "CONFLICT", retryable: false } });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("blocks promotion, sharing and recommendation while controlled input is unsettled", async () => {
    const f = await fixture();
    await f.environment.control.execute(f.paired.principal, "session.send", { commandId: randomUUID(), sessionId: f.sessionId, message: { text: "Pending accepted input", artifactIds: [] } });
    const provider = vi.spyOn(f.manager, "requestProjectAgentRecommendations");
    for (const [method, fields] of [["projectAgent.set", { projectAgent: null }], ["projectAgent.sharing.set", { targetProjectIds: [f.target.profileId] }], ["projectAgent.recommend", {}]] as const) {
      expect(await f.request(method, { commandId: randomUUID(), sessionId: f.sessionId, ...fields })).toMatchObject({ type: "error", error: { code: "CONFLICT", retryable: true } });
    }
    expect(provider).not.toHaveBeenCalled(); expect(f.manager.getAgent(f.sessionId)?.projectAgent?.handle).toBe("docs");
    expect(await f.manager.getProjectAgentExternalDirectory(f.target.profileId!)).toEqual([]);
  });
  it("fences reference write against an accepted send on the same session", async () => {
    const f = await fixture();
    const read = await f.request("projectAgent.reference.read", { sessionId: f.sessionId, fileName: "guide.md" });
    await f.environment.control.execute(f.paired.principal, "session.send", { commandId: randomUUID(), sessionId: f.sessionId, message: { text: "Accepted input owns the session", artifactIds: [] } });
    const result = await f.reference("PUT", { sessionId: f.sessionId, fileName: "guide.md", expectedRevision: read.output.revision, content: "Must not recycle accepted input" });
    expect(result).toMatchObject({ status: 409, output: { error: { code: "CONFLICT", retryable: true } } });
    expect(await f.manager.getProjectAgentReference(f.sessionId, "guide.md")).toBe("Original\n");
  });
  it("admits references with workspace write without elevating session operation scope", async () => {
    const f = await fixture();
    const read = await f.request("projectAgent.reference.read", { sessionId: f.sessionId, fileName: "guide.md" });
    f.environment.database.prepare("UPDATE device_sessions SET scopes_json=? WHERE device_session_id=?").run(JSON.stringify(["workspace:write"]), f.paired.principal.deviceSessionId);
    expect(await f.reference("PUT", { sessionId: f.sessionId, fileName: "guide.md", expectedRevision: read.output.revision, content: "Workspace write only" })).toMatchObject({ status: 200, output: { revision: expect.any(String) } });
    expect(await f.reference("DELETE", { sessionId: f.sessionId, fileName: "guide.md", expectedRevision: "b".repeat(64) })).toMatchObject({ status: 409 });
    f.environment.database.prepare("UPDATE device_sessions SET scopes_json=? WHERE device_session_id=?").run(JSON.stringify(["workspace:read"]), f.paired.principal.deviceSessionId);
    const latest = await f.manager.getProjectAgentReference(f.sessionId, "guide.md");
    expect(await f.reference("PUT", { sessionId: f.sessionId, fileName: "guide.md", expectedRevision: null, content: "Read-only attack" })).toMatchObject({ status: 403 });
    expect(await f.manager.getProjectAgentReference(f.sessionId, "guide.md")).toBe(latest);
  });
  it("returns the saved promotion receipt after the session is deleted", async () => {
    const f = await fixture();
    const input = { commandId: randomUUID(), sessionId: f.sessionId, projectAgent: { handle: "docs", whenToUse: "Saved promotion" } };
    const accepted = await f.request("projectAgent.set", input);
    expect(accepted.type).toBe("result");
    await f.manager.deleteSession(f.sessionId);
    expect(f.manager.getAgent(f.sessionId)).toBeUndefined();
    expect(await f.request("projectAgent.set", input)).toMatchObject({ type: "result", output: accepted.output });
    expect(f.manager.getAgent(f.sessionId)).toBeUndefined();
  });
  it("bootstraps demotion and unsharing without stale Project Agent metadata", async () => {
    const f = await fixture();
    expect((await f.request("projectAgent.sharing.set", { commandId: randomUUID(), sessionId: f.sessionId, targetProjectIds: [f.target.profileId] })).type).toBe("result");
    expect((await f.request("projectAgent.sharing.set", { commandId: randomUUID(), sessionId: f.sessionId, targetProjectIds: [] })).type).toBe("result");
    expect((await f.request("projectAgent.set", { commandId: randomUUID(), sessionId: f.sessionId, projectAgent: null })).type).toBe("result");
    const restarted = await f.restart();
    expect(restarted.manager.getAgent(f.sessionId)?.projectAgent).toBeUndefined();
    expect(await f.request("projectAgent.directory", { projectId: f.target.profileId })).toMatchObject({ type: "result", output: { entries: [] } });
    await f.request("shell.subscribe", {}); await vi.waitFor(() => expect(f.streams.some(frame => frame.item.kind === "snapshot")).toBe(true));
    expect(f.streams.find(frame => frame.item.kind === "snapshot").item.snapshot.sessions.find((session: any) => session.sessionId === f.sessionId).projectAgent).toBeNull();
  });

});
