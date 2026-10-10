import type {
  ApiProxyCommand,
  BuilderTimelineChannelView,
  ServerEvent,
  TerminalDescriptor,
} from "@forge/protocol";
import type { MobilePushService } from "../mobile/mobile-push-service.js";
import type { SidebarPerfRecorder } from "../stats/sidebar-perf-types.js";
import { FeedbackService } from "../swarm/feedback-service.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { BrowserAutomationService, isEligibleLocalBuilderManager } from "../swarm/browser-automation/index.js";
import type { UnreadTracker } from "../swarm/session/unread-tracker.js";
import type { TerminalService } from "../terminal/terminal-service.js";
import { WebSocketServer, type RawData, WebSocket } from "ws";
import { isInventoryCommandAllowed } from "./inventory-command-access.js";
import { handleAgentCommand } from "./commands/agent-command-handler.js";
import { handleConversationCommand } from "./commands/conversation-command-handler.js";
import { handleSessionCommand } from "./commands/session-command-handler.js";
import { extractRequestId, parseClientCommand } from "./ws-command-parser.js";
import { WsApiProxy } from "./ws-api-proxy.js";
import { hasRequestId, sendWsEvent, sendWsEventWithBackpressure } from "./ws-send.js";
import { WsSubscriptions } from "./ws-subscriptions.js";
import type { PresentedChatArtifactTicketStore } from "../swarm/session/presented-chat-artifact.js";
import type { HtmlArtifactPreviewStore } from "../swarm/session/html-artifact-preview.js";
import type { ControlService, EnvironmentAccessPort, Principal } from "../environment/control/control-types.js";
import { createBrowserWorkspaceRpc } from "./rpc/browser-workspace-rpc.js";
import { createBrowserHostRpc, type BrowserHostRpc } from "./rpc/browser-host-rpc.js";
import { executeMigratedLegacyCommand, legacyCommandScopes, legacySessionEventAllowlist, type LegacyHandlerPorts } from "./rpc/legacy-builder-adapter.js";
import { awaitCommandReceipt } from "./rpc/control-command-helpers.js";
import type { DetailFeatureStreamItem, RpcInput } from "@forge/protocol/environment-v2";
import { projectDetailFeature } from "./rpc/detail-feature-rpc.js";
import { StreamQueue, StreamFault } from "../environment/streams/stream-budget.js";

import { admitLifecycleCommand, isLifecycleCommand } from "./rpc/lifecycle-command-admission.js";

const CONVERSATION_PAGE_RATE_WINDOW_MS = 5_000;
const MAX_CONVERSATION_PAGE_REQUESTS_PER_WINDOW = 8;

export class WsHandler {
  private readonly swarmManager: SwarmManager;
  private readonly allowNonManagerSubscriptions: boolean;
  private readonly unreadTracker: UnreadTracker | null;
  private readonly browserAutomationService: BrowserAutomationService;
  private readonly subscriptionManager: WsSubscriptions;
  browser!: ReturnType<typeof createBrowserWorkspaceRpc>;
  /** Desktop's embedded browser host on the environment RPC socket. */
  readonly browserHost: BrowserHostRpc;
  private readonly apiProxy: WsApiProxy;
  private readonly conversationPageRequestTimes = new WeakMap<WebSocket, number[]>();
  private environmentControl: { access: EnvironmentAccessPort; control: ControlService } | null = null;
  private readonly principals = new WeakMap<WebSocket, Principal>();
  private readonly featureListeners = new Map<string, Set<(event: ServerEvent) => void>>();
  private readonly listTerminalsForSession: (sessionId: string) => TerminalDescriptor[];

  private wss: WebSocketServer | null = null;

  constructor(options: {
    swarmManager: SwarmManager;
    mobilePushService: MobilePushService;
    allowNonManagerSubscriptions: boolean;
    terminalService?: TerminalService | null;
    listTerminalsForSession?: (sessionAgentId: string) => TerminalDescriptor[];
    unreadTracker?: UnreadTracker;
    perf: SidebarPerfRecorder;
    feedbackService?: FeedbackService;
    browserAutomationService?: BrowserAutomationService;
    getRemoteUpdateAwarenessBootstrapEvent?: (
      projectId: string
    ) => Extract<ServerEvent, { type: "remote_update_awareness_project_changed" | "remote_update_awareness_project_cleared" }> | null;
    artifactTicketStore?: PresentedChatArtifactTicketStore;
    htmlPreviewStore?: HtmlArtifactPreviewStore;
  }) {
    this.swarmManager = options.swarmManager;
    this.allowNonManagerSubscriptions = options.allowNonManagerSubscriptions;
    this.unreadTracker = options.unreadTracker ?? null;
    this.browserAutomationService = options.browserAutomationService ?? new BrowserAutomationService({
      dataDir: this.swarmManager.getConfig().paths.dataDir,
    });

    this.browserHost = createBrowserHostRpc({ service: this.browserAutomationService,
      hydrateSessions: () => this.hydrateBrowserHostSessions(), resolveSession: id => this.resolveBrowserProfile(id) });

    const feedbackService = options.feedbackService ?? new FeedbackService(this.swarmManager.getConfig().paths.dataDir);
    const terminalService = options.terminalService ?? null;
    this.listTerminalsForSession = options.listTerminalsForSession ?? (sessionId => terminalService?.listTerminals(sessionId) ?? []);
    const perf = options.perf;

    this.subscriptionManager = new WsSubscriptions({
      swarmManager: this.swarmManager,
      allowNonManagerSubscriptions: this.allowNonManagerSubscriptions,
      terminalService,
      listTerminalsForSession: options.listTerminalsForSession,
      unreadTracker: this.unreadTracker,
      perf,
      send: (socket, event) => this.send(socket, event),
      sendBootstrapCritical: (socket, event, shouldSend) => this.sendWithBackpressure(socket, event, shouldSend),
      getServer: () => this.wss,
      getRemoteUpdateAwarenessBootstrapEvent: options.getRemoteUpdateAwarenessBootstrapEvent,
    });

    this.apiProxy = new WsApiProxy({
      swarmManager: this.swarmManager,
      mobilePushService: options.mobilePushService,
      feedbackService,
      terminalService,
      unreadTracker: this.unreadTracker,
      artifactTicketStore: options.artifactTicketStore,
      htmlPreviewStore: options.htmlPreviewStore,
    });
  }


  setEnvironmentControl(deps: { access: EnvironmentAccessPort; control: ControlService }): void {
    this.environmentControl = deps;
    this.browser = createBrowserWorkspaceRpc({ service: this.browserAutomationService, host: this.browserHost,
      control: deps.control, resolveSession: id => this.resolveBrowserProfile(id) });
  }

  /** Called by the exact upgrade router after consuming an audience:'legacy' ticket. */
  bindPrincipal(socket: WebSocket, principal: Principal): void {
    if (!this.environmentControl) throw new StreamFault("UNAVAILABLE", "Legacy access is not composed.");
    this.environmentControl.access.authorize(principal, []);
    this.principals.set(socket, principal);
  }

  legacyPorts(): LegacyHandlerPorts {
    const executeCommand: LegacyHandlerPorts["executeCommand"] = async ({ sessionId, command, signal, send }) => {
      if (signal.aborted) return;
      if (sessionId && !this.swarmManager.getAgent(sessionId)) throw new StreamFault("NOT_FOUND", "Unknown session.");
      // Handler identity is a token, never a socket. Handlers touch it only through send.
      const socket = Symbol("legacy-command");
      const context = { command, socket, subscribedAgentId: sessionId, swarmManager: this.swarmManager,
        resolveManagerContextAgentId: (agentId: string) => this.resolveManagerContextAgentId(agentId),
        send: (_connection: symbol, event: ServerEvent) => { if (!signal.aborted) send(event); },
        handleDeletedAgentSubscriptions: (ids: Set<string>) => this.handleDeletedAgentSubscriptions(ids),
        unreadTracker: this.unreadTracker ?? undefined,
      };
      if (command.type === "ping") { send({ type: "ready", subscribedAgentId: sessionId, serverTime: new Date().toISOString() }); return; }
      if (await handleSessionCommand({ ...context, broadcastUnreadCountUpdate: (id, count) => this.broadcastUnreadCountUpdate(id, count) })) return;
      if (await handleAgentCommand(context)) return;
      if (await handleConversationCommand({ ...context, allowNonManagerSubscriptions: this.allowNonManagerSubscriptions, logDebug: () => {}, resolveConfiguredManagerId: () => this.resolveConfiguredManagerId() })) return;
      throw new StreamFault("UNAVAILABLE", `Legacy command ${command.type} has no port adapter.`);
    };
    return {
      executeCommand: async input => {
        if (!isLifecycleCommand(input.command)) return executeCommand(input);
        if (input.signal.aborted) return;
        if (!this.environmentControl) throw new StreamFault("UNAVAILABLE", "Control is not composed.");
        const events = await admitLifecycleCommand(this.environmentControl.control, input.principal, this.swarmManager,
          input.command, input.sessionId, async () => {
            const events: ServerEvent[] = [];
            // Once admitted, socket cancellation cannot cancel a storage mutation.
            await executeCommand({ ...input, signal: new AbortController().signal, send: event => {
              if (event.type === "error") throw new StreamFault("UNAVAILABLE", event.message);
              if (events.length >= 64 || Buffer.byteLength(JSON.stringify([...events, event])) > 512 * 1024)
                throw new StreamFault("PAYLOAD_TOO_LARGE", "Lifecycle response exceeds budget.");
              events.push(event);
            } });
            return events;
          });
        for (const event of events ?? []) if (!input.signal.aborted) input.send(event);
      },
      featureState: async (sessionId, signal) => {
        if (!this.swarmManager.getAgent(sessionId)) throw new StreamFault("NOT_FOUND", "Unknown session.");
        const events: ServerEvent[] = [];
        if (signal.aborted) return [];
        return events;
      },
      subscribeFeatures: (sessionId, listener) => {
        let listeners = this.featureListeners.get(sessionId);
        if (!listeners) this.featureListeners.set(sessionId, listeners = new Set());
        listeners.add(listener);
        return () => { listeners.delete(listener); if (!listeners.size) this.featureListeners.delete(sessionId); };
      },
    };
  }

  /** Ephemeral typed feature stream. Listener ownership stays on the existing
   * mounted-session publisher, including profile-shared terminal fanout. */
  async *detailFeatures(principal: Principal, input: RpcInput<"session.features.subscribe">, signal: AbortSignal): AsyncGenerator<DetailFeatureStreamItem> {
    this.environmentControl?.access.authorize(principal, ["session:read"]);
    const sessionId = input.sessionId;
    if (!this.swarmManager.getAgent(sessionId)) throw new StreamFault("NOT_FOUND", "Unknown session");
    const queue = new StreamQueue<DetailFeatureStreamItem>();
    const buffered: DetailFeatureStreamItem[] = [];
    let ready = false;
    const observe = (raw: ServerEvent) => {
      const event = projectDetailFeature(raw); if (!event) return;
      if (ready) queue.push({ event });
      else { if (buffered.length >= 128) { queue.fail(new StreamFault("RESYNC_REQUIRED", "Feature bootstrap exceeded bounds")); return; } buffered.push({ event }); }
    };
    let listeners = this.featureListeners.get(sessionId);
    if (!listeners) this.featureListeners.set(sessionId, listeners = new Set());
    listeners.add(observe);
    const abort = () => { listeners.delete(observe); if (!listeners.size) this.featureListeners.delete(sessionId); queue.end(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) return;
      const initial: ServerEvent[] = [];
      const scope = this.subscriptionManager.resolveTerminalScopeAgentId(sessionId) ?? sessionId;
      initial.push({ type: "terminals_snapshot", sessionAgentId: scope, terminals: this.listTerminalsForSession(scope) });
      const activity = this.swarmManager.getManagerToolActivitySnapshot(sessionId); if (activity) initial.push(activity);
      initial.push(await this.swarmManager.getGenerationThroughputSnapshot(sessionId));
      for (const snapshot of await this.swarmManager.listSecureSessionTeamSnapshots(sessionId)) initial.push({ type: "secure_session_snapshot", ...snapshot });
      for (const request of this.swarmManager.getPendingCodexElicitationsForManager(sessionId)) initial.push({
        type: "codex_elicitation_request", elicitationId: request.elicitationId, agentId: request.managerAgentId, sidecarAgentId: request.sidecarAgentId,
        mode: request.mode, title: request.title, message: request.message, fields: request.fields, urlOrigin: request.urlOrigin, persistScopes: request.persistScopes,
      });
      if (signal.aborted) return;
      for (const raw of initial) { const event = projectDetailFeature(raw); if (event) queue.push({ event }); }
      ready = true; for (const event of buffered) queue.push(event); buffered.length = 0;
      yield* queue;
    } finally { signal.removeEventListener("abort", abort); abort(); }
  }

  private publishFeatures(sessionId: string, event: ServerEvent): void {
    if (!legacySessionEventAllowlist.includes(event.type as typeof legacySessionEventAllowlist[number]) && !projectDetailFeature(event)) return;
    if (event.type === "terminal_created" || event.type === "terminal_updated" || event.type === "terminal_closed") {
      // `sessionId` is a terminal scope here; deliver to every mounted session that resolves to it.
      for (const [mountedId, listeners] of this.featureListeners) {
        if ((this.subscriptionManager.resolveTerminalScopeAgentId(mountedId) ?? mountedId) === sessionId) for (const listener of listeners) listener(event);
      }
      return;
    }
    for (const listener of this.featureListeners.get(sessionId) ?? []) listener(event);
  }

  sendToSocket(socket: WebSocket, event: ServerEvent): void {
    this.send(socket, event);
  }

  attach(server: WebSocketServer): void {
    this.wss = server;

    server.on("connection", (socket) => {
      const principal = this.principals.get(socket);
      if (!principal || !this.environmentControl) { socket.close(1008, "Device authentication required"); return; }
      const unregister = this.environmentControl.access.registerResource(principal, (force?: boolean) => {
        if (force) socket.terminate(); else socket.close(1008, "Device access ended");
      });
      socket.on("message", (raw) => {
        void this.handleSocketMessage(socket, raw);
      });

      socket.on("close", () => {
        unregister();
        this.subscriptionManager.remove(socket);
      });

      socket.on("error", () => {
        this.subscriptionManager.remove(socket);
      });
    });
  }

  reset(): void {
    this.wss = null;
    this.subscriptionManager.clear();
  }

  broadcastToSubscribed(event: ServerEvent): void {
    if (event.type === "secure_secret_catalog_changed") for (const sessionId of this.featureListeners.keys()) this.publishFeatures(sessionId, event);
    else if ("sessionAgentId" in event && typeof event.sessionAgentId === "string") this.publishFeatures(event.sessionAgentId, event);
    else if (event.type === "codex_elicitation_request" || event.type === "codex_elicitation_dismissed") this.publishFeatures(event.agentId, event);
    this.subscriptionManager.broadcastToSubscribed(event);
  }

  broadcastToProfile(profileId: string, event: ServerEvent): void {
    this.subscriptionManager.broadcastToProfile(profileId, event);
  }

  broadcastToSession(sessionAgentId: string, event: ServerEvent): void {
    this.publishFeatures(sessionAgentId, event);
    this.subscriptionManager.broadcastToSession(sessionAgentId, event);
  }

  broadcastToManagerSession(sessionAgentId: string, event: ServerEvent): void {
    this.publishFeatures(sessionAgentId, event);
    this.subscriptionManager.broadcastToManagerSession(sessionAgentId, event);
  }

  broadcastGenerationThroughput(
    sessionAgentId: string,
    event: Extract<ServerEvent, { type: "generation_throughput" }>,
  ): void {
    this.publishFeatures(sessionAgentId, event);
    this.subscriptionManager.broadcastGenerationThroughput(sessionAgentId, event);
  }

  broadcastManagerToolActivity(
    event: Extract<ServerEvent, { type: "manager_tool_activity" }>,
  ): void {
    this.publishFeatures(event.sessionAgentId, event);
    this.subscriptionManager.broadcastManagerToolActivity(event);
  }

  broadcastSecureSessionSnapshot(
    event: Extract<ServerEvent, { type: "secure_session_snapshot" }>,
  ): void {
    const ownerManagerAgentId = event.ownerManagerAgentId ?? event.sessionAgentId;
    for (const mountedId of this.featureListeners.keys()) {
      const mounted = this.swarmManager.getAgent(mountedId);
      const authority = mounted?.role === "worker" ? mounted.managerId : mountedId;
      if (mountedId === event.sessionAgentId || authority === ownerManagerAgentId) this.publishFeatures(mountedId, event);
    }
    this.subscriptionManager.broadcastSecureSessionSnapshot(event);
  }

  broadcastToExactSubscription(agentId: string, event: ServerEvent): void {
    this.publishFeatures(agentId, event);
    this.subscriptionManager.broadcastToExactSubscription(agentId, event);
  }

  broadcastUnreadCountUpdate(sessionAgentId: string, count: number): void {
    this.subscriptionManager.broadcastUnreadCountUpdate(sessionAgentId, count);
  }

  hasActiveSubscription(agentId: string): boolean {
    return this.subscriptionManager.hasActiveSubscription(agentId);
  }

  hasActiveSubscriptionForSession(sessionAgentId: string): boolean {
    return this.subscriptionManager.hasActiveSubscriptionForSession(sessionAgentId);
  }

  private async handleSocketMessage(socket: WebSocket, raw: RawData): Promise<void> {
    const parsed = parseClientCommand(raw);
    if (!parsed.ok) {
      this.logDebug("command:invalid", {
        message: parsed.error,
      });
      this.send(socket, {
        type: "error",
        code: "INVALID_COMMAND",
        message: parsed.error,
        requestId: parsed.requestId,
      });
      return;
    }

    const command = parsed.command;
    const principal = this.principals.get(socket);
    if (!principal || !this.environmentControl) { socket.close(1008, "Device authentication required"); return; }
    try {
      const migrated = command.type === "create_session" || command.type === "user_message" || command.type === "choice_response" || command.type === "stop_session";
      const scope = migrated ? "session:operate" : command.type === "subscribe" || command.type === "subscribe_inventory" || command.type === "get_conversation_page" || command.type === "get_session_workers" ? "session:read" : legacyCommandScopes[command.type];
      if (scope === "unsupported") throw new StreamFault("FORBIDDEN", "Legacy command is unavailable on this transport.");
      this.environmentControl.access.authorize(principal, [scope]);
      if (isLifecycleCommand(command)) {
        if (this.subscriptionManager.isInventorySubscription(socket) && !isInventoryCommandAllowed(command)) {
          this.send(socket, { type: "error", code: "NOT_SUBSCRIBED", message: "This command requires an explicit conversation subscription.", requestId: extractRequestId(command) });
          return;
        }
        await this.legacyPorts().executeCommand({ principal, command,
          sessionId: this.subscriptionManager.getSubscribedAgentId(socket) ?? ("agentId" in command ? command.agentId : "sourceAgentId" in command ? command.sourceAgentId : "managerId" in command ? command.managerId : "") ?? "",
          signal: new AbortController().signal, send: event => {
            if (event.type === "restart_recovery_snapshot") this.broadcastToSubscribed(event);
            else this.send(socket, event);
          } });
        return;
      }
      if (migrated) {
        const stoppedWorkerIds = command.type === "stop_session" ? this.swarmManager.listWorkersForSession(command.agentId).map(worker => worker.agentId) : [];
        const receipt = await awaitCommandReceipt(this.environmentControl.control, principal,
          await executeMigratedLegacyCommand(this.environmentControl.control, principal, command,
            this.subscriptionManager.getSubscribedAgentId(socket) ?? ""));
        if (command.type === "create_session") {
          const sessionAgent = this.swarmManager.getAgent(receipt.sessionId!);
          const profile = this.swarmManager.listProfiles().find(profile => profile.profileId === command.profileId);
          if (!sessionAgent || !profile) throw new StreamFault("UNAVAILABLE", "Controlled session descriptor is unavailable.");
          this.send(socket, { type: "session_created", sessionAgent, profile, requestId: command.requestId });
        } else if (command.type === "stop_session") {
          this.send(socket, { type: "session_stopped", agentId: command.agentId,
            profileId: this.subscriptionManager.resolveProfileIdForAgent(command.agentId) ?? command.agentId, terminatedWorkerIds: stoppedWorkerIds, requestId: command.requestId });
        }
        return;
      }
    } catch (error) {
      this.send(socket, { type: "error", code: "ENVIRONMENT_COMMAND_REJECTED", message: error instanceof StreamFault ? error.message : "Request rejected.", requestId: extractRequestId(command) });
      return;
    }
    // A command admitted while viewing a conversation may finish after demotion.
    // Recheck at actual send (including after backpressure), without weakening the
    // explicit origin-safe response paths or retaining a second request registry.
    const sendForCommand = (targetSocket: WebSocket, event: ServerEvent): void => {
      this.send(targetSocket, event, () =>
        !this.subscriptionManager.isInventorySubscription(targetSocket) || isInventoryCommandAllowed(command));
    };
    this.logDebug("command:received", {
      type: command.type,
      requestId: extractRequestId(command),
    });

    if (command.type === "ping") {
      if (this.subscriptionManager.isInventorySubscription(socket)) {
        this.send(socket, { type: "inventory_pong", serverTime: new Date().toISOString() });
        return;
      }
      this.send(socket, {
        type: "ready",
        serverTime: new Date().toISOString(),
        subscribedAgentId:
          this.subscriptionManager.getSubscribedAgentId(socket) ?? this.resolveDefaultSubscriptionAgentId(),
        ...(this.subscriptionManager.supportsGoalControlRequestId(socket)
          ? { goalControlRequestId: true as const }
          : {}),
        sessionAttention: true,
      });
      return;
    }

    if (command.type === "subscribe_inventory") {
      try {
        await this.subscriptionManager.handleSubscribeInventory(socket, command.requestId);
      } catch {
        this.send(socket, { type: "error", code: "INVENTORY_BOOTSTRAP_FAILED", message: "Unable to load Builder inventory.", requestId: command.requestId });
      }
      return;
    }

    if (this.subscriptionManager.isInventorySubscription(socket) && !isInventoryCommandAllowed(command)) {
      this.send(socket, { type: "error", code: "NOT_SUBSCRIBED", message: "This command requires an explicit conversation subscription.", requestId: extractRequestId(command) });
      return;
    }

    if (command.type === "subscribe") {
      await this.handleSubscribe(
        socket,
        command.agentId,
        command.messageCount,
        command.conversationPaging === true,
        command.conversationView,
        command.goalControlRequestId === true,
        command.subscriptionId,
      );
      return;
    }

    if (command.type === "get_conversation_page" && !this.allowConversationPageRequest(socket)) {
      this.send(socket, {
        type: "error",
        code: "RATE_LIMITED",
        message: "Too many conversation page requests. Please wait before loading more history.",
        requestId: command.requestId,
      });
      return;
    }

    // An inventoried socket may invoke the bounded origin-safe command set above.
    // This is caller authority only: never record the actor as subscribed/viewing.
    const subscribedAgentId = this.resolveSubscribedAgentId(socket)
      ?? (this.subscriptionManager.isInventorySubscription(socket) ? this.subscriptionManager.resolveInventoryCommandActor() : undefined);
    if (!subscribedAgentId) {
      this.logDebug("command:rejected:not_subscribed", {
        type: command.type,
      });
      this.send(socket, {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: `Send subscribe before ${command.type}.`,
        requestId: extractRequestId(command),
      });
      return;
    }

    if (command.type === "api_proxy") {
      await this.handleApiProxyCommand(socket, command, subscribedAgentId);
      return;
    }

    const sessionHandled = await handleSessionCommand({
      command,
      socket,
      subscribedAgentId,
      swarmManager: this.swarmManager,
      resolveManagerContextAgentId: (agentId) => this.resolveManagerContextAgentId(agentId),
      send: sendForCommand,
      handleDeletedAgentSubscriptions: (deletedAgentIds) => this.handleDeletedAgentSubscriptions(deletedAgentIds),
      unreadTracker: this.unreadTracker ?? undefined,
      broadcastUnreadCountUpdate: (sessionAgentId, count) => this.broadcastUnreadCountUpdate(sessionAgentId, count),
    });
    if (sessionHandled) {
      return;
    }

    const agentHandled = await handleAgentCommand({
      command,
      socket,
      subscribedAgentId,
      swarmManager: this.swarmManager,
      resolveManagerContextAgentId: (agentId) => this.resolveManagerContextAgentId(agentId),
      send: sendForCommand,
    });
    if (agentHandled) {
      return;
    }

    const conversationHandled = await handleConversationCommand({
      command,
      socket,
      subscribedAgentId,
      swarmManager: this.swarmManager,
      allowNonManagerSubscriptions: this.allowNonManagerSubscriptions,
      send: sendForCommand,
      logDebug: (message, details) => this.logDebug(message, details),
      resolveConfiguredManagerId: () => this.resolveConfiguredManagerId(),
    });
    if (conversationHandled) {
      return;
    }

    this.send(socket, {
      type: "error",
      code: "UNKNOWN_COMMAND",
      message: `Unsupported command type ${command.type}`,
    });
  }

  private async handleApiProxyCommand(
    socket: WebSocket,
    command: ApiProxyCommand,
    subscribedAgentId: string,
  ): Promise<void> {
    const response = await this.routeApiProxyCommand(command, subscribedAgentId);
    this.send(socket, response, () =>
      !this.subscriptionManager.isInventorySubscription(socket) || isInventoryCommandAllowed(command));
  }

  private async routeApiProxyCommand(command: ApiProxyCommand, subscribedAgentId: string) {
    return this.apiProxy.routeApiProxyCommand(command, subscribedAgentId);
  }

  private async handleSubscribe(
    socket: WebSocket,
    requestedAgentId?: string,
    requestedMessageCount?: number,
    supportsConversationPaging = false,
    conversationView: BuilderTimelineChannelView = "all",
    supportsGoalControlRequestId = false,
    subscriptionId?: string,
  ): Promise<void> {
    await this.subscriptionManager.handleSubscribe(
      socket,
      requestedAgentId,
      requestedMessageCount,
      supportsConversationPaging,
      conversationView,
      supportsGoalControlRequestId,
      subscriptionId,
    );
  }

  private allowConversationPageRequest(socket: WebSocket): boolean {
    const now = Date.now();
    const cutoff = now - CONVERSATION_PAGE_RATE_WINDOW_MS;
    const recent = (this.conversationPageRequestTimes.get(socket) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (recent.length >= MAX_CONVERSATION_PAGE_REQUESTS_PER_WINDOW) {
      this.conversationPageRequestTimes.set(socket, recent);
      return false;
    }

    recent.push(now);
    this.conversationPageRequestTimes.set(socket, recent);
    return true;
  }

  private resolveSubscribedAgentId(socket: WebSocket): string | undefined {
    return this.subscriptionManager.resolveSubscribedAgentId(socket);
  }

  private resolveManagerContextAgentId(subscribedAgentId: string): string | undefined {
    return this.subscriptionManager.resolveManagerContextAgentId(subscribedAgentId);
  }

  private handleDeletedAgentSubscriptions(deletedAgentIds: Set<string>): void {
    this.subscriptionManager.handleDeletedAgentSubscriptions(deletedAgentIds);
  }

  private resolveDefaultSubscriptionAgentId(): string {
    return this.subscriptionManager.resolveDefaultSubscriptionAgentId();
  }

  private resolveConfiguredManagerId(): string | undefined {
    const managerId = this.swarmManager.getConfig().managerId;
    if (typeof managerId !== "string") {
      return undefined;
    }

    const normalized = managerId.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private resolveBrowserProfile(agentId: string): string | undefined {
    const descriptor = this.swarmManager.getAgent(agentId);
    return descriptor && isEligibleLocalBuilderManager(descriptor) ? descriptor.profileId ?? descriptor.agentId : undefined;
  }

  private async hydrateBrowserHostSessions() {
    const sessions = new Map<string, Awaited<ReturnType<BrowserAutomationService["getSessionSnapshot"]>>>();
    await Promise.all(this.swarmManager.listAgents()
      .filter((descriptor) => descriptor.role === "manager" && isEligibleLocalBuilderManager(descriptor))
      .map(async (descriptor) => {
        const profileId = descriptor.profileId ?? descriptor.agentId;
        const snapshot = await this.browserAutomationService.getHostHydrationSnapshot(
          profileId,
          descriptor.agentId,
        );
        sessions.set(`${profileId}:${descriptor.agentId}`, snapshot);
      }));
    return [...sessions.values()];
  }

  private logDebug(message: string, details?: unknown): void {
    if (!this.swarmManager.getConfig().debug) {
      return;
    }

    const prefix = `[swarm][${new Date().toISOString()}] ws:${message}`;
    if (details === undefined) {
      console.log(prefix);
      return;
    }

    console.log(prefix, details);
  }

  private send(socket: WebSocket, event: ServerEvent, shouldSend?: () => boolean): number | null {
    if (shouldSend?.() === false) return null;
    // Request/response events (requestId present) must not be silently dropped
    // under transient backpressure — the requesting client would hang on its
    // pending promise until timeout, de-duplicating every retry onto the dead
    // request. Route them through the drain-aware sender; other live events
    // keep drop-on-backpressure. This includes broadcasts that echo a
    // requestId (e.g. manager_created): for the originator they ARE the
    // response. Two accepted tradeoffs: (1) bystander sockets get drain-await
    // for such broadcasts too, and (2) a drain-awaited event can be overtaken
    // on the wire by later synchronous sends to the same socket — clients
    // correlate by requestId, not delivery order, and the alternative under
    // backpressure was dropping the event entirely.
    // `session_attention_snapshot` joins the requestId path deliberately: it is
    // the only live carrier of sticky Needs You state, and although each
    // snapshot is self-healing, dropping the last one in a quiet period would
    // leave a stale row (or a missed raise) visible until the next change.
    if (hasRequestId(event) || event.type === "session_attention_snapshot") {
      void this.sendWithBackpressure(socket, event, shouldSend);
      return null;
    }

    return sendWsEvent({
      socket,
      event,
      onDropSocket: (targetSocket) => this.dropSocket(targetSocket),
    });
  }

  private sendWithBackpressure(
    socket: WebSocket,
    event: ServerEvent,
    shouldSend?: () => boolean,
  ): Promise<number | null> {
    return sendWsEventWithBackpressure({
      socket,
      event,
      shouldSend,
      onDropSocket: (targetSocket) => this.dropSocket(targetSocket),
    });
  }

  private dropSocket(socket: WebSocket): void {
    this.subscriptionManager.remove(socket);

    try {
      socket.terminate();
    } catch {
      // best effort
    }
  }
}
