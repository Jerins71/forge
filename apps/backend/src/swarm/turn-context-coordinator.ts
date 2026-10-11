import { extractRole } from "./session/message-utils.js";
import type {
  MessageRouteInternalDeliveryKind,
  MessageRouteOrigin,
} from "./message-router.js";
import { cloneAssistantOutputTarget } from "./assistant-output-target.js";
import { isCleanManagerAssistantFinalMessage } from "./runtime/manager-assistant-final-message.js";
import type {
  RuntimeSessionEvent,
} from "./runtime-contracts.js";
import type {
  AgentDescriptor,
  AssistantOutputTarget,
  ConversationMessageEvent,
  MessageSourceContext,
} from "./types.js";

export type InboundTurnSource =
  | "user_input"
  | "project_agent_input"
  | "agent_message"
  | "worker_result";

export interface InboundTurnContextInput<
  TCodexGate = unknown,
  TCodexDelegation = unknown,
  TCodexRetryAuthorization = unknown,
> {
  activationEligible?: boolean;
  source: InboundTurnSource;
  routeOrigin?: MessageRouteOrigin;
  internalDeliveryKind?: MessageRouteInternalDeliveryKind;
  sourceWorkerId?: string;
  /** Whether ending this inbound obligation silently is a user-facing failure. */
  requiresVisibleResponse?: boolean;
  rootTurnId?: string;
  parentRootTurnId?: string;
  runtimeMessageText?: string;
  projectAgentContext?: ConversationMessageEvent["projectAgentContext"];
  sourceContext?: MessageSourceContext;
  assistantOutputTarget?: AssistantOutputTarget;
  assistantOutputProjectionTarget?: AssistantOutputTarget;
  codexMcpToolGate?: TCodexGate;
  codexPluginDelegationContext?: TCodexDelegation;
  codexPluginRetryAuthorizationContext?: TCodexRetryAuthorization;
  turnId?: string;
}

interface QueuedInboundTurnContext<
  TCodexGate,
  TCodexDelegation,
  TCodexRetryAuthorization,
> extends InboundTurnContextInput<TCodexGate, TCodexDelegation, TCodexRetryAuthorization> {
  turnId: string;
  sequence: number;
  runtimeToken?: number;
  activationEligible: boolean;
}

export interface ActiveExternalProjectAgentTurn {
  fromAgentId: string;
  fromDisplayName: string;
  fromProfileId?: string;
  fromProjectName?: string;
}

export interface ActiveMessageRouteActivation {
  origin: MessageRouteOrigin;
  internalDeliveryKind?: MessageRouteInternalDeliveryKind;
  sourceWorkerId?: string;
  requiresVisibleResponse: boolean;
}

export interface ManagerOutputTurnActivation {
  target?: AssistantOutputTarget;
  routeContext?: ActiveMessageRouteActivation;
  turnId?: string;
  beginUserVisibleObligation: boolean;
}

export interface ManagerOutputTurnEndContext {
  pendingTargets: readonly AssistantOutputTarget[];
}

export interface ManagerOutputTurnPort {
  activateManagerTurn(agentId: string, activation: ManagerOutputTurnActivation): void;
  completeProviderCycle(agentId: string, context: ManagerOutputTurnEndContext): void;
  completeAgentTurn(agentId: string): void;
  acceptCleanManagerFinal(agentId: string, context: ManagerOutputTurnEndContext): void;
  handleRuntimeError(agentId: string, descriptor: AgentDescriptor | undefined): void;
  clearForRuntimeReset(agentId: string): void;
}

export interface CodexTurnActivation<
  TCodexGate,
  TCodexDelegation,
  TCodexRetryAuthorization,
> {
  gate?: TCodexGate;
  delegation?: TCodexDelegation;
  retryAuthorization?: TCodexRetryAuthorization;
}

export interface CodexTurnScopePort<
  TCodexGate,
  TCodexDelegation,
  TCodexRetryAuthorization,
> {
  noteRuntimeUserMessageStarted(agentId: string, descriptor: AgentDescriptor | undefined): void;
  activateManagerTurn(
    agentId: string,
    activation: CodexTurnActivation<TCodexGate, TCodexDelegation, TCodexRetryAuthorization>,
  ): void;
  completeProviderCycle(agentId: string): void;
  completeAgentTurn(agentId: string): void;
  handleRuntimeError(agentId: string, descriptor: AgentDescriptor | undefined): void;
  clearForRuntimeReset(agentId: string): void;
}

export interface CoreTurnProjection { status?: AgentDescriptor["status"]; activeRunId?:string; pendingRunIds:readonly string[]; }
export interface CoreTurnProjectionPort { read(agentId:string):CoreTurnProjection; }

export interface QueuedInboundTurnHandle {
  turnId: string;
  rollback(): void;
}

export interface TurnContextObservabilityPort {
  activateRoot(agentId: string, rootTurnId: string, parentRootTurnId?: string): void;
  clearRoot(agentId: string): void;
  getActiveRootTurnId(agentId: string): string | undefined;
  recordRuntimeSessionEvent(
    agentId: string,
    runtimeToken: number | undefined,
    event: RuntimeSessionEvent,
  ): void;
}

export interface TurnContextAttentionPort {
  /** Called after accepted input is durably represented in the pending queue. */
  observePendingQueueChange(agentId: string): Promise<void>;
  /**
   * Called when accepted input is removed without a new continuation, or when
   * matched consume happens during an already-streaming manager run.
   */
  releaseContinuationBarrier(agentId: string): Promise<void>;
}

export interface TurnContextCoordinatorOptions<
  TCodexGate,
  TCodexDelegation,
  TCodexRetryAuthorization,
> {
  descriptors: Map<string, AgentDescriptor>;
  attention: TurnContextAttentionPort;
  getRuntimeToken(agentId: string): number | undefined;
  output: ManagerOutputTurnPort;
  codex: CodexTurnScopePort<TCodexGate, TCodexDelegation, TCodexRetryAuthorization>;
  observability: TurnContextObservabilityPort;
  managerToolActivity?: {
    activateManagerTurn(agentId: string, turnId: string): void;
    clearManagerTurn(agentId: string): void;
  };
  logDebug(message: string, details?: unknown): void;
}

interface ActiveTurnContext {
  turnId: string;
  sequence: number;
  runtimeToken?: number;
  parentContext?: ActiveWorkerParentContext;
}

export interface ActiveWorkerParentContext {
  outputTarget: AssistantOutputTarget;
  rootTurnId?: string;
  parentRootTurnId?: string;
}

/**
 * Projects committed run identity into output, authorization and observability.
 *
 * Surface routing, Codex authorization, and observability projection remain in
 * their respective owners. Only the core projection selects and completes a run.
 */
export class TurnContextCoordinator<TCodexGate=unknown,TCodexDelegation=unknown,TCodexRetryAuthorization=unknown> {
  private readonly contexts = new Map<string,Map<string,QueuedInboundTurnContext<TCodexGate,TCodexDelegation,TCodexRetryAuthorization>>>();
  private core?:CoreTurnProjectionPort;
  private readonly activeTurnByAgentId = new Map<string,ActiveTurnContext>();
  private readonly activeExternalTurnByAgentId = new Map<string,ActiveExternalProjectAgentTurn>();
  constructor(private readonly options:TurnContextCoordinatorOptions<TCodexGate,TCodexDelegation,TCodexRetryAuthorization>) {}
  installCore(port:CoreTurnProjectionPort):void { this.core=port; this.reflectCore(); }
  reflectCore():void {
    if (!this.core) return;
    for (const agentId of new Set([...this.contexts.keys(),...this.activeTurnByAgentId.keys()])) {
      const projection=this.core.read(agentId); const previous=this.activeTurnByAgentId.get(agentId);
      if (previous?.turnId===projection.activeRunId) continue;
      if (previous) {
        this.options.output.completeAgentTurn(agentId); this.options.codex.completeAgentTurn(agentId);
        this.options.managerToolActivity?.clearManagerTurn(agentId);
        this.activeTurnByAgentId.delete(agentId); this.activeExternalTurnByAgentId.delete(agentId); this.options.observability.clearRoot(agentId);
        void this.options.attention.releaseContinuationBarrier(agentId);
      }
      const context=projection.activeRunId && this.contexts.get(agentId)?.get(projection.activeRunId);
      if (context) this.activateDequeuedContext(agentId,this.options.descriptors.get(agentId),context);
    }
  }
  register(agentId:string,context:InboundTurnContextInput<TCodexGate,TCodexDelegation,TCodexRetryAuthorization>):void {
    if (!context.turnId) throw new Error("Presentation requires an authoritative run id");
    const contexts=this.contexts.get(agentId) ?? new Map();
    contexts.set(context.turnId,{ ...context,turnId:context.turnId,sequence:0,activationEligible:context.activationEligible ?? true,runtimeToken:this.options.getRuntimeToken(agentId) });
    this.contexts.set(agentId,contexts); this.reflectCore();
  }
  getActiveTurnId(agentId:string,runtimeToken?:number):string|undefined {
    const active=this.activeTurnByAgentId.get(agentId);
    if (runtimeToken!==undefined && active?.runtimeToken!==undefined && runtimeToken!==active.runtimeToken) return undefined;
    return this.core?.read(agentId).activeRunId;
  }
  /** What started the manager's running turn; undefined when no tracked turn is active. */
  getActiveTurnSource(agentId:string):InboundTurnSource|undefined {
    const activeRunId=this.core?.read(agentId).activeRunId;
    return activeRunId ? this.contexts.get(agentId)?.get(activeRunId)?.source : undefined;
  }
  getPendingContextCount(agentId:string):number { return this.core?.read(agentId).pendingRunIds.length ?? 0; }
  getActiveWorkerParentContext(agentId:string):ActiveWorkerParentContext|undefined {
    const context=this.activeTurnByAgentId.get(agentId)?.parentContext;
    return context ? { ...context,outputTarget:cloneAssistantOutputTarget(context.outputTarget) } : undefined;
  }
  hasPendingSupersedingUserInput(agentId:string,activeTurnId?:string):boolean {
    return Boolean(this.core?.read(agentId).pendingRunIds.some(id=>id!==activeTurnId && this.contexts.get(agentId)?.get(id)?.source==="user_input"));
  }
  markProviderCycleActivated(_agentId:string):void {}
  getActiveExternalProjectAgentTurn(agentId:string):ActiveExternalProjectAgentTurn|undefined {
    const active=this.activeExternalTurnByAgentId.get(agentId); return active ? { ...active } : undefined;
  }
  async enqueue(agentId:string,context:InboundTurnContextInput<TCodexGate,TCodexDelegation,TCodexRetryAuthorization>):Promise<QueuedInboundTurnHandle> {
    this.register(agentId,context); await this.options.attention.observePendingQueueChange(agentId);
    return { turnId:context.turnId!,rollback:()=>{ this.contexts.get(agentId)?.delete(context.turnId!); } };
  }
  beforeRuntimeEventProjection(agentId:string,_runtimeToken:number|undefined,event:RuntimeSessionEvent):void { this.applyRuntimeEvent(agentId,event,"before_projection"); }
  afterRuntimeEventProjection(agentId:string,runtimeToken:number|undefined,event:RuntimeSessionEvent):void {
    this.applyRuntimeEvent(agentId,event,"after_projection"); this.options.observability.recordRuntimeSessionEvent(agentId,runtimeToken,event);
  }
  handleRuntimeError(agentId:string):void {
    const descriptor=this.options.descriptors.get(agentId); this.options.output.handleRuntimeError(agentId,descriptor); this.options.codex.handleRuntimeError(agentId,descriptor);
  }
  discard(agentId:string):void {
    this.contexts.delete(agentId); this.activeTurnByAgentId.delete(agentId); this.activeExternalTurnByAgentId.delete(agentId);
    this.options.managerToolActivity?.clearManagerTurn(agentId); this.options.output.clearForRuntimeReset(agentId); this.options.codex.clearForRuntimeReset(agentId);
    void this.options.attention.releaseContinuationBarrier(agentId);
  }
  clearAgentState(agentId:string):void { this.discard(agentId); this.options.observability.clearRoot(agentId); }
  private applyRuntimeEvent(agentId:string,event:RuntimeSessionEvent,phase:"before_projection"|"after_projection"):void {
    const descriptor=this.options.descriptors.get(agentId);
    if (phase==="before_projection" && event.type==="message_start" && extractRole(event.message)==="user") this.options.codex.noteRuntimeUserMessageStarted(agentId,descriptor);
    this.reflectCore();
    if (phase==="after_projection" && event.type==="turn_end") { this.options.output.completeProviderCycle(agentId,{ pendingTargets:this.pendingOutputTargets(agentId) }); this.options.codex.completeProviderCycle(agentId); }
    if (phase==="after_projection" && isCleanManagerAssistantFinalMessage(event)) this.options.output.acceptCleanManagerFinal(agentId,{ pendingTargets:this.pendingOutputTargets(agentId) });
  }
  private activateDequeuedContext(
    agentId: string,
    descriptor: AgentDescriptor | undefined,
    context: QueuedInboundTurnContext<TCodexGate, TCodexDelegation, TCodexRetryAuthorization>,
  ): void {
    if (context.activationEligible) {
      this.activateContext(agentId, descriptor, context);
      return;
    }

    this.setActiveTurnFromContext(agentId, context);
    if ((descriptor ?? this.options.descriptors.get(agentId))?.role === "manager") {
      // Even id-only delivery is an authoritative inbound manager turn. Keep
      // the count-only indicator keyed to it while preserving this path's
      // deliberate no-surface-activation semantics below.
      this.options.managerToolActivity?.activateManagerTurn(agentId, context.turnId);
    }
    this.activateContext(agentId, descriptor, undefined, { preserveActiveTurn: true });
  }

  private activateContext(
    agentId: string,
    descriptor: AgentDescriptor | undefined,
    context: QueuedInboundTurnContext<TCodexGate, TCodexDelegation, TCodexRetryAuthorization> | undefined,
    options?: { preserveActiveTurn?: boolean },
  ): void {
    if (context) {
      this.setActiveTurnFromContext(agentId, context);
    } else if (!options?.preserveActiveTurn) {
      this.activeTurnByAgentId.delete(agentId);
    }

    if (context?.rootTurnId) {
      this.options.observability.activateRoot(
        agentId,
        context.rootTurnId,
        context.parentRootTurnId,
      );
    } else if (context) {
      this.options.observability.clearRoot(agentId);
    }

    const externalProjectAgentContext =
      context?.source === "project_agent_input" && context.projectAgentContext?.external
        ? {
            fromAgentId: context.projectAgentContext.fromAgentId,
            fromDisplayName: context.projectAgentContext.fromDisplayName,
            ...(context.projectAgentContext.fromProfileId
              ? { fromProfileId: context.projectAgentContext.fromProfileId }
              : {}),
            ...(context.projectAgentContext.fromProjectName
              ? { fromProjectName: context.projectAgentContext.fromProjectName }
              : {}),
          }
        : undefined;

    if (externalProjectAgentContext) {
      this.activeExternalTurnByAgentId.set(agentId, externalProjectAgentContext);
    } else {
      this.activeExternalTurnByAgentId.delete(agentId);
    }

    const manager = descriptor ?? this.options.descriptors.get(agentId);
    if (manager?.role !== "manager") {
      return;
    }

    if (context?.turnId) {
      this.options.managerToolActivity?.activateManagerTurn(agentId, context.turnId);
    }

    const target = context?.assistantOutputProjectionTarget ?? context?.assistantOutputTarget;
    this.options.output.activateManagerTurn(agentId, {
      target,
      ...(target
        ? {
            routeContext: {
              origin: context?.routeOrigin ?? "internal",
              ...(context?.internalDeliveryKind
                ? { internalDeliveryKind: context.internalDeliveryKind }
                : {}),
              ...(context?.sourceWorkerId
                ? { sourceWorkerId: context.sourceWorkerId }
                : {}),
              requiresVisibleResponse:
                context?.requiresVisibleResponse ??
                (context?.source === "user_input" || context?.routeOrigin === "scheduled"),
            },
          }
        : {}),
      turnId: context?.turnId,
      beginUserVisibleObligation: context?.source === "user_input",
    });

    this.options.codex.activateManagerTurn(agentId, {
      gate: context?.codexMcpToolGate,
      delegation: context?.codexPluginDelegationContext,
      retryAuthorization: context?.codexPluginRetryAuthorizationContext,
    });
  }

  private setActiveTurnFromContext(
    agentId: string,
    context: QueuedInboundTurnContext<TCodexGate, TCodexDelegation, TCodexRetryAuthorization>,
  ): void {
    const outputTarget = context.assistantOutputProjectionTarget ?? context.assistantOutputTarget;
    this.activeTurnByAgentId.set(agentId, {
      turnId: context.turnId,
      sequence: context.sequence,
      ...(context.runtimeToken !== undefined ? { runtimeToken: context.runtimeToken } : {}),
      ...(outputTarget
        ? {
            parentContext: {
              outputTarget: cloneAssistantOutputTarget(outputTarget),
              ...(context.rootTurnId ? { rootTurnId: context.rootTurnId } : {}),
              ...(context.parentRootTurnId
                ? { parentRootTurnId: context.parentRootTurnId }
                : {}),
            },
          }
        : {}),
    });
  }

  private pendingOutputTargets(agentId:string): AssistantOutputTarget[] {
    return (this.core?.read(agentId).pendingRunIds ?? []).flatMap(id => {
      const context = this.contexts.get(agentId)?.get(id);
      const target = context?.assistantOutputProjectionTarget ?? context?.assistantOutputTarget;
      return target ? [target] : [];
    });
  }
}
