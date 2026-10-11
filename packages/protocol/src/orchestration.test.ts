import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ProviderCapabilitiesSchema, ProviderObservationSchema } from "./orchestration.js";

const scope = { threadId: "actor", bindingId: "binding", generation: 4 };
const conversation = { ...scope, kind: "conversation", nativeId: "native-thread" };
const turn = { ...scope, kind: "turn", conversationId: "native-thread", nativeId: "turn" };

describe("versioned serializable provider boundary", () => {
  it("rejects a native child claiming root terminal authority", () => {
    const event = { type: "terminal", scope, attemptId: "attempt", sequence: 9,
      origin: { kind: "child", conversation, parentTurn: turn, nativeAgentId: "child" },
      terminalAuthority: "native_child", outcome: "completed" };
    expect(Value.Check(ProviderObservationSchema, event)).toBe(true);
    expect(Value.Check(ProviderObservationSchema, { ...event, terminalAuthority: "root_attempt" })).toBe(false);
    expect(Value.Check(ProviderObservationSchema, { ...event, scope: { ...scope, generation: -1 } })).toBe(false);
  });

  it("requires the version and every capability policy rather than implicit provider defaults", () => {
    expect(Value.Check(ProviderCapabilitiesSchema, {})).toBe(false);
    expect(Value.Check(ProviderCapabilitiesSchema, { version: 2 })).toBe(false);
  });
});
