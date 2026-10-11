import { existsSync } from "node:fs";
import { validateChoiceAnswers } from "@forge/protocol";
import type { ChoiceAnswer } from "./types.js";
import type { SessionLifecycleCoordinator } from "./session-lifecycle-coordinator.js";
import type { SwarmSessionService } from "./swarm-session-service.js";
import type { UserMessageCoordinator } from "./user-message-coordinator.js";
import type { ProviderScope, ProviderConversationRef } from "@forge/protocol";
import { SwarmManagerSessionAttentionFacade } from "./swarm-manager-session-attention-facade.js";

/** Stateless internal primitives for the durable control owner; domain tools retain their existing facade. */
export abstract class SwarmManagerControlFacade extends SwarmManagerSessionAttentionFacade {
  ensureControlledSession(input: Parameters<SwarmSessionService["ensureControlledSession"]>[0]): ReturnType<SessionLifecycleCoordinator["ensureControlledSession"]> {
    return this.getFacadeServices().sessions.ensureControlledSession(input);
  }

  isControlledInputPersistenceReady(sessionId: string): boolean {
    const services = this.getFacadeServices();
    const descriptor = services.registry.directory.getAgentForInternalUse(sessionId);
    return Boolean(descriptor) && (!services.runtime.runtimes.has(sessionId) || existsSync(descriptor!.sessionFile));
  }

  releaseControlledWorker(workerId:string):Promise<void> { return this.getFacadeServices().agents.stopWorker(workerId); }

  killControlledWorker(managerId: string, workerId: string): Promise<void> {
    return this.getFacadeServices().agents.killControlledWorker(managerId, workerId);
  }

  isSessionShutdownSafe(sessionId: string): boolean {
    const ids = [sessionId, ...this.getFacadeServices().registry.directory.listWorkersForSession(sessionId).map(worker => worker.agentId)];
    return ids.every(id => !this.getFacadeServices().runtime.runtimes.has(id) && !this.getFacadeServices().runtime.controller.isRuntimeShutdownQuarantined(id));
  }

  applyControlledInput(text: string, options: Parameters<UserMessageCoordinator["applyControlledInput"]>[1]): ReturnType<UserMessageCoordinator["applyControlledInput"]> {
    return this.getFacadeServices().userMessages.applyControlledInput(text, options);
  }

  acquireControlledProvider(scope: ProviderScope, conversation?: ProviderConversationRef) {
    const services = this.getFacadeServices();
    return services.runtime.controller.acquireProvider(scope, () => services.userMessages.acquireRuntime(scope.threadId), conversation);
  }

  installAuthoritativeInputOwner(submit: Parameters<UserMessageCoordinator["installInputOwner"]>[0], recovery: import("./restart-recovery-coordinator.js").CoreRecoveryPort): void {
    this.getFacadeServices().userMessages.installInputOwner(submit);
    this.getFacadeServices().recovery.installCore(recovery);
  }

  installControlledTurnProjection(port:import("./turn-context-coordinator.js").CoreTurnProjectionPort): void {
    this.getFacadeServices().runtime.turns.installCore(port);
  }
  reflectControlledTurns(): void { this.getFacadeServices().runtime.turns.reflectCore(); }
  enqueueControlledPresentation(agentId:string,runId:string,context:import("./turn-context-coordinator.js").InboundTurnContextInput): void {
    this.getFacadeServices().runtime.turns.register(agentId,{ ...context,turnId:runId });
  }
  appendControlledBlockedResult(threadId:string,runId:string,resultText:string):Promise<{entryId:string;resultText:string}> {
    return this.getFacadeServices().userMessages.appendBlockedResult(threadId,runId,resultText);
  }

  applyControlledChoice(input: { sessionId: string; choiceId: string; runtimeGeneration: string; answers: ChoiceAnswer[] }): "answered" | "interrupted" {
    const pending = this.getFacadeServices().interactions.getPendingChoiceRequestsForSession(input.sessionId).find(choice => choice.choiceId === input.choiceId);
    if (!pending || (pending as typeof pending & { runtimeGeneration?: string }).runtimeGeneration !== input.runtimeGeneration) return "interrupted";
    const error = validateChoiceAnswers(pending.questions, input.answers);
    if (error) throw Object.assign(new Error(error), { code: "INVALID_INPUT", retryable: false });
    this.getFacadeServices().interactions.resolveChoiceRequest(input.choiceId, input.answers); return "answered";
  }

  observeCatalogDirty(listener: (dirty: { agentIds?: readonly string[]; profiles?: boolean }) => void): () => void {
    return this.getFacadeServices().events.observeCatalogDirty(listener);
  }
}
