import { randomUUID } from "node:crypto";
import type { ChoiceRequestEvent } from "@forge/protocol";
import type { AgentDescriptor, ChoiceAnswer, ChoiceQuestion, ChoiceRequestStatus } from "./types.js";

interface PendingChoiceRequest {
  choiceId: string;
  runtimeGeneration: string;
  agentId: string;
  sessionAgentId: string;
  questions: ChoiceQuestion[];
  resolve: (answers: ChoiceAnswer[]) => void;
  reject: (reason: Error) => void;
  createdAt: string;
}

export class ChoiceRequestCancelledError extends Error {
  constructor(public readonly reason: "cancelled" | "expired") {
    super(`Choice request ${reason}`);
    this.name = "ChoiceRequestCancelledError";
  }
}

export interface SwarmChoiceServiceOptions {
  now: () => string;
  getDescriptor: (agentId: string) => AgentDescriptor | undefined;
  emitChoiceRequest: (event: ChoiceRequestEvent) => void;
  emitAgentsSnapshot: () => void;
  /**
   * Notifies session attention after the pending-choice map has been mutated.
   * A newly pending choice raises decision_waiting on an armed epoch even while
   * the manager still streams. Resolving the last one may retract that raise or
   * complete an otherwise qualified epoch. It cannot arm.
   */
  reportAttentionAggregateChange?: (sessionAgentId: string) => void | Promise<void>;
}

export interface CoreChoicePort {
  pending(): Array<ChoiceRequestEvent & { sessionAgentId: string }>;
  respond(choiceId: string, answers: ChoiceAnswer[]): boolean;
  cancel(choiceId: string, reason: "cancelled" | "expired"): boolean;
}

export class SwarmChoiceService {
  private readonly pendingChoiceRequests = new Map<string, PendingChoiceRequest>();
  private core?: CoreChoicePort;

  constructor(private readonly options: SwarmChoiceServiceOptions) {}
  installCore(port: CoreChoicePort): void { this.core = port; }

  requestUserChoice(agentId: string, questions: ChoiceQuestion[]): Promise<ChoiceAnswer[]> {
    return this.requestUserChoiceWithId(agentId, questions).promise;
  }

  requestUserChoiceWithId(agentId: string, questions: ChoiceQuestion[]): { choiceId: string; promise: Promise<ChoiceAnswer[]> } {
    const descriptor = this.options.getDescriptor(agentId);
    if (!descriptor) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const sessionAgentId = descriptor.role === "manager"
      ? agentId
      : descriptor.managerId;

    const choiceId = randomUUID().slice(0, 12);
    const createdAt = this.options.now();

    const promise = new Promise<ChoiceAnswer[]>((resolve, reject) => {
      const pending: PendingChoiceRequest = {
        choiceId,
        runtimeGeneration: randomUUID(),
        agentId,
        sessionAgentId,
        questions,
        resolve,
        reject,
        createdAt,
      };

      this.options.emitChoiceRequest(this.buildChoiceRequestEvent(pending, "pending"));
      this.pendingChoiceRequests.set(choiceId, pending);
      this.options.emitAgentsSnapshot();
      // A newly pending choice blocks quiescence for this session.
      void this.options.reportAttentionAggregateChange?.(sessionAgentId);
    });

    return { choiceId, promise };
  }

  resolveChoiceRequest(choiceId: string, answers: ChoiceAnswer[]): void {
    if (this.core?.respond(choiceId, answers)) return;
    const pending = this.pendingChoiceRequests.get(choiceId);
    if (!pending) {
      return;
    }

    this.pendingChoiceRequests.delete(choiceId);

    this.options.emitChoiceRequest(
      this.buildChoiceRequestEvent(pending, "answered", {
        answers,
        timestamp: this.options.now(),
      }),
    );

    pending.resolve(answers);
    this.options.emitAgentsSnapshot();
    void this.options.reportAttentionAggregateChange?.(pending.sessionAgentId);
  }

  cancelChoiceRequest(choiceId: string, reason: Extract<ChoiceRequestStatus, "cancelled" | "expired">): void {
    if (this.core?.cancel(choiceId, reason)) return;
    const pending = this.pendingChoiceRequests.get(choiceId);
    if (!pending) {
      return;
    }

    this.pendingChoiceRequests.delete(choiceId);

    this.options.emitChoiceRequest(
      this.buildChoiceRequestEvent(pending, reason, {
        timestamp: this.options.now(),
      }),
    );

    pending.reject(new ChoiceRequestCancelledError(reason));
    this.options.emitAgentsSnapshot();
    void this.options.reportAttentionAggregateChange?.(pending.sessionAgentId);
  }

  cancelAllPendingChoicesForAgent(agentId: string): void {
    for (const [choiceId, pending] of Array.from(this.pendingChoiceRequests.entries())) {
      if (pending.agentId === agentId || pending.sessionAgentId === agentId) {
        this.cancelChoiceRequest(choiceId, "cancelled");
      }
    }
  }

  hasPendingChoicesForSession(sessionAgentId: string): boolean {
    if (this.core?.pending().some(choice => choice.sessionAgentId === sessionAgentId)) return true;
    for (const pending of this.pendingChoiceRequests.values()) {
      if (pending.sessionAgentId === sessionAgentId) {
        return true;
      }
    }
    return false;
  }

  getPendingChoiceIdsForSession(sessionAgentId: string): string[] {
    const ids = this.core?.pending().filter(choice => choice.sessionAgentId === sessionAgentId).map(choice => choice.choiceId) ?? [];
    for (const pending of this.pendingChoiceRequests.values()) {
      if (pending.sessionAgentId === sessionAgentId) {
        ids.push(pending.choiceId);
      }
    }
    return ids;
  }

  getPendingChoiceRequestsForSession(sessionAgentId: string): ChoiceRequestEvent[] {
    const pendingChoices: ChoiceRequestEvent[] = this.core?.pending().filter(choice => choice.sessionAgentId === sessionAgentId) ?? [];
    for (const pending of this.pendingChoiceRequests.values()) {
      if (pending.sessionAgentId === sessionAgentId) {
        pendingChoices.push(this.buildChoiceRequestEvent(pending, "pending"));
      }
    }
    return pendingChoices;
  }

  getPendingChoiceOwner(choiceId: string): { agentId: string; sessionAgentId: string } | undefined {
    const core = this.core?.pending().find(choice => choice.choiceId === choiceId);
    if (core) return { agentId: core.agentId, sessionAgentId: core.sessionAgentId };
    const pending = this.pendingChoiceRequests.get(choiceId);
    if (!pending) {
      return undefined;
    }

    return {
      agentId: pending.agentId,
      sessionAgentId: pending.sessionAgentId,
    };
  }

  getPendingChoice(choiceId: string): {
    agentId: string;
    sessionAgentId: string;
    questions: ChoiceQuestion[];
  } | undefined {
    const core = this.core?.pending().find(choice => choice.choiceId === choiceId);
    if (core) return { agentId: core.agentId, sessionAgentId: core.sessionAgentId, questions: core.questions };
    const pending = this.pendingChoiceRequests.get(choiceId);
    if (!pending) {
      return undefined;
    }

    return {
      agentId: pending.agentId,
      sessionAgentId: pending.sessionAgentId,
      questions: pending.questions,
    };
  }

  private buildChoiceRequestEvent(
    pending: PendingChoiceRequest,
    status: ChoiceRequestStatus,
    overrides?: {
      answers?: ChoiceAnswer[];
      timestamp?: string;
    },
  ): ChoiceRequestEvent {
    return Object.defineProperty({
      type: "choice_request" as const,
      agentId: pending.agentId,
      sessionAgentId: pending.sessionAgentId,
      choiceId: pending.choiceId,
      questions: pending.questions,
      status,
      ...(overrides?.answers ? { answers: overrides.answers } : {}),
      timestamp: overrides?.timestamp ?? pending.createdAt,
    }, "runtimeGeneration", { value: pending.runtimeGeneration, enumerable: false });
  }
}
