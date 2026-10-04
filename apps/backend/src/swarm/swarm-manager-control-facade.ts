import { existsSync } from "node:fs";
import { validateChoiceAnswers } from "@forge/protocol";
import type { ChoiceAnswer } from "./types.js";
import type { SessionLifecycleCoordinator } from "./session-lifecycle-coordinator.js";
import type { SwarmSessionService } from "./swarm-session-service.js";
import type { UserMessageCoordinator } from "./user-message-coordinator.js";
import { SwarmManagerSessionAttentionFacade } from "./swarm-manager-session-attention-facade.js";

/** Stateless internal primitives for the durable control owner; legacy commands retain their existing facade. */
export abstract class SwarmManagerControlFacade extends SwarmManagerSessionAttentionFacade {
  ensureControlledSession(input: Parameters<SwarmSessionService["ensureControlledSession"]>[0]): ReturnType<SessionLifecycleCoordinator["ensureControlledSession"]> {
    return this.getFacadeServices().sessions.ensureControlledSession(input);
  }

  isControlledInputPersistenceReady(sessionId: string): boolean {
    const services = this.getFacadeServices();
    const descriptor = services.registry.directory.getAgentForInternalUse(sessionId);
    return Boolean(descriptor) && (!services.runtime.runtimes.has(sessionId) || existsSync(descriptor!.sessionFile));
  }

  isSessionShutdownSafe(sessionId: string): boolean {
    const ids = [sessionId, ...this.getFacadeServices().registry.directory.listWorkersForSession(sessionId).map(worker => worker.agentId)];
    return ids.every(id => !this.getFacadeServices().runtime.runtimes.has(id) && !this.getFacadeServices().runtime.controller.isRuntimeShutdownQuarantined(id));
  }

  setControlledRecoveryPolicy(policy: (sessionId: string) => boolean): void {
    this.getFacadeServices().recovery.setControlledRecoveryPolicy(policy);
  }

  applyControlledInput(text: string, options: Parameters<UserMessageCoordinator["applyControlledInput"]>[1]): ReturnType<UserMessageCoordinator["applyControlledInput"]> {
    return this.getFacadeServices().userMessages.applyControlledInput(text, options);
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
