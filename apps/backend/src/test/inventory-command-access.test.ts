import { describe, expect, it } from "vitest";
import { isInventoryCommandAllowed } from "../ws/inventory-command-access.js";

describe("inventory command allowlist", () => {
  it("allows register and unregister over inventory api_proxy without widening implicit proxy authority", () => {
    expect(isInventoryCommandAllowed({
      type: "api_proxy",
      requestId: "push-register",
      method: "POST",
      path: "/api/mobile/push/register",
      body: "{}",
    })).toBe(true);
    expect(isInventoryCommandAllowed({
      type: "api_proxy",
      requestId: "push-unregister",
      method: "POST",
      path: "/api/mobile/push/unregister",
      body: "{}",
    })).toBe(true);
    expect(isInventoryCommandAllowed({
      type: "api_proxy",
      requestId: "push-test",
      method: "POST",
      path: "/api/mobile/push/test",
      body: "{}",
    })).toBe(false);
    expect(isInventoryCommandAllowed({
      type: "api_proxy",
      requestId: "artifact",
      method: "POST",
      path: "/api/chat-artifacts/read",
      body: "{}",
    })).toBe(false);
  });
});
