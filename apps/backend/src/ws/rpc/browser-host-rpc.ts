import { randomUUID } from "node:crypto";
import type { BrowserClientCommand, ServerEvent } from "@forge/protocol";
import type { RpcInput, RpcOutput, RpcStreamItem } from "@forge/protocol/environment-v2";
import type { Principal } from "../../environment/control/control-types.js";
import { StreamFault, StreamQueue } from "../../environment/streams/stream-budget.js";
import { parseClientCommand } from "../ws-command-parser.js";

const hostCommandTypes = [
  "browser_host_register", "browser_host_hydrate", "browser_host_focus", "browser_host_response",
  "browser_host_state_report", "browser_host_lifecycle_response",
] as const satisfies readonly BrowserClientCommand["type"][];
type BrowserHostCommand = Extract<BrowserClientCommand, { type: typeof hostCommandTypes[number] }>;
type Item = RpcStreamItem<"browser.host.attach">;

// One registered maximum-size response per transfer; a renderer answers a few requests at once.
const MAX_TRANSFERS = 8;
const MAX_BUFFERED_CHARS = 32 * 1024 * 1024;

interface Attachment {
  connectionId: string;
  queue: StreamQueue<Item>;
  transfers: Map<string, { count: number; parts: string[] }>;
  bufferedChars: number;
}

export interface BrowserHostRpc {
  attach(principal: Principal, signal: AbortSignal): AsyncIterable<Item>;
  send(principal: Principal, input: RpcInput<"browser.host.send">): RpcOutput<"browser.host.send">;
  /** The browser host connection attached on this principal's socket, if any. */
  connectionId(principal: Principal): string | undefined;
  /** Host changes reach every attached Desktop. */
  broadcast(event: ServerEvent): void;
}

/**
 * The embedded browser host over one RPC socket. The attach subscription is the host connection:
 * host commands on the same socket act as that connection, and ending it unregisters the host.
 */
export function createBrowserHostRpc(deps: {
  handle(input: { command: BrowserHostCommand; connectionId: string; send(event: ServerEvent): void }): Promise<void>;
  detach(connectionId: string): void;
}): BrowserHostRpc {
  // The RPC server gives each socket its own principal object.
  const attachments = new Map<Principal, Attachment>();

  async function* attach(principal: Principal, signal: AbortSignal): AsyncGenerator<Item> {
    const attachment: Attachment = { connectionId: randomUUID(), queue: new StreamQueue<Item>(), transfers: new Map(), bufferedChars: 0 };
    const end = () => attachment.queue.end();
    signal.addEventListener("abort", end, { once: true });
    attachments.set(principal, attachment);
    try {
      if (signal.aborted) return;
      attachment.queue.push({ kind: "attached" });
      yield* attachment.queue;
    } finally {
      signal.removeEventListener("abort", end);
      if (attachments.get(principal) === attachment) attachments.delete(principal);
      deps.detach(attachment.connectionId);
    }
  }

  function send(principal: Principal, input: RpcInput<"browser.host.send">): RpcOutput<"browser.host.send"> {
    const attachment = attachments.get(principal);
    if (!attachment) throw new StreamFault("UNAVAILABLE", "Browser host is not attached on this connection.");
    let transfer = attachment.transfers.get(input.transferId);
    if (!transfer && input.index === 0 && attachment.transfers.size < MAX_TRANSFERS) {
      attachment.transfers.set(input.transferId, transfer = { count: input.count, parts: [] });
    }
    const drop = () => {
      for (const part of transfer?.parts ?? []) attachment.bufferedChars -= part.length;
      attachment.transfers.delete(input.transferId);
    };
    if (!transfer || transfer.count !== input.count || transfer.parts.length !== input.index
      || attachment.bufferedChars + input.data.length > MAX_BUFFERED_CHARS) {
      drop();
      throw new StreamFault("INVALID_INPUT", "Invalid browser host command transfer.");
    }
    transfer.parts.push(input.data);
    attachment.bufferedChars += input.data.length;
    if (transfer.parts.length < transfer.count) return {};
    const text = transfer.parts.join("");
    drop();
    const parsed = parseClientCommand(Buffer.from(text));
    if (!parsed.ok || !(hostCommandTypes as readonly string[]).includes(parsed.command.type)) {
      throw new StreamFault("INVALID_INPUT", "Not a browser host command.");
    }
    const command = parsed.command as BrowserHostCommand;
    const push = (event: ServerEvent) => attachment.queue.push({ kind: "event", event: event as unknown as Record<string, unknown> });
    // Results are host events on the stream; registration can outlast an RPC request while a replaced host is released.
    void deps.handle({ command, connectionId: attachment.connectionId, send: push }).catch(error => {
      if ("requestId" in command) push({ type: "error", code: `${command.type.toUpperCase()}_FAILED`, message: error instanceof Error ? error.message : String(error), requestId: command.requestId });
    });
    return {};
  }

  return {
    attach, send,
    connectionId: principal => attachments.get(principal)?.connectionId,
    broadcast: event => { for (const attachment of attachments.values()) attachment.queue.push({ kind: "event", event: event as unknown as Record<string, unknown> }); },
  };
}
