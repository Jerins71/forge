import { createHash, randomBytes, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { RpcInput, RpcOutput, RpcStreamItem } from "@forge/protocol/environment-v2";
import type { Principal } from "../environment/control/control-types.js";
import { StreamFault, StreamQueue } from "../environment/streams/stream-budget.js";
import type { TerminalService } from "./terminal-service.js";

type Frame = RpcStreamItem<"terminal.attach">;
interface Ticket { deviceSessionId: string; terminalId: string; sessionId: string; expiresAt: number }
interface Attachment { principal: Principal; terminalId: string; sessionId: string; inputIds: Map<string, string>; detach(): void }

export interface TerminalRpcTransport {
  attach(principal: Principal, input: RpcInput<"terminal.attach">, signal: AbortSignal, subscriptionId: string): AsyncIterable<Frame>;
  input(principal: Principal, input: RpcInput<"terminal.input">): Promise<RpcOutput<"terminal.input">>;
  resize(principal: Principal, input: RpcInput<"terminal.resize">): Promise<RpcOutput<"terminal.resize">>;
  closeDevice(deviceSessionId: string): Promise<void>;
}

/** Existing HTTP terminal lifecycle issues this opaque device/session-bound ticket. */
export function createTerminalRpcTransport({ terminalService }: { terminalService: TerminalService }) {
  const tickets = new Map<string, Ticket>();
  const attachments = new Map<string, Attachment>();

  function issueTicket(principal: Principal, terminalId: string, sessionId: string) {
    for (const [key, value] of tickets) if (value.expiresAt <= Date.now()) tickets.delete(key);
    if (tickets.size >= 256) throw new StreamFault("RATE_LIMITED", "Terminal ticket capacity reached.");
    if (!principal.scopes.has("terminal:operate")) throw new StreamFault("FORBIDDEN", "Terminal scope required.");
    if (!terminalService.getTerminal({ terminalId, sessionAgentId: sessionId })) throw new StreamFault("NOT_FOUND", "Unknown terminal.");
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 30_000;
    tickets.set(ticket, { deviceSessionId: principal.deviceSessionId, terminalId, sessionId, expiresAt });
    return { ticket, ticketExpiresAt: new Date(expiresAt).toISOString() };
  }

  async function* attach(principal: Principal, input: RpcInput<"terminal.attach">, signal: AbortSignal, subscriptionId: string): AsyncGenerator<Frame> {
    const ticket = tickets.get(input.ticket);
    tickets.delete(input.ticket);
    if (!ticket || ticket.expiresAt <= Date.now() || ticket.deviceSessionId !== principal.deviceSessionId || ticket.terminalId !== input.terminalId || ticket.sessionId !== input.sessionId) throw new StreamFault("UNAUTHENTICATED", "Invalid terminal ticket.");
    if (signal.aborted) return;
    let failure: Error | undefined;
    const queue = new StreamQueue<Frame>(error => { failure = error instanceof Error ? error : new StreamFault("RESYNC_REQUIRED", "Terminal replay failed."); });
    let detach = () => {};
    let snapshotReplay = "";
    let offset = 0;
    const decoder = new StringDecoder("utf8");
    const abort = () => { detach(); attachments.delete(subscriptionId); queue.end(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      attachments.set(subscriptionId, { principal, terminalId: input.terminalId, sessionId: input.sessionId, inputIds: new Map(), detach: abort });
      detach = await terminalService.attachRpcClient({
        terminalId: input.terminalId, sessionAgentId: input.sessionId,
        onSnapshot: replay => {
          // Capture immutable VT replay while the existing owner installs the live attachment.
          snapshotReplay = replay.toString("utf8");
          offset = Buffer.byteLength(snapshotReplay);
        },
        onData: chunk => {
          for (const data of splitUtf8(decoder.write(chunk), 8192)) {
            if (!data) continue;
            queue.push({ kind: "output", offset, data });
            offset += Buffer.byteLength(data);
          }
        },
        onControl: message => {
          if (message.type === "closed" || message.type === "exit") {
            queue.push({ kind: "closed", reason: message.type === "closed" ? message.reason : "exited" });
            queue.end();
          } else if (message.type === "error") queue.fail(new StreamFault("UNAVAILABLE", "Terminal unavailable."));
        },
      });
      if (signal.aborted) return;
      const snapshotId = randomUUID();
      const parts = splitUtf8(snapshotReplay, 32_768);
      let current = parts.next();
      let part = 0;
      let snapshotOffset = 0;
      while (!current.done) {
        if (signal.aborted) return;
        if (failure) throw failure;
        const next = parts.next();
        const data = current.value;
        yield { kind: "snapshot", snapshotId, part: part++, final: next.done === true, offset: snapshotOffset, data };
        snapshotOffset += Buffer.byteLength(data);
        current = next;
        // Give the socket scheduler a turn between replay parts; slow sockets still hit its cap.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      snapshotReplay = "";
      yield* queue;
    } finally { signal.removeEventListener("abort", abort); abort(); }
  }

  function requireAttachment(principal: Principal, id: string): Attachment {
    const attachment = attachments.get(id);
    if (!attachment || attachment.principal !== principal) throw new StreamFault("NOT_FOUND", "Unknown terminal attachment.");
    return attachment;
  }

  async function input(principal: Principal, input: RpcInput<"terminal.input">): Promise<RpcOutput<"terminal.input">> {
    const attachment = requireAttachment(principal, input.subscriptionId);
    const digest = createHash("sha256").update(input.data).digest("hex");
    const previous = attachment.inputIds.get(input.inputId);
    if (previous !== undefined) {
      if (previous !== digest) throw new StreamFault("CONFLICT", "Terminal input identity reused with different data.");
      return {};
    }
    if (attachment.inputIds.size >= 4096) throw new StreamFault("RESYNC_REQUIRED", "Terminal input identity budget exhausted. Reattach.");
    attachment.inputIds.set(input.inputId, digest);
    await terminalService.handleInput(attachment.terminalId, input.data, attachment.sessionId);
    return {};
  }

  async function resize(principal: Principal, input: RpcInput<"terminal.resize">): Promise<RpcOutput<"terminal.resize">> {
    const attachment = requireAttachment(principal, input.subscriptionId);
    await terminalService.resize(attachment.terminalId, attachment.sessionId, input.cols, input.rows);
    return {};
  }

  async function closeDevice(deviceSessionId: string) {
    for (const [key, ticket] of tickets) if (ticket.deviceSessionId === deviceSessionId) tickets.delete(key);
    for (const attachment of attachments.values()) if (attachment.principal.deviceSessionId === deviceSessionId) attachment.detach();
    await terminalService.revokeDevice(deviceSessionId);
  }

  return { attach, input, resize, closeDevice, issueTicket };
}

function* splitUtf8(text: string, maxBytes: number): Generator<string> {
  let part = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) { yield part; part = ""; bytes = 0; }
    part += character;
    bytes += size;
  }
  yield part;
}
