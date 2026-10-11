import type { ProviderObservation } from "@forge/protocol";
import type { ProviderAdapter } from "./provider-contract.js";

export interface ProviderReasoningSink {
  /** Streaming text of one provider item: its reasoning, or the assistant reply itself. */
  text(fact: { channel: "assistant" | "reasoning"; nativeId: string; phase: "start" | "delta" | "complete"; text: string }): void;
  /** The provider is retrying a failed request on its own. */
  retrying(fact: { attempt: number; message: string }): void;
  /** The root attempt ended, with the provider error that ended it when there was one. */
  settled(error?: string): void;
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
      sink.settled(failureReported ? undefined : error);
      failureReported ||= error !== undefined;
    }
  };
  const observations: ProviderAdapter["observations"] = async function* (binding, signal) {
    for await (const observation of adapter.observations(binding, signal)) {
      // Presentation must never interrupt the provider stream.
      try { report(observation); } catch { /* The row is lost; the turn continues. */ }
      yield observation;
    }
  };
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "observations") return observations;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
