import type { ServerEvent, TerminalDescriptor } from '@forge/protocol';
import type { DetailFeatureStreamItem, RpcInput } from '@forge/protocol/environment-v2';
import type { SwarmManager } from '../swarm/swarm-manager.js';
import { BrowserAutomationService, isEligibleLocalBuilderManager } from '../swarm/browser-automation/index.js';
import type { TerminalService } from '../terminal/terminal-service.js';
import type { EnvironmentAccessPort, ControlService, Principal } from '../environment/control/control-types.js';
import { createBrowserHostRpc, type BrowserHostRpc } from './rpc/browser-host-rpc.js';
import { createBrowserEngineRpc } from "./rpc/browser-engine-rpc.js";
import { createBrowserWorkspaceRpc } from './rpc/browser-workspace-rpc.js';
import { projectDetailFeature } from './rpc/detail-feature-rpc.js';
import { StreamQueue, StreamFault } from '../environment/streams/stream-budget.js';
/** Typed session feature publication; sockets and durable projections belong to the environment runtime. */
export class SessionFeaturePublisher {
    private readonly swarmManager: SwarmManager;
    private readonly browserAutomationService: BrowserAutomationService;
    private readonly featureListeners = new Map<string, Set<(event: ServerEvent) => void>>();
    private readonly listTerminalsForSession: (sessionId: string) => TerminalDescriptor[];
    private environmentControl: {
        access: EnvironmentAccessPort;
        control: ControlService;
        launchMaterialized?: (sessionId: string) => Promise<void>;
    } | null = null;
    readonly browserEngine?: ReturnType<typeof createBrowserEngineRpc>;
    readonly browserHost: BrowserHostRpc;
    browser!: ReturnType<typeof createBrowserWorkspaceRpc>;
    constructor(options: {
        swarmManager: SwarmManager;
        browserAutomationService?: BrowserAutomationService;
        browserEngine?: import("../swarm/browser-automation/browser-engine.js").BrowserEngine;
        terminalService?: TerminalService | null;
        listTerminalsForSession?: (id: string) => TerminalDescriptor[];
    }) {
        this.swarmManager = options.swarmManager;
        this.browserEngine = options.browserEngine && createBrowserEngineRpc(options.browserEngine);
        this.browserAutomationService = options.browserAutomationService ?? new BrowserAutomationService({ dataDir: this.swarmManager.getConfig().paths.dataDir });
        this.listTerminalsForSession = options.listTerminalsForSession ?? (id => options.terminalService?.listTerminals(id) ?? []);
        this.browserHost = createBrowserHostRpc({ service: this.browserAutomationService, hydrateSessions: () => this.hydrateBrowserHostSessions(), resolveSession: id => this.resolveBrowserProfile(id) });
    }
    setEnvironmentControl(deps: {
        access: EnvironmentAccessPort;
        control: ControlService;
        launchMaterialized?: (sessionId: string) => Promise<void>;
    }): void {
        this.environmentControl = deps;
        this.browser = createBrowserWorkspaceRpc({ service: this.browserAutomationService, host: this.browserHost, control: deps.control, resolveSession: id => this.resolveBrowserProfile(id) });
    }
    private resolveTerminalScopeAgentId(id: string): string | undefined {
        const target = this.swarmManager.getAgent(id);
        if (!target)
            return undefined;
        const manager = target.role === 'worker' ? this.swarmManager.getAgent(target.managerId) : target;
        return manager?.role === 'manager' ? manager.profileId ?? manager.agentId : target.role === 'worker' ? target.managerId : id;
    }
    async *detailFeatures(principal: Principal, input: RpcInput<"session.features.subscribe">, signal: AbortSignal): AsyncGenerator<DetailFeatureStreamItem> {
        this.environmentControl?.access.authorize(principal, ["session:read"]);
        const sessionId = input.sessionId;
        await this.environmentControl?.launchMaterialized?.(sessionId);
        const descriptor = this.swarmManager.getAgent(sessionId);
        if (!descriptor)
            throw new StreamFault("NOT_FOUND", "Unknown session");
        const ownerId = descriptor.role === "worker" ? descriptor.managerId : sessionId;
        const queue = new StreamQueue<DetailFeatureStreamItem>();
        const buffered: DetailFeatureStreamItem[] = [];
        let ready = false;
        const observe = (raw: ServerEvent) => {
            const event = projectDetailFeature(raw);
            if (!event)
                return;
            if (ready)
                queue.push({ event });
            else {
                if (buffered.length >= 128) {
                    queue.fail(new StreamFault("RESYNC_REQUIRED", "Feature bootstrap exceeded bounds"));
                    return;
                }
                buffered.push({ event });
            }
        };
        let listeners = this.featureListeners.get(sessionId);
        if (!listeners)
            this.featureListeners.set(sessionId, listeners = new Set());
        listeners.add(observe);
        const abort = () => { listeners.delete(observe); if (!listeners.size)
            this.featureListeners.delete(sessionId); queue.end(); };
        signal.addEventListener("abort", abort, { once: true });
        try {
            if (signal.aborted)
                return;
            const initial: ServerEvent[] = [];
            const scope = this.resolveTerminalScopeAgentId(sessionId) ?? sessionId;
            initial.push({ type: "terminals_snapshot", sessionAgentId: scope, terminals: this.listTerminalsForSession(scope) });
            const activity = this.swarmManager.getManagerToolActivitySnapshot(ownerId);
            if (activity)
                initial.push(activity);
            for (const item of this.swarmManager.getRunningTimelineActivity(ownerId))
                initial.push({ type: "timeline_activity", sessionAgentId: ownerId, item });
            initial.push(await this.swarmManager.getGenerationThroughputSnapshot(ownerId));
            for (const snapshot of await this.swarmManager.listSecureSessionTeamSnapshots(ownerId))
                initial.push({ type: "secure_session_snapshot", ...snapshot });
            for (const request of this.swarmManager.getPendingCodexElicitationsForManager(ownerId))
                initial.push({
                    type: "codex_elicitation_request", elicitationId: request.elicitationId, agentId: request.managerAgentId, sidecarAgentId: request.sidecarAgentId,
                    mode: request.mode, title: request.title, message: request.message, fields: request.fields, urlOrigin: request.urlOrigin, persistScopes: request.persistScopes,
                });
            if (signal.aborted)
                return;
            for (const raw of initial) {
                const event = projectDetailFeature(raw);
                if (event)
                    queue.push({ event });
            }
            ready = true;
            for (const event of buffered)
                queue.push(event);
            buffered.length = 0;
            yield* queue;
        }
        finally {
            signal.removeEventListener("abort", abort);
            abort();
        }
    }
    private publishFeatures(sessionId: string, event: ServerEvent): void {
        if (!projectDetailFeature(event))
            return;
        if (event.type === "terminal_created" || event.type === "terminal_updated" || event.type === "terminal_closed") {
            // `sessionId` is a terminal scope here; deliver to every mounted session that resolves to it.
            for (const [mountedId, listeners] of this.featureListeners) {
                if ((this.resolveTerminalScopeAgentId(mountedId) ?? mountedId) === sessionId)
                    for (const listener of listeners)
                        listener(event);
            }
            return;
        }
        for (const listener of this.featureListeners.get(sessionId) ?? [])
            listener(event);
    }
    publish(event: ServerEvent): void {
        if (event.type === "secure_secret_catalog_changed")
            for (const sessionId of this.featureListeners.keys())
                this.publishFeatures(sessionId, event);
        else if ("sessionAgentId" in event && typeof event.sessionAgentId === "string")
            this.publishFeatures(event.sessionAgentId, event);
        else if (event.type === "codex_elicitation_request" || event.type === "codex_elicitation_dismissed")
            this.publishFeatures(event.agentId, event);
    }
    publishForSession(sessionAgentId: string, event: ServerEvent): void {
        this.publishFeatures(sessionAgentId, event);
    }
    publishThroughput(sessionId: string, event: Extract<ServerEvent, {
        type: 'generation_throughput';
    }>): void {
        this.publishFeatures(sessionId, event);
    }
    publishToolActivity(event: Extract<ServerEvent, {
        type: 'manager_tool_activity';
    }>): void {
        this.publishFeatures(event.sessionAgentId, event);
    }
    publishSecureSnapshot(event: Extract<ServerEvent, {
        type: 'secure_session_snapshot';
    }>): void {
        const owner = event.ownerManagerAgentId ?? event.sessionAgentId;
        for (const mountedId of this.featureListeners.keys()) {
            const mounted = this.swarmManager.getAgent(mountedId);
            const authority = mounted?.role === 'worker' ? mounted.managerId : mountedId;
            if (mountedId === event.sessionAgentId || authority === owner)
                this.publishFeatures(mountedId, event);
        }
    }
    private resolveBrowserProfile(id: string): string | undefined {
        const descriptor = this.swarmManager.getAgent(id);
        return descriptor && isEligibleLocalBuilderManager(descriptor) ? descriptor.profileId ?? descriptor.agentId : undefined;
    }
    private async hydrateBrowserHostSessions() {
        return Promise.all(this.swarmManager.listAgents()
            .filter(d => d.role === 'manager' && isEligibleLocalBuilderManager(d))
            .map(d => this.browserAutomationService.getHostHydrationSnapshot(d.profileId ?? d.agentId, d.agentId)));
    }
}
