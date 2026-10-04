import { afterEach, describe, expect, it } from "vitest";
import { session, socketFixture, principal, streamFixture } from "../../ws/rpc/__tests__/fixtures.js";
import { decodeStreamItem } from "./wire-projection.js";
import type { RpcOutput, RpcServerFrame } from "@forge/protocol/environment-v2";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

describe("SQLite stream barrier through real socket", () => {
  it("stages every shell page at H, queues final page result before synchronized, then concurrent writes", async () => {
    const streams = await streamFixture();
    streams.sink.transaction(tx => { for (let i = 0; i < 1001; i++) streams.sink.append(tx, { topic: "shell", sessionId: null, event: { type: "session.upsert", session: session(`s${String(i).padStart(4, "0")}`) } }); });
    const f = await socketFixture({ shellStream: streams.shellStream, detailStream: streams.detailStream }); cleanups.push(async () => { await f.close(); streams.close(); });
    const c = await f.connect();
    c.send({ type: "request", requestId: "sub", method: "shell.subscribe", input: {} });
    const result = await c.next(); expect(result.type).toBe("result");
    const first = await c.next(frame => frame.type === "stream") as Extract<RpcServerFrame, { type: "stream" }>;
    const firstItem = first.item as { kind: string; sequence: number; snapshot: RpcOutput<"shell.page">["snapshot"] };
    expect(firstItem.sequence).toBe(1001); expect(firstItem.snapshot.sessions.length).toBe(500);
    streams.sink.transaction(tx => streams.sink.append(tx, { topic: "shell", sessionId: null, event: { type: "session.upsert", session: session("late") } }));
    let page = firstItem.snapshot.nextPage;
    let total = firstItem.snapshot.sessions.length;
    while (page) {
      c.send({ type: "request", requestId: "page", method: "shell.page", input: { page } });
      const frame = await c.next();
      expect(frame.type).toBe("result");
      const output = (frame as Extract<RpcServerFrame, { type: "result" }>).output as RpcOutput<"shell.page">;
      expect(output.sequence).toBe(1001); total += output.snapshot.sessions.length; page = output.snapshot.nextPage;
    }
    expect(total).toBe(1001);
    expect(await c.next()).toMatchObject({ type: "stream", item: { kind: "synchronized", sequence: 1001 } });
    expect(await c.next()).toMatchObject({ type: "stream", item: { kind: "event", sequence: 1002 } });
    await expect(streams.shellStream.shellPage(principal, { page: firstItem.snapshot.nextPage! })).rejects.toMatchObject({ code: "RESYNC_REQUIRED" });
  });

  it("replays at most 128 events and falls back for larger/stale/ahead cursors", async () => {
    const streams = await streamFixture();
    streams.sink.transaction(tx => { for (let i = 0; i < 130; i++) streams.sink.append(tx, { topic: "shell", sessionId: null, event: { type: "session.upsert", session: session("session", `title${i}`) } }); });
    const f = await socketFixture({ shellStream: streams.shellStream }); cleanups.push(async () => { await f.close(); streams.close(); });
    for (const [afterSequence, expected] of [[2, "event"], [1, "snapshot"], [131, "snapshot"]] as const) {
      const c = await f.connect();
      c.send({ type: "request", requestId: "sub", method: "shell.subscribe", input: { cursor: { streamEpoch: streams.sink.streamEpoch, afterSequence } } });
      await c.next();
      expect(await c.next()).toMatchObject({ type: "stream", item: { kind: expected } });
      c.socket.terminate();
    }
    streams.database.prepare("UPDATE environment_meta SET retained_after_sequence=100").run();
    const c = await f.connect();
    c.send({ type: "request", requestId: "sub", method: "shell.subscribe", input: { cursor: { streamEpoch: streams.sink.streamEpoch, afterSequence: 90 } } }); await c.next();
    expect(await c.next()).toMatchObject({ item: { kind: "snapshot" } });
  });

  it("rejects malformed known events; decoder advances unknown optional events", async () => {
    const streams = await streamFixture();
    const f = await socketFixture({ shellStream: streams.shellStream }); cleanups.push(async () => { await f.close(); streams.close(); });
    streams.sink.transaction(tx => streams.sink.append(tx, { topic: "shell", sessionId: null, event: { type: "session.upsert", session: session() } }));
    streams.database.prepare("UPDATE events SET payload_json=? WHERE sequence=1").run(JSON.stringify({ type: "session.upsert", session: { broken: true } }));
    const c = await f.connect(); c.send({ type: "request", requestId: "sub", method: "shell.subscribe", input: { cursor: { streamEpoch: streams.sink.streamEpoch, afterSequence: 0 } } });
    await c.next(); expect(await c.next()).toMatchObject({ type: "stream.error", error: { code: "RESYNC_REQUIRED" } });
    const envelope = { kind: "event", streamEpoch: streams.sink.streamEpoch, sequence: 7 };
    expect(decodeStreamItem("shell", { ...envelope, event: { type: "optional.telemetry", value: 1 } })).toMatchObject({ kind: "unknown", sequence: 7 });
    expect(() => decodeStreamItem("shell", { ...envelope, event: { type: "session.upsert", session: {} } })).toThrow();
  });
});
