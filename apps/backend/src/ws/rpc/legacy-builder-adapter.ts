import { createHash, randomUUID } from "node:crypto";
import type { ClientCommand, ServerEvent } from "@forge/protocol";
import { rpcScopes, type Scope, type RpcInput, type RpcOutput, type RpcStreamItem, type CommandReceipt } from "@forge/protocol/environment-v2";
import type { ControlService, EnvironmentAccessPort, Principal } from "../../environment/control/control-types.js";
import { StreamFault, StreamQueue, encodedBytes, EVENT_BYTES } from "../../environment/streams/stream-budget.js";
import { parseClientCommand } from "../ws-command-parser.js";

export const legacyCommandScopes = {
  subscribe: "unsupported", subscribe_inventory: "unsupported", api_proxy: "unsupported", ping: "session:read",
  user_message: "unsupported", create_session: "unsupported", stop_session: "unsupported", choice_response: "unsupported",
  resume_restart_recovery: "session:operate", dismiss_restart_recovery: "session:operate",
  kill_agent: "session:operate", stop_all_agents: "session:operate", create_manager: "workspace:write",
  create_repository_project: "workspace:write", cancel_repository_project_creation: "workspace:write", delete_manager: "workspace:write",
  update_profile_default_model: "session:operate", update_project_delegation_defaults: "session:operate", update_manager_model: "session:operate",
  update_manager_cwd: "workspace:write", update_session_model: "session:operate", update_session_delegation: "session:operate",
  resume_session: "session:operate", hydrate_archive_last_used: "session:read", archive_session: "session:operate", restore_session: "session:operate",
  delete_session: "session:operate", rename_session: "session:operate", pin_session: "session:operate", set_session_project_agent: "session:operate",
  get_project_agent_config: "session:read", list_project_agent_references: "session:read", get_project_agent_reference: "session:read",
  set_project_agent_reference: "workspace:write", delete_project_agent_reference: "workspace:write", request_project_agent_recommendations: "session:operate",
  get_project_agent_sharing: "session:read", set_project_agent_sharing: "session:operate", get_project_agent_external_directory: "workspace:read",
  fork_session: "session:operate", clear_session: "session:operate", dismiss_session_attention: "session:operate", session_goal_control: "session:operate",
  pin_message: "session:operate", clear_all_pins: "session:operate", merge_session_memory: "session:operate", get_session_workers: "unsupported",
  get_conversation_page: "unsupported", list_directories: "workspace:read", validate_directory: "workspace:read", create_directory: "workspace:write",
  pick_directory: "unsupported", rename_profile: "workspace:write", archive_profile: "workspace:write", restore_profile: "workspace:write",
  reorder_profiles: "workspace:write", choice_cancel: "session:operate", codex_elicitation_response: "session:operate",
  mark_unread: "session:operate", mark_all_read: "session:operate",
  browser_host_register: "unsupported", browser_host_hydrate: "unsupported", browser_host_focus: "unsupported", browser_host_response: "unsupported",
  browser_host_state_report: "unsupported", browser_host_lifecycle_response: "unsupported", browser_panel_reveal_acknowledge: "unsupported",
  browser_tab_open: "session:operate", browser_tab_activate: "session:operate", browser_tab_close: "session:operate", browser_tab_resize: "session:operate",
  browser_recording_start: "session:operate", browser_recording_stop: "session:operate",
} as const satisfies Record<ClientCommand["type"], Scope | "unsupported">;

/** Remove a literal when its authoritative feature projection migrates to V2. */
export const legacySessionEventAllowlist = [
  "session_plan_snapshot", "session_goal_snapshot", "manager_tool_activity",
  "browser_session_snapshot", "browser_session_changed", "secure_session_snapshot",
  "secure_secret_catalog_changed", "codex_elicitation_request", "codex_elicitation_dismissed",
  "generation_throughput", "generation_throughput_snapshot",
] as const satisfies readonly ServerEvent["type"][];
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

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
function bounded(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 32_768;
  if (Array.isArray(value)) return value.length <= 256 && value.every(v => bounded(v, depth + 1));
  return isRecord(value) && Object.keys(value).length <= 128 && Object.entries(value).every(([key, v]) => key.length <= 128 && (v === undefined || bounded(v, depth + 1)));
}

/** Explicit event-specific requirements plus recursive byte/depth/string/array caps. */
export function validateLegacySessionEvent(value: unknown, sessionId: string): value is Extract<ServerEvent, { type: LegacyType }> {
  if (!isRecord(value) || !legacySessionEventAllowlist.includes(value.type as LegacyType) || !bounded(value) || encodedBytes(value) > EVENT_BYTES) return false;
  if ("sessionAgentId" in value && value.sessionAgentId !== sessionId || "agentId" in value && value.agentId !== sessionId) return false;
  switch (value.type as LegacyType) {
    case "manager_tool_activity": return value.sessionAgentId === sessionId && number(value.revision) && number(value.toolCount) && (value.backgroundCount === undefined || number(value.backgroundCount));
    case "session_plan_snapshot": return value.sessionAgentId === sessionId && id(value.profileId) && number(value.revision) && (typeof value.updatedAt === "string" || value.updatedAt === null) && Array.isArray(value.plan) && value.plan.every(step => isRecord(step) && typeof step.step === "string" && ["pending", "in_progress", "completed"].includes(String(step.status)));
    case "session_goal_snapshot": return value.sessionAgentId === sessionId && id(value.profileId) && number(value.revision) && typeof value.measuredAt === "string" && (value.goal === null || isRecord(value.goal) && id(value.goal.id) && typeof value.goal.objective === "string" && ["active", "paused", "blocked", "completed", "cancelled"].includes(String(value.goal.status)) && number(value.goal.activeElapsedMs) && number(value.goal.turnCount) && isRecord(value.goal.usage));
    case "secure_secret_catalog_changed": return number(value.revision);
    case "secure_session_snapshot": return value.sessionAgentId === sessionId && id(value.profileId) && number(value.revision) && typeof value.updatedAt === "string" && ["manager", "worker"].includes(String(value.principalKind)) && typeof value.executionMode === "string" && typeof value.environmentStatus === "string" && Array.isArray(value.leases) && value.leases.every(isRecord) && Array.isArray(value.pendingRequests) && value.pendingRequests.every(isRecord);
    case "browser_session_snapshot": case "browser_session_changed": return isRecord(value.snapshot) && value.snapshot.sessionAgentId === sessionId && id(value.snapshot.profileId) && Array.isArray(value.snapshot.tabs) && value.snapshot.tabs.every(tab => isRecord(tab) && id(tab.tabId)) && (value.type === "browser_session_snapshot" || ["host-report", "automation", "human-command", "lifecycle", "recovery"].includes(String(value.reason)));
    case "codex_elicitation_dismissed": return value.agentId === sessionId && id(value.elicitationId);
    case "codex_elicitation_request": return value.agentId === sessionId && id(value.elicitationId) && id(value.sidecarAgentId) && ["form", "url"].includes(String(value.mode)) && typeof value.message === "string" && Array.isArray(value.persistScopes) && value.persistScopes.every(s => s === "session" || s === "always") && (value.fields === undefined || Array.isArray(value.fields) && value.fields.every(f => isRecord(f) && id(f.key) && typeof f.label === "string" && ["string", "boolean", "number", "enum"].includes(String(f.type)) && typeof f.required === "boolean"));
    case "generation_throughput": return isRecord(value.measurement) && value.measurement.sessionId === sessionId && id(value.measurement.measurementId) && number(value.measurement.sequence) && ["starting", "generating", "completed", "aborted"].includes(String(value.measurement.phase));
    case "generation_throughput_snapshot": return value.sessionAgentId === sessionId && Array.isArray(value.measurements) && value.measurements.every(m => isRecord(m) && m.sessionId === sessionId && id(m.measurementId) && number(m.sequence)) && isRecord(value.sessionSummary);
  }
}

export function createLegacyBuilderAdapter({ access, ports }: { access: EnvironmentAccessPort; ports: LegacyHandlerPorts }): LegacyBuilderAdapter {
  async function execute(principal: Principal, method: LegacyMethod, input: RpcInput<LegacyMethod>, signal: AbortSignal): Promise<RpcOutput<LegacyMethod>> {
    const parsed = parseClientCommand(Buffer.from(JSON.stringify(input.command)));
    if (!parsed.ok) throw new StreamFault("INVALID_INPUT", "Invalid legacy command.");
    const scope = legacyCommandScopes[parsed.command.type];
    if (scope === "unsupported" || scope !== rpcScopes[method]) throw new StreamFault("FORBIDDEN", "Legacy command is not allowed in this scope.");
    if (!input.sessionId) throw new StreamFault("INVALID_INPUT", "Legacy commands require an addressed session.");
    const command = parsed.command as ClientCommand & Record<string, unknown>;
    for (const field of ["agentId", "sessionAgentId", "managerId", "sourceAgentId"] as const) if (command[field] !== undefined && command[field] !== input.sessionId) throw new StreamFault("FORBIDDEN", "Legacy command targets another session.");
    access.authorize(principal, [scope]);
    const events: Record<string, unknown>[] = [];
    let bytes = 0;
    await ports.executeCommand({ principal, sessionId: input.sessionId, command: parsed.command, signal, send(event) {
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

export function legacyCommandId(principal: Principal, method: string, requestId?: string): string {
  if (!requestId) return randomUUID();
  const hex = createHash("sha256").update(`${principal.deviceSessionId}\0${method}\0${requestId}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Old clients require materialized descriptors; accepted intent remains retryable after timeout. */
export async function awaitLegacyReceipt(control: ControlService, principal: Principal, receipt: CommandReceipt): Promise<CommandReceipt> {
  const deadline = Date.now() + 30_000;
  while (receipt.state === "accepted" || receipt.state === "running") {
    if (Date.now() >= deadline) throw new StreamFault("UNAVAILABLE", `Command ${receipt.commandId} was accepted and is still pending.`);
    await new Promise(resolve => setTimeout(resolve, 25));
    receipt = await control.getReceipt(principal, receipt.commandId);
  }
  if (receipt.state !== "succeeded") throw new StreamFault(receipt.error?.code ?? "UNAVAILABLE", receipt.error?.message ?? `Command ${receipt.commandId} was interrupted.`);
  return receipt;
}

export async function executeMigratedLegacyCommand(control: ControlService, principal: Principal, command: ClientCommand, sessionId: string) {
  switch (command.type) {
    case "create_session":
      if (command.sessionPurpose) throw new StreamFault("UNAVAILABLE", "Controlled session purpose is unsupported.");
      return control.execute(principal, "session.launch", { commandId: legacyCommandId(principal, "session.launch", command.requestId), projectId: command.profileId,
        title: command.label ?? command.name ?? "New session", workspaceStrategy: { kind: "current_checkout" } });
    case "user_message":
      if (command.attachments?.length || command.replyTo || command.delivery && command.delivery !== "auto" || command.sessionReferenceAgentIds?.length) throw new StreamFault("UNAVAILABLE", "This legacy message needs the typed V2 input path.");
      return control.execute(principal, "session.send", { commandId: legacyCommandId(principal, "session.send", command.clientRequestId), sessionId: command.agentId ?? sessionId, message: { text: command.text, artifactIds: [] } });
    case "choice_response": return control.execute(principal, "session.choose", { commandId: legacyCommandId(principal, "session.choose"), sessionId: command.agentId, choiceId: command.choiceId, answers: command.answers });
    case "stop_session": return control.execute(principal, "session.stop", { commandId: legacyCommandId(principal, "session.stop", command.requestId), sessionId: command.agentId });
    default: throw new StreamFault("INVALID_INPUT", "Not a migrated command.");
  }
}
