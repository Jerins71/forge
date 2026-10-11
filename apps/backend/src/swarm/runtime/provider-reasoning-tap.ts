import type { ProviderObservation } from "@forge/protocol";
import type { ProviderAdapter } from "./provider-contract.js";

export interface ProviderReasoningSink {
  reasoning(fact: { nativeId: string; phase: "start" | "delta" | "complete"; text: string }): void;
  /** The root attempt ended; reasoning it left open is complete. */
  settled(): void;
}

/**
 * Passes a binding's single observation stream through unchanged and reports its
 * root reasoning to the timeline. Lifecycle authority stays with the stream's consumer.
 */
export function tapProviderReasoning(adapter: ProviderAdapter, sink: ProviderReasoningSink): ProviderAdapter {
  const report = (observation: ProviderObservation) => {
    if (observation.origin.kind !== "root") return;
    if (observation.type === "message" && observation.channel === "reasoning") {
      sink.reasoning({ nativeId: observation.item.nativeId, phase: observation.phase, text: observation.text });
    } else if (observation.type === "terminal") sink.settled();
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
