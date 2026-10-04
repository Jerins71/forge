import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcServerFrame, RpcStreamItem } from "@forge/protocol/environment-v2";
import { principal, socketFixture } from "../ws/rpc/__tests__/fixtures.js";
import { TerminalService } from "./terminal-service.js";
import { TerminalPersistence, type StoredTerminalMeta } from "./terminal-persistence.js";
import { createTerminalRpcTransport } from "./terminal-rpc-transport.js";
import { readTerminalRuntimeConfig } from "./terminal-config.js";
import type { TerminalPtyHandle, TerminalPtyRuntime, TerminalPtySpawnRequest } from "./terminal-pty-runtime.js";
import { getTerminalMetaPath, getTerminalSnapshotPath } from "../swarm/data-paths.js";

class FakePty implements TerminalPtyRuntime {
  handles: (TerminalPtyHandle & { request: TerminalPtySpawnRequest; inputs: string[]; killed: boolean })[] = [];
  async isAvailable() { return true; }
  async spawnPty(request: TerminalPtySpawnRequest) {
    const handle = { pid: 1234 + this.handles.length, shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh", shellArgs: [],
      request, inputs: [] as string[], killed: false,
      write(data: Buffer | string) { this.inputs.push(data.toString()); }, resize() {}, kill() { this.killed = true; }, async dispose() {} };
    this.handles.push(handle); return handle;
  }
  async resizePty(handle: TerminalPtyHandle, cols: number, rows: number) { handle.resize(cols, rows); }
  async killPty(handle: TerminalPtyHandle) { handle.kill(); }
  isTerminalDeadError() { return false; }
  async cleanupOrphanedProcesses() { return 0; }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

async function terminalFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-terminal-rpc-"));
  const runtimeConfig = await readTerminalRuntimeConfig({ env: {}, persistedSettings: {} });
  const pty = new FakePty();
  const persistence = new TerminalPersistence({ dataDir, scrollbackLines: 5000, journalMaxBytes: 1024 * 1024 });
  const newService = () => new TerminalService({ dataDir, runtimeConfig, ptyRuntime: pty, persistence,
    sessionResolver: { resolveSession: id => id === "session" ? { sessionAgentId: id, profileId: "project", cwd: dataDir } : undefined,
      listSessions: () => [{ sessionAgentId: "session", profileId: "project", cwd: dataDir }] },
    cwdPolicy: { rootDir: dataDir, allowlistRoots: [] } });
  const service = newService();
  await service.initialize();
  return { service, newService, pty, persistence, dataDir };
}

describe("terminal over environment RPC", () => {
  it("chunks a VT snapshot, sends UTF-8 offsets, deduplicates input and detaches without killing host terminal", async () => {
    const t = await terminalFixture();
    const transport = createTerminalRpcTransport({ terminalService: t.service });
    const host = await t.service.create({ sessionAgentId: "session", name: "host" });
    const text = "😀".repeat(750_000); // More than the socket queue: replay must be streamed in chunks.
    await writeFile(getTerminalSnapshotPath(t.dataDir, "project", "session", host.terminal.terminalId), text);
    const f = await socketFixture({ terminalTransport: transport });
    cleanups.push(async () => { await f.close(); await t.service.shutdown(); await rm(t.dataDir, { recursive: true, force: true }); });
    const c = await f.connect();
    const ticket = transport.issueTicket(principal, host.terminal.terminalId, "session");
    c.send({ type: "request", requestId: "attach", method: "terminal.attach", input: { terminalId: host.terminal.terminalId, sessionId: "session", ticket: ticket.ticket } });
    const result = await c.next() as Extract<RpcServerFrame, { type: "result" }>;
    expect(result.type).toBe("result");
    const subscriptionId = (result.output as { subscriptionId: string }).subscriptionId;
    let replay = "";
    let final = false;
    let part = 0;
    while (!final) {
      const frame = await c.next() as Extract<RpcServerFrame, { type: "stream" }>;
      const item = frame.item as Extract<RpcStreamItem<"terminal.attach">, { kind: "snapshot" }>;
      expect(Buffer.byteLength(item.data)).toBeLessThanOrEqual(32_768);
      expect(item.kind).toBe("snapshot"); expect(item.part).toBe(part++); expect(item.offset).toBe(Buffer.byteLength(replay));
      replay += item.data; final = item.final;
    }
    expect(part).toBeGreaterThan(1); expect(replay).toBe(text);
    await t.pty.handles[0].request.onData(Buffer.from("hello😀"));
    expect(await c.next()).toMatchObject({ type: "stream", item: { kind: "output", offset: Buffer.byteLength(text), data: "hello😀" } });
    const inputId = randomUUID();
    for (let i = 0; i < 2; i++) {
      c.send({ type: "request", requestId: `input${i}`, method: "terminal.input", input: { subscriptionId, inputId, data: "pwd\n" } });
      expect(await c.next()).toMatchObject({ type: "result" });
    }
    expect(t.pty.handles[0].inputs).toEqual(["pwd\n"]);
    c.send({ type: "unsubscribe", subscriptionId });
    c.send({ type: "request", requestId: "detached", method: "terminal.input", input: { subscriptionId, inputId: randomUUID(), data: "x" } });
    expect(await c.next()).toMatchObject({ type: "error", error: { code: "NOT_FOUND" } });
    expect(t.pty.handles[0].killed).toBe(false);
    c.send({ type: "request", requestId: "reattach", method: "terminal.attach", input: { terminalId: host.terminal.terminalId, sessionId: "session", ticket: transport.issueTicket(principal, host.terminal.terminalId, "session").ticket } });
    expect(await c.next()).toMatchObject({ type: "result" });
    let restored = "";
    final = false;
    while (!final) {
      const frame = await c.next() as Extract<RpcServerFrame, { type: "stream" }>;
      const item = frame.item as Extract<RpcStreamItem<"terminal.attach">, { kind: "snapshot" }>;
      restored += item.data; final = item.final;
    }
    expect(restored).toBe(text + "hello😀");
  });

  it("persists creator ownership across restart and revocation kills only device-created PTYs", async () => {
    const t = await terminalFixture();
    const owned = await t.service.create({ sessionAgentId: "session", name: "device" }, principal.deviceSessionId);
    const host = await t.service.create({ sessionAgentId: "session", name: "host" });
    const metaPath = getTerminalMetaPath(t.dataDir, "project", "session", owned.terminal.terminalId);
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as StoredTerminalMeta;
    expect(meta.creatorDeviceSessionId).toBe(principal.deviceSessionId);
    expect((await t.persistence.loadMeta(metaPath) as StoredTerminalMeta).creatorDeviceSessionId).toBe(principal.deviceSessionId);
    const hostMetaPath = getTerminalMetaPath(t.dataDir, "project", "session", host.terminal.terminalId);
    const hostMeta = JSON.parse(await readFile(hostMetaPath, "utf8"));
    await t.service.shutdown();
    // Restore the pre-shutdown rows to model a crash with live PTYs.
    await writeFile(metaPath, JSON.stringify(meta));
    await writeFile(hostMetaPath, JSON.stringify(hostMeta));
    t.service = t.newService();
    await t.service.initialize();
    expect(t.pty.handles.length).toBe(4);
    const transport = createTerminalRpcTransport({ terminalService: t.service });
    const f = await socketFixture({ terminalTransport: transport });
    cleanups.push(async () => { await f.close(); await t.service.shutdown(); await rm(t.dataDir, { recursive: true, force: true }); });
    const c = await f.connect();
    c.send({ type: "request", requestId: "attach", method: "terminal.attach", input: { terminalId: host.terminal.terminalId, sessionId: "session", ticket: transport.issueTicket(principal, host.terminal.terminalId, "session").ticket } });
    await c.next(); await c.next();
    await f.rpc.closeDevice(principal.deviceSessionId);
    expect(t.pty.handles[2].killed).toBe(true); expect(t.pty.handles[3].killed).toBe(false);
    expect(JSON.parse(await readFile(metaPath, "utf8")).creatorDeviceSessionId).toBe(principal.deviceSessionId);
  });

  it("rejects a terminal ticket bound to a different device/session and ticket replay", async () => {
    const t = await terminalFixture(); const transport = createTerminalRpcTransport({ terminalService: t.service });
    const host = await t.service.create({ sessionAgentId: "session" });
    const f = await socketFixture({ terminalTransport: transport });
    cleanups.push(async () => { await f.close(); await t.service.shutdown(); await rm(t.dataDir, { recursive: true, force: true }); });
    const c = await f.connect({ ...principal, deviceSessionId: randomUUID() });
    const ticket = transport.issueTicket(principal, host.terminal.terminalId, "session").ticket;
    c.send({ type: "request", requestId: "attach", method: "terminal.attach", input: { terminalId: host.terminal.terminalId, sessionId: "session", ticket } });
    await c.next(); expect(await c.next()).toMatchObject({ type: "stream.error", error: { code: "UNAUTHENTICATED" } });
    const owner = await f.connect();
    owner.send({ type: "request", requestId: "replayed", method: "terminal.attach", input: { terminalId: host.terminal.terminalId, sessionId: "session", ticket } });
    await owner.next(); expect(await owner.next()).toMatchObject({ type: "stream.error", error: { code: "UNAUTHENTICATED" } });
  });
});
