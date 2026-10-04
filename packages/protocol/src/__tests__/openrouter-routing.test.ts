import { describe, expect, it } from "vitest";
import { resolveOpenRouterRouting } from "../openrouter-routing.js";
describe("OpenRouter routing", () => {
  it("enforces privacy floor even for explicit weakening or clearing", () => {
    for (const local of [{ zdr: false, data_collection: "allow" as const }, { zdr: null, data_collection: null }]) {
      expect(resolveOpenRouterRouting({ zdr: true, data_collection: "deny" }, local)).toEqual({ zdr: true, data_collection: "deny" });
    }
  });
});
