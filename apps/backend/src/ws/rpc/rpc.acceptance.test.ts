import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createLegacyBuilderAdapter } from "./legacy-builder-adapter.js";
import { socketFixture, principal, receipt } from "./__tests__/fixtures.js";
import type { ControlService } from "../../environment/control/control-types.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

describe("environment RPC real socket boundary", () => {
  it("requires authenticated tickets and exact paths/protocol; HTTP ticket is authenticated", async () => {
    const f = await socketFixture(); cleanups.push(f.close);
    expect((await fetch(`${f.base}/ticket`)).status).toBe(401);
    expect((await fetch(`${f.base}/ticket`, { headers: { authorization: "Bearer test" } })).status).toBe(200);
    for (const path of ["/", "/ws", "/unexpected", "/api/v2/rpc?protocolVersion=1", `/api/v2/rpc?protocolVersion=2&ticket=${f.issueTicket()}`]) {
      const socket = new WebSocket(`${f.base.replace("http", "ws")}${path}`, "forge.v2");
      const status = await new Promise<number>(resolve => { socket.on("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); }); socket.on("error", () => {}); });
      expect(status).toBe(path.startsWith("/api/v2/rpc") ? path.includes("Version=2") ? 426 : 401 : 404);
    }
    const ticket = f.issueTicket();
    const socket = new WebSocket(`${f.base.replace("http", "ws")}/api/v2/rpc?protocolVersion=1&ticket=${ticket}`, "forge.v2");
    await once(socket, "open"); socket.terminate();
    const replay = new WebSocket(`${f.base.replace("http", "ws")}/api/v2/rpc?protocolVersion=1&ticket=${ticket}`, "forge.v2");
    const status = await new Promise<number>(resolve => { replay.on("unexpected-response", (_request, response) => { response.resume(); replay.terminate(); resolve(response.statusCode!); }); replay.on("error", () => {}); });
    expect(status).toBe(401);
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

  it("generic legacy adapter rejects migrated commands, cross-session and scope mismatches", async () => {
    const f = await socketFixture(); cleanups.push(f.close);
    const adapter = createLegacyBuilderAdapter({ access: f.access, ports: {
      executeCommand: async ({ send }) => send({ type: "error", code: "EXAMPLE", message: "test" }),
      featureState: async () => [], subscribeFeatures: () => () => {},
    } });
    const signal = new AbortController().signal;
    await expect(adapter.execute(principal, "legacy.session.operate", { sessionId: "session", command: { type: "user_message", text: "hello" } }, signal)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adapter.execute(principal, "legacy.workspace.read", { sessionId: "session", command: { type: "rename_session", agentId: "session", label: "new" } }, signal)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adapter.execute(principal, "legacy.session.operate", { sessionId: "session", command: { type: "rename_session", agentId: "other", label: "new" } }, signal)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await adapter.execute(principal, "legacy.session.operate", { sessionId: "session", command: { type: "rename_session", agentId: "session", label: "new" } }, signal)).toMatchObject({ events: [{ type: "error" }] });
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
