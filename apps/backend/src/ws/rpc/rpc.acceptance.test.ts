import { createControlCore } from '../../environment/control/database.js';
import { loadConfiguredSqliteDatabaseConstructor } from '../../sqlite-database-loader.js';
import { createShellStream } from '../../environment/streams/shell-stream.js';
import { createDetailStream } from '../../environment/streams/detail-stream.js';
import { loadState } from '../../environment/control/orchestration/store.js';
import { piProviderCapabilities } from '../../swarm/runtime/pi/pi-provider-adapter.js';
import type { ProviderAdapter } from '../../swarm/runtime/provider-contract.js';
import { descriptor } from './__tests__/fixtures.js';
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHealthRoutes } from "../http/routes/health-routes.js";
import type { EnvironmentHttpRoute } from "./http-route-access.js";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { socketFixture as transportFixture, principal, receipt } from "./__tests__/fixtures.js";
import type { ControlService } from "../../environment/control/control-types.js";
import { createSessionLifecycleRpc } from "./session-lifecycle-rpc.js";

// Reuse the socket/ticket harness while substituting its obsolete lifecycle fixture.
// This core substitutes only provider and canonical writer resources.
async function socketFixture(overrides: Parameters<typeof transportFixture>[0] = {}) {
  const Constructor = await loadConfiguredSqliteDatabaseConstructor();
  const database = new Constructor(":memory:");
  const adapter: ProviderAdapter = {
    capabilities: piProviderCapabilities,
    open: async () => { throw new Error("Fixture acquisition owns open"); },
    resume: async () => { throw new Error("Fixture acquisition owns resume"); },
    start: async input => {
      const turn = { ...input.binding.scope, kind: "turn" as const, nativeId: input.attemptId, conversationId: input.binding.conversation.nativeId };
      queueMicrotask(() => core.controlService.record({ type: "provider.observe", commandId: `terminal:${input.attemptId}`, now: Date.now(), observation: {
        type: "terminal", scope: input.binding.scope, attemptId: input.attemptId, sequence: 0,
        origin: { kind: "root", turn }, terminalAuthority: "root_attempt", outcome: "completed",
      } }));
      return { status: "accepted", turn };
    },
    steer: async () => { throw new Error("Core queues fixture input"); }, interrupt: async () => {}, respond: async () => {}, compact: async () => {}, close: async () => {}, drain: async () => ({ status: "clean" }),
    observations: async function* (_binding, signal) { if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true })); },
  };
  const core = await createControlCore({ database, clock: Date.now, random: randomUUID, isDeviceRevoked: () => false,
    swarm: {
      ensureSession: async () => ({ materialized: true }), stopSession: async () => ({ stopped: true }), applyChoice: async () => "answered",
      applyInput: async input => ({ entryId: input.inputId, runtimeMessage: { text: input.message.text } }),
      acquireProvider: async scope => ({ adapter, binding: { scope, conversation: { ...scope, kind: "conversation", nativeId: `native:${scope.threadId}` }, capabilities: adapter.capabilities(), instructionRevision: "fixture", toolContractRevision: "fixture" } }),
    },
    workspace: {
      prepareLaunch: async input => ({ project: { projectId: "project", title: "Project", cwd: "/test", repository: null, isGit: false, defaultBranch: null, updatedAt: "2026-10-04T00:00:00.000Z", sortKey: "project", archived: false },
        revision: "1", cwd: "/test", reservation: { reservationId: input.commandId, repositoryRoot: "/test", repositoryCommonDir: "/test", kind: "current_checkout", path: "/test", pathKey: "/test", branch: null, baseCommit: null, owned: false } }),
      isLaunchCurrent: () => true, ensure: async () => ({ cwd: "/test", branch: null }), reconcile: async () => "ready",
    },
    artifacts: { validateInput: () => [], pinInput: () => {} },
  });
  const sink = core.eventSink;
  const deps = { database, getDescriptor: () => descriptor, subscribeCommitted: sink.subscribe, withReadBarrier: <T>(fn: () => T) => sink.readBarrier(fn).value };
  const shellStream = createShellStream(deps); const detailStream = createDetailStream(deps);
  const transport = await transportFixture({ control: core.controlService, shellStream, detailStream, ...overrides });
  return { ...transport, streams: { ...transport.streams, database, sink, core, deps, shellStream, detailStream },
    close: async () => { await transport.close(); await core.close(); database.close(); },
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

describe("environment RPC real socket boundary", () => {
  it("preserves system-session resume authority while denying destructive lifecycle mutations", async () => {
    let resumed = 0;
    const control: ControlService = {
      execute: async () => { throw new Error("unused"); },
      getReceipt: async (_principal, id) => receipt("session.resume", id),
      admitLifecycle: async (_principal, admission, operation) => { admission.preflight?.(); return operation(); },
    };
    const rpc = createSessionLifecycleRpc({ control, swarmManager: {
      getAgent: () => ({ agentId: "system-session", role: "manager", profileId: "system" }),
      listProfiles: () => [{ profileId: "system", profileType: "system" }],
      resumeSession: async () => { resumed++; },
    } as never });
    await expect(rpc.execute(principal, "session.resume", { commandId: randomUUID(), sessionId: "system-session" })).resolves.toMatchObject({ method: "session.resume" });
    expect(resumed).toBe(1);
    await expect(rpc.execute(principal, "session.clear", { commandId: randomUUID(), sessionId: "system-session" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects newer-client unsupported request options before durable acceptance", async () => {
    const f = await socketFixture(); cleanups.push(f.close);
    const c = await f.connect();
    const input = { commandId: randomUUID(), projectId: "project", title: "Skewed", workspaceStrategy: { kind: "current_checkout" as const }, initialMessage: { text: "hello", artifactIds: [] } };
    for (const frame of [
      { type: "request", requestId: "envelope", method: "session.launch", input, futureField: "unsupported" },
      { type: "request", requestId: "command", method: "session.launch", input: { ...input, futureField: "unsupported" } },
      { type: "request", requestId: "workspace", method: "session.launch", input: { ...input, workspaceStrategy: { ...input.workspaceStrategy, futureField: "unsupported" } } },
      { type: "request", requestId: "message", method: "session.launch", input: { ...input, initialMessage: { ...input.initialMessage, futureField: "unsupported" } } },
    ]) {
      c.socket.send(JSON.stringify(frame));
      expect(await c.next()).toMatchObject({ type: "error", requestId: frame.requestId, error: { code: "INVALID_INPUT" } });
    }
    expect(f.streams.database.prepare("SELECT COUNT(*) count FROM commands").get()).toEqual({ count: 0 });
    c.send({ type: "request", requestId: "known", method: "session.launch", input });
    expect(await c.next()).toMatchObject({ type: "result", requestId: "known", output: { commandId: input.commandId, state: "accepted" } });
  });

  it("routes launch/reconnect retry through the real durable control owner and publishes committed projections", async () => {
    const f = await socketFixture(); cleanups.push(f.close);
    const first = await f.connect();
    first.send({ type: "request", requestId: "shell", method: "shell.subscribe", input: {} });
    await first.next(); await first.next(); await first.next();
    const input = { commandId: randomUUID(), projectId: "project", title: "Controlled", workspaceStrategy: { kind: "current_checkout" as const }, initialMessage: { text: "hello", artifactIds: [] } };
    first.send({ type: "request", requestId: "launch", method: "session.launch", input });
    const accepted = await first.next(frame => frame.type === "result" && frame.requestId === "launch");
    expect(accepted).toMatchObject({ output: { commandId: input.commandId, state: "accepted" } });
    expect(await first.next(frame => frame.type === "stream")).toMatchObject({ item: { kind: "event", event: { type: "project.upsert" } } });
    first.socket.terminate();
    const retry = await f.connect();
    retry.send({ type: "request", requestId: "retry", method: "session.launch", input });
    expect(await retry.next()).toMatchObject({ type: "result", output: { commandId: input.commandId, state: "accepted" } });
    expect(f.streams.database.prepare("SELECT COUNT(*) count FROM commands WHERE device_session_id != 'core'").get()).toEqual({ count: 1 });
    await f.streams.core.effectWorker.drain();
    retry.send({ type: "request", requestId: "receipt", method: "command.get", input: { commandId: input.commandId } });
    expect(await retry.next()).toMatchObject({ type: "result", output: { state: "succeeded", delivery: "dispatched" } });
    expect(f.streams.database.prepare("SELECT COUNT(*) count FROM control_inputs").get()).toEqual({ count: 1 });
    expect(Object.values(loadState(f.streams.database).runs)).toEqual([expect.objectContaining({ commandId: input.commandId, state: "terminal", outcome: "completed" })]);
    expect(f.streams.database.prepare("SELECT COUNT(*) count FROM lifecycle_events WHERE event_type='input.accepted'").get()).toEqual({ count: 1 });
  });

  it("requires authenticated tickets and exact paths/protocol; HTTP ticket is authenticated", async () => {
    const f = await socketFixture(); cleanups.push(f.close);
    expect((await fetch(`${f.base}/ticket`)).status).toBe(401);
    expect((await fetch(`${f.base}/ticket`, { headers: { authorization: "Bearer test" } })).status).toBe(200);
    for (const path of ["/", "/ws", "/unexpected", "/api/v2/rpc", `/api/v2/rpc?ticket=${f.issueTicket()}`]) {
      const socket = new WebSocket(`${f.base.replace("http", "ws")}${path}`, "forge.v2");
      const status = await new Promise<number>(resolve => { socket.on("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); }); socket.on("error", () => {}); });
      expect(status).toBe(path.startsWith("/api/v2/rpc") ? 401 : 404);
    }
    const mismatch = new WebSocket(`${f.base.replace("http", "ws")}/api/v2/rpc`, ["forge.v2", `ticket.${f.issueTicket()}`], { headers: { "x-forge-environment-protocol": "1" } });
    const mismatchStatus = await new Promise<number>(resolve => { mismatch.on("unexpected-response", (_request, response) => { response.resume(); mismatch.terminate(); resolve(response.statusCode!); }); mismatch.on("error", () => {}); });
    expect(mismatchStatus).toBe(426);
    const ticket = f.issueTicket();
    const socket = new WebSocket(`${f.base.replace("http", "ws")}/api/v2/rpc`, ["forge.v2", `ticket.${ticket}`]);
    await once(socket, "open"); socket.terminate();
    const replay = new WebSocket(`${f.base.replace("http", "ws")}/api/v2/rpc`, ["forge.v2", `ticket.${ticket}`]);
    const status = await new Promise<number>(resolve => { replay.on("unexpected-response", (_request, response) => { response.resume(); replay.terminate(); resolve(response.statusCode!); }); replay.on("error", () => {}); });
    expect(status).toBe(401);
  });

  it("serves minimal health before pairing and keeps activity behind route authentication", async () => {
    const routes = createHealthRoutes({ resolveControlPidFile: () => "unused", allowReboot: false,
      swarmManager: { listAgents: () => [{ role: "manager", agentId: "session", status: "streaming", activeWorkerCount: 0 }] } as never,
    }) as EnvironmentHttpRoute[];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, "http://forge.invalid");
      const route = routes.find(route => route.methods === request.method && route.matches(url.pathname));
      if (!route || (!("public" in route.access) && request.headers.authorization !== "Bearer test")) {
        response.writeHead(401); response.end(); return;
      }
      await route.handle(request, response, url);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });
    expect(await (await fetch(`${base}/api/health`, { method: "HEAD" })).text()).toBe("");
    expect((await fetch(`${base}/api/activity`)).status).toBe(401);
    expect(await (await fetch(`${base}/api/activity`, { headers: { authorization: "Bearer test" } })).json()).toMatchObject({ swarm: { activeSessions: 1 } });
  });

  it("checks scope before input, validates output, and preserves accepted commands on cancel", async () => {
    let release!: () => void;
    let accepted = 0;
    const control: ControlService = {
      execute: async (_p, method, input) => { accepted++; await new Promise<void>(resolve => { release = resolve; }); return receipt(method, input.commandId); },
      getReceipt: async () => ({ broken: true }) as never,
    };
    const f = await socketFixture({ control }); cleanups.push(f.close);
    const readOnly = await f.connect({ ...principal, scopes: new Set(["session:read"]) });
    readOnly.send({ type: "request", requestId: "denied", method: "session.send", input: {} });
    expect(await readOnly.next()).toMatchObject({ type: "error", error: { code: "FORBIDDEN" } });
    const c = await f.connect();
    c.send({ type: "request", requestId: "bad", method: "session.send", input: {} });
    expect(await c.next()).toMatchObject({ type: "error", error: { code: "INVALID_INPUT" } });
    c.send({ type: "request", requestId: "output", method: "command.get", input: { commandId: randomUUID() } });
    expect(await c.next()).toMatchObject({ type: "error", error: { code: "INTERNAL" } });
    c.send({ type: "request", requestId: "send", method: "session.send", input: { commandId: randomUUID(), sessionId: "session", message: { text: "hello", artifactIds: [] } } });
    await new Promise(resolve => setTimeout(resolve, 20));
    c.send({ type: "cancel", requestId: "send" });
    c.send({ type: "ping", nonce: "after-cancel" });
    expect(await c.next()).toMatchObject({ type: "pong" }); expect(accepted).toBe(1);
    release();
    c.send({ type: "ping", nonce: "released" });
    expect(await c.next()).toMatchObject({ type: "pong" });
    expect(c.inbox.some(frame => "requestId" in frame && frame.requestId === "send")).toBe(false);
  });

  it("sends subscribe result first; queue overflow stops that stream with resync", async () => {
    const f = await socketFixture({ detailStream: {
      detail: async function* () { for (let i = 0; i < 400; i++) yield { kind: "synchronized", streamEpoch: "22222222-2222-2222-2222-222222222222", sequence: i }; },
      history: async () => { throw new Error(); }, content: async () => { throw new Error(); }, workers: async () => ({ workers: [], nextPage: null }),
    } }); cleanups.push(f.close);
    const c = await f.connect();
    c.send({ type: "request", requestId: "subscribe", method: "session.subscribe", input: { sessionId: "session" } });
    expect(await c.next()).toMatchObject({ type: "result", requestId: "subscribe" });
    expect(await c.next(frame => frame.type === "stream.error")).toMatchObject({ error: { code: "RESYNC_REQUIRED" } });
    c.send({ type: "ping", nonce: "alive" });
    expect(await c.next(frame => frame.type === "pong")).toMatchObject({ nonce: "alive" });
  });

  it("bounds pending requests, detail mounts and terminal mounts per socket", async () => {
    const releases: (() => void)[] = [];
    const f = await socketFixture({
      control: { execute: async (_p, method, input) => { await new Promise<void>(resolve => releases.push(resolve)); return receipt(method, input.commandId); }, getReceipt: async (_p, id) => receipt("session.send", id) },
      detailStream: { detail: async function* (_p, _input, signal) { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); },
        history: async () => { throw new Error(); }, workers: async () => ({ workers: [], nextPage: null }), content: async () => ({ text: "", nextOffset: null }) },
      terminalTransport: { attach: async function* (_p, _input, signal) { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); }, input: async () => ({}), resize: async () => ({}), closeDevice: async () => {} },
    }); cleanups.push(f.close);
    const c = await f.connect();
    for (let i = 0; i < 65; i++) c.send({ type: "request", requestId: `pending${i}`, method: "session.send", input: { commandId: randomUUID(), sessionId: "session", message: { text: "hello", artifactIds: [] } } });
    expect(await c.next()).toMatchObject({ type: "error", requestId: "pending64", error: { code: "RATE_LIMITED" } });
    releases.forEach(release => release());
    for (let i = 0; i < 64; i++) await c.next();
    for (let i = 0; i < 33; i++) {
      c.send({ type: "request", requestId: `detail${i}`, method: "session.subscribe", input: { sessionId: "session" } });
      expect(await c.next()).toMatchObject(i < 32 ? { type: "result" } : { type: "error", error: { code: "RATE_LIMITED" } });
    }
    for (let i = 0; i < 9; i++) {
      c.send({ type: "request", requestId: `terminal${i}`, method: "terminal.attach", input: { terminalId: "terminal", sessionId: "session", ticket: "test" } });
      expect(await c.next()).toMatchObject(i < 8 ? { type: "result" } : { type: "error", error: { code: "RATE_LIMITED" } });
    }
  });
});
