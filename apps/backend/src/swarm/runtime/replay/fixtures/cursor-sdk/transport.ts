import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import type { CursorSdkModule, CursorSdkSendOptions } from "../../../cursor-sdk/cursor-sdk-loader.js";

/** Only the SDK API transport is substituted. The runtime, mapper, host and MCP listener stay real. */
export async function cursorReplayTransport(port: number) {
  const socket = createConnection({ host: "127.0.0.1", port });
  const inbox: Array<Record<string, any>> = [];
  let waiter: ((value: Record<string, any>) => void) | undefined;
  let closed = false;
  let failClose = false;
  let failCancel = false;
  const received = (frame: Record<string, any>) => {
    if (waiter) { const resolve = waiter; waiter = undefined; resolve(frame); }
    else inbox.push(frame);
  };
  createInterface({ input: socket }).on("line", line => {
    const parsed = JSON.parse(line);
    if (parsed.frame) received(parsed.frame);
    else if (parsed.exit !== undefined) received({ failure: "Cursor SDK transport exited" });
  });
  socket.on("error", error => received({ failure: error.message }));
  socket.on("close", () => { closed = true; received({ failure: "Cursor SDK transport closed" }); });
  await new Promise<void>(resolve => socket.once("connect", resolve));
  socket.write(JSON.stringify({ hello: true }) + "\n");
  const outbound = (frame: unknown) => socket.write(JSON.stringify({ frame }) + "\n");
  const next = async () => {
    const frame = inbox.shift() ?? (closed ? { failure: "transport closed" } : await new Promise<Record<string, any>>(resolve => { waiter = resolve; }));
    if (frame.failure) throw new Error(frame.failure);
    return frame;
  };
  const payloads: Array<string | { text: string; images?: unknown[] }> = [];
  const mcpUrls: string[] = [];
  const agent = async () => {
    const { agentId } = await next();
    return {
      agentId,
      async send(payload: Parameters<import("../../../cursor-sdk/cursor-sdk-loader.js").CursorSdkAgent["send"]>[0], options?: CursorSdkSendOptions) {
        payloads.push(payload);
        for (const config of Object.values(options?.mcpServers ?? {})) if ("url" in config) mcpUrls.push(config.url);
        outbound({ method: "agent/send", promptSha256: createHash("sha256").update(typeof payload === "string" ? payload : payload.text).digest("hex") });
        const { run } = await next();
        let status: "running" | "finished" | "cancelled" = "running";
        return { ...run, get status() { return status; },
          async *stream() {
            for (;;) {
              const frame = await next();
              if (frame.streamEnd) return;
              if (frame.delta) options?.onDelta?.({ update: frame.delta });
              if (frame.message) yield frame.message;
            }
          },
          async wait() { outbound({ method: "run/wait", runId: run.id }); const frame = await next(); status = frame.result.status; return frame.result; },
          async cancel() { if (failCancel) { failCancel = false; throw new Error("synthetic cancel transport failure"); } outbound({ method: "run/cancel", runId: run.id }); status = "cancelled"; },
        };
      },
      close() { if (failClose) { failClose = false; throw new Error("synthetic SDK close failure"); } outbound({ method: "agent/close", agentId }); },
    };
  };
  const sdk: CursorSdkModule = { Agent: {
    async create(options) { outbound({ method: "agent/create", settingSources: options.local?.settingSources, model: options.model }); return agent(); },
    async resume(agentId, options) { outbound({ method: "agent/resume", agentId, settingSources: options?.local?.settingSources, model: options?.model }); return agent(); },
  }, Cursor: { models: { async list() { return []; } } } };
  return { sdk, payloads, mcpUrls, failNextClose() { failClose = true; }, failNextCancel() { failCancel = true; }, close() { socket.destroy(); } };
}
