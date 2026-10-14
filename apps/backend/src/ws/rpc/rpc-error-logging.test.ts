import { afterEach, expect, it, vi } from "vitest";
import { rpcError } from "./rpc-dispatcher.js";
import { sendAccessError } from "../../environment/access/http-policy.js";
import { AccessError } from "../../environment/access/access-service.js";

afterEach(() => vi.restoreAllMocks());

it("logs an unexpected RPC failure with its method and stack, and still returns the generic wire error", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const failure = new TypeError("cannot read properties of undefined");
  expect(rpcError(failure, "session.send")).toEqual({ code: "INTERNAL", message: "Unable to complete request.", retryable: false });
  expect(log).toHaveBeenCalledWith("[rpc] session.send failed unexpectedly", failure);
});

it("does not log expected, coded RPC errors", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  rpcError({ code: "NOT_FOUND", message: "Session not found", retryable: false }, "session.send");
  expect(log).not.toHaveBeenCalled();
});

it("logs an unexpected HTTP failure but not an access refusal", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = { statusCode: 0, setHeader() {}, end() {} } as never;
  sendAccessError(response, new AccessError("FORBIDDEN", "Origin is not allowed"));
  expect(log).not.toHaveBeenCalled();
  const failure = new Error("boom");
  sendAccessError(response, failure);
  expect(log).toHaveBeenCalledWith("[http] environment request failed unexpectedly", failure);
});
