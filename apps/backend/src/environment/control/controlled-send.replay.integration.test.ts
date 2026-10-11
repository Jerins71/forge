import { describe, expect, it } from "vitest";
import { runControlledSendReplay } from "../../swarm/runtime/replay/controlled-send-scenario.js";

// Acceptance is written before the transport harness. Every scenario goes through
// the real RPC, control, swarm, Codex parser/runtime and persisted projections.
describe("production Codex controlled-send replay", () => {
  it("retries a dropped RPC receipt without another accepted input or provider dispatch", async () => {
    const result = await runControlledSendReplay("dropped-rpc-receipt");
    expect(result.counts).toEqual({ acceptedInputs: 1, receipts: 1, canonicalInputs: 1, providerDispatches: 1 });
    expect(result.receipt.delivery).toBe("dispatched");
    expect(result.live).toEqual(result.bootstrap);
  }, 60_000);

  it("retains unresolved recovery after a lost provider-start acknowledgment and two boots", async () => {
    const result = await runControlledSendReplay("lost-provider-acknowledgment");
    expect(result.counts).toEqual({ acceptedInputs: 1, receipts: 1, canonicalInputs: 1, providerDispatches: 1 });
    expect(result.receipt.delivery).toBe("unknown");
    expect(result.live).toEqual(result.bootstrap);
    expect(result.recoveryAcrossBoots).toEqual([true, true]);
    expect(new Set(result.recoveryIdsAcrossBoots).size).toBe(1);
  }, 60_000);

  it("reconciles a crash after JSONL append before locator commit", async () => {
    const result = await runControlledSendReplay("append-before-locator");
    expect(result.crashBoundary).toMatchObject({ appendPersisted: true, locatorCommitted: false });
    expect(result.counts).toEqual({ acceptedInputs: 1, receipts: 1, canonicalInputs: 1, providerDispatches: 1 });
    expect(result.receipt.delivery).toBe("dispatched");
    expect(result.live).toEqual(result.bootstrap);
  }, 60_000);
});
