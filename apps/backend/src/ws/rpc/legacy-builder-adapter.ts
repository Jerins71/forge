import { controlCommandId } from "./control-command-helpers.js";
import { legacySessionEventAllowlist, validateLegacySessionEvent, isBoundedLegacyValue as bounded, type ClientCommand, type ServerEvent } from "@forge/protocol";
export { legacySessionEventAllowlist, validateLegacySessionEvent } from "@forge/protocol";
import { rpcScopes, type Scope, type RpcInput, type RpcOutput, type RpcStreamItem } from "@forge/protocol/environment-v2";
import type { ControlService, EnvironmentAccessPort, Principal } from "../../environment/control/control-types.js";
import { StreamFault, StreamQueue, encodedBytes } from "../../environment/streams/stream-budget.js";
import { parseClientCommand } from "../ws-command-parser.js";

export const legacyCommandScopes = {
  subscribe: "unsupported", subscribe_inventory: "unsupported", api_proxy: "unsupported", ping: "session:read",
  user_message: "unsupported", create_session: "unsupported", stop_session: "unsupported", choice_response: "unsupported",
  kill_agent: "session:operate", stop_all_agents: "session:operate",

  resume_session: "session:operate", hydrate_archive_last_used: "session:read", archive_session: "session:operate", restore_session: "session:operate",
  delete_session: "session:operate", rename_session: "session:operate", pin_session: "session:operate", fork_session: "session:operate", clear_session: "session:operate", dismiss_session_attention: "session:operate",
  pin_message: "session:operate", clear_all_pins: "session:operate", get_session_workers: "unsupported",
  get_conversation_page: "unsupported",
  choice_cancel: "session:operate",
  mark_unread: "session:operate", mark_all_read: "session:operate",
  // Host commands use browser.host.send on the socket that holds the browser.host.attach subscription.
  browser_host_register: "unsupported", browser_host_hydrate: "unsupported", browser_host_focus: "unsupported", browser_host_response: "unsupported",
  browser_host_state_report: "unsupported", browser_host_lifecycle_response: "unsupported", browser_panel_reveal_acknowledge: "session:operate",
  browser_tab_open: "session:operate", browser_tab_activate: "session:operate", browser_tab_close: "session:operate", browser_tab_resize: "session:operate",
  browser_recording_start: "session:operate", browser_recording_stop: "session:operate",
} as const satisfies Record<ClientCommand["type"], Scope | "unsupported">;

/** Remove a literal when its authoritative feature projection migrates to V2. */
type LegacyType = typeof legacySessionEventAllowlist[number];
type LegacyMethod = "legacy.session.read" | "legacy.session.operate" | "legacy.workspace.read" | "legacy.workspace.write" | "legacy.settings.admin";

export interface LegacyHandlerPorts {
  executeCommand(input: { principal: Principal; sessionId: string; command: ClientCommand; signal: AbortSignal; send(event: ServerEvent): void }): Promise<void>;
  featureState(sessionId: string, signal: AbortSignal): Promise<ServerEvent[]>;
  subscribeFeatures(sessionId: string, listener: (event: ServerEvent) => void): () => void;
}

export interface LegacyBuilderAdapter {
  execute(principal: Principal, method: LegacyMethod, input: RpcInput<LegacyMethod>, signal: AbortSignal): Promise<RpcOutput<LegacyMethod>>;
  subscribe(principal: Principal, input: RpcInput<"legacy.session.subscribe">, signal: AbortSignal): AsyncIterable<RpcStreamItem<"legacy.session.subscribe">>;
}

export function createLegacyBuilderAdapter({ access, ports }: { access: EnvironmentAccessPort; ports: LegacyHandlerPorts }): LegacyBuilderAdapter {
  async function execute(principal: Principal, method: LegacyMethod, input: RpcInput<LegacyMethod>, signal: AbortSignal): Promise<RpcOutput<LegacyMethod>> {
    const parsed = parseClientCommand(Buffer.from(JSON.stringify(input.command)));
    if (!parsed.ok) throw new StreamFault("INVALID_INPUT", "Invalid legacy command.");
    const scope = legacyCommandScopes[parsed.command.type];
    if (scope === "unsupported" || scope !== rpcScopes[method]) throw new StreamFault("FORBIDDEN", "Legacy command is not allowed in this scope.");
    // Session commands are addressed to one session; workspace and settings commands (folders, new projects) need none.
    const sessionScoped = method === "legacy.session.read" || method === "legacy.session.operate";
    if (sessionScoped && !input.sessionId) throw new StreamFault("INVALID_INPUT", "Legacy commands require an addressed session.");
    const command = parsed.command as ClientCommand & Record<string, unknown>;
    if (input.sessionId) for (const field of ["agentId", "sessionAgentId", "managerId", "sourceAgentId"] as const) if (command[field] !== undefined && command[field] !== input.sessionId) throw new StreamFault("FORBIDDEN", "Legacy command targets another session.");
    access.authorize(principal, [scope]);
    const events: Record<string, unknown>[] = [];
    let bytes = 0;
    await ports.executeCommand({ principal, sessionId: input.sessionId ?? "", command: parsed.command, signal, send(event) {
      bytes += encodedBytes(event);
      if (events.length >= 64 || bytes > 512 * 1024 || !bounded(event)) throw new StreamFault("PAYLOAD_TOO_LARGE", "Legacy response exceeds budget.");
      events.push(event as unknown as Record<string, unknown>);
    } });
    return { events };
  }

  async function* subscribe(principal: Principal, input: RpcInput<"legacy.session.subscribe">, signal: AbortSignal) {
    access.authorize(principal, ["session:read"]);
    const queue = new StreamQueue<RpcStreamItem<"legacy.session.subscribe">>();
    const buffered = new StreamQueue<RpcStreamItem<"legacy.session.subscribe">>(error => queue.fail(error));
    let initialized = false;
    const coalesced = new Map<string, ServerEvent>();
    let timer: NodeJS.Timeout | undefined;
    const send = (event: ServerEvent) => {
      if (!legacySessionEventAllowlist.includes(event.type as LegacyType)) return;
      if (!validateLegacySessionEvent(event, input.sessionId)) { queue.fail(new StreamFault("RESYNC_REQUIRED", "Invalid legacy feature event.")); return; }
      (initialized ? queue : buffered).push({ type: event.type, payload: event });
    };
    const unsubscribe = ports.subscribeFeatures(input.sessionId, event => {
      if (event.type !== "generation_throughput" && event.type !== "manager_tool_activity") { send(event); return; }
      const key = event.type === "generation_throughput" ? `${event.type}:${event.measurement.agentId}` : event.type;
      if (coalesced.size >= 100 && !coalesced.has(key)) { queue.fail(new StreamFault("RESYNC_REQUIRED", "Too many transient actors.")); return; }
      coalesced.set(key, event);
      timer ??= setTimeout(() => { timer = undefined; for (const event of coalesced.values()) send(event); coalesced.clear(); }, 50);
    });
    const abort = () => { unsubscribe(); queue.end(); buffered.end(); if (timer) clearTimeout(timer); coalesced.clear(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) return;
      const initial = await ports.featureState(input.sessionId, signal);
      initialized = true;
      for (const event of initial) send(event);
      buffered.end();
      for await (const item of buffered) queue.push(item);
      yield* queue;
    } finally { signal.removeEventListener("abort", abort); abort(); }
  }
  return { execute, subscribe };
}

export async function executeMigratedLegacyCommand(control: ControlService, principal: Principal, command: ClientCommand, sessionId: string) {
  switch (command.type) {
    case "create_session":
      if (command.sessionPurpose) throw new StreamFault("UNAVAILABLE", "Controlled session purpose is unsupported.");
      return control.execute(principal, "session.launch", { commandId: controlCommandId(principal, "session.launch", command.requestId), projectId: command.profileId,
        title: command.label ?? command.name ?? "New session", workspaceStrategy: { kind: "current_checkout" } });
    case "user_message":
      if (command.attachments?.length || command.replyTo || command.delivery && command.delivery !== "auto" || command.sessionReferenceAgentIds?.length) throw new StreamFault("UNAVAILABLE", "This legacy message needs the typed V2 input path.");
      return control.execute(principal, "session.send", { commandId: controlCommandId(principal, "session.send", command.clientRequestId), sessionId: command.agentId ?? sessionId, message: { text: command.text, artifactIds: [] } });
    case "choice_response": return control.execute(principal, "session.choose", { commandId: controlCommandId(principal, "session.choose"), sessionId: command.agentId, choiceId: command.choiceId, answers: command.answers });
    case "stop_session": return control.execute(principal, "session.stop", { commandId: controlCommandId(principal, "session.stop", command.requestId), sessionId: command.agentId });
    default: throw new StreamFault("INVALID_INPUT", "Not a migrated command.");
  }
}
