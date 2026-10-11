import type { ProviderObservation } from "@forge/protocol";
import type { ProviderAdapter } from "./provider-contract.js";

export interface ProviderReasoningSink {
  /** Streaming text of one provider item: its reasoning, or the assistant reply itself. */
  text(fact: { channel: "assistant" | "reasoning"; nativeId: string; phase: "start" | "delta" | "complete"; text: string }): void;
  /** The provider is retrying a failed request on its own. */
  retrying(fact: { attempt: number; message: string }): void;
  /** The root attempt ended: with the provider error that ended it, or cut short without completing. */
  settled(end: { error?: string; stopped?: boolean }): void;
}

/**
 * Passes a binding's single observation stream through unchanged and reports its
 * root reasoning, reply text, retries and failures to the timeline. Lifecycle authority stays with the stream's consumer.
 */
export function tapProviderReasoning(adapter: ProviderAdapter, sink: ProviderReasoningSink): ProviderAdapter {
  // An error and the failed terminal that follows it describe one failure; report it once per turn.
  let failureReported = false;
  const report = (observation: ProviderObservation) => {
    if (observation.origin.kind !== "root") return;
    if (observation.type === "accepted") failureReported = false;
    if (observation.type === "message") {
      sink.text({ channel: observation.channel, nativeId: observation.item.nativeId, phase: observation.phase, text: observation.text });
    } else if (observation.type === "retry") sink.retrying({ attempt: observation.attempt, message: observation.message });
    else if (observation.type === "error" || observation.type === "terminal") {
      const error = observation.type === "error" ? observation.message
        : observation.outcome === "failed" ? observation.error?.message ?? "The provider turn failed." : undefined;
      sink.settled({ ...(error !== undefined && !failureReported ? { error } : {}),
        ...(observation.type === "terminal" && observation.outcome !== "completed" && error === undefined ? { stopped: true } : {}) });
      failureReported ||= error !== undefined;
    }
  };
  // The lifecycle consumer commits every observation before taking the next, so under streaming load it
  // runs seconds behind. Rows must appear when the provider speaks: read the stream as it arrives, report
  // at once, and hand the consumer the same observations in the same order at its own pace.
  const observations: ProviderAdapter["observations"] = (binding, signal) => {
    const source = adapter.observations(binding, signal)[Symbol.asyncIterator]();
    const pending: ProviderObservation[] = [];
    let ended = false; let failure: unknown; let wake: (() => void) | undefined;
    void (async () => {
      try {
        for (;;) {
          const next = await source.next();
          if (next.done) break;
          // Presentation must never interrupt the provider stream.
          try { report(next.value); } catch { /* The row is lost; the turn continues. */ }
          pending.push(next.value); wake?.();
        }
      } catch (error) { failure = error; }
      finally { ended = true; wake?.(); }
    })();
    return (async function* () {
      try {
        for (;;) {
          if (pending.length) { yield pending.shift()!; continue; }
          if (failure !== undefined) throw failure;
          if (ended) return;
          await new Promise<void>(resolve => { wake = resolve; });
          wake = undefined;
        }
      // The reader may be waiting on the provider; ask it to stop without waiting for it. The abort signal ends the source.
      } finally { if (!ended) void Promise.resolve(source.return?.(undefined)).catch(() => undefined); }
    })();
  };
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "observations") return observations;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
