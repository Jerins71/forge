import { describe, expect, it } from "vitest";
import type { TimelineActivity } from "@forge/protocol";
import { ProviderDispatchRejectedError } from "../runtime/provider-contract.js";
import { ActivityTimelineTracker, readableProviderError } from "../session/activity-timeline.js";

// Ways a provider failure can still reach the user unreadable, each covered below:
// 1. A JSON error body is shown as JSON.
// 2. A client library's label names a provider that is not the one in use.
// 3. An unrecognised error is passed through with doubled punctuation or unbounded length.
// 4. The recognised cases (key, rate limit, endpoint, dead process) lose their plain wording.
// 5. A reply that was cut off is reported as a plain failure, so the partial text reads as a finished answer.
// 6. A send that never reached the provider is explained in dispatch jargon.

describe("readable provider errors", () => {
  it("reads the message and status out of a JSON error body", () => {
    const raw = '{"type":"error","status":400,"error":{"message":"unsupported websocket request type: response.interrupt","type":"invalid_request_error"}}';
    expect(readableProviderError(raw)).toBe("The provider rejected the request (400): unsupported websocket request type: response.interrupt.");
  });

  it("drops a client library label that names another provider", () => {
    expect(readableProviderError('OpenAI API error (426): 426 "Your Grok CLI version (0.2.112) is outdated."'))
      .toBe("The provider rejected the request (426): Your Grok CLI version (0.2.112) is outdated.");
  });

  it("cleans and bounds an unrecognised error", () => {
    expect(readableProviderError("something odd happened..  ")).toBe("something odd happened.");
    expect(readableProviderError("x".repeat(900)).length).toBeLessThanOrEqual(241);
  });

  it("keeps the plain wording of recognised failures", () => {
    expect(readableProviderError("unexpected status 401 Unauthorized: Invalid API key")).toMatch(/rejected the API key \(401\)/);
    expect(readableProviderError("exceeded retry limit, last status: 429 Too Many Requests")).toMatch(/rate limiting requests \(429\)/);
    expect(readableProviderError("unexpected status 404 Not Found: Unknown error")).toMatch(/endpoint was not found \(404\)/);
    expect(readableProviderError("Codex app-server exited (code=1, signal=null)")).toBe("The provider process stopped unexpectedly.");
  });
});

describe("a reply cut off by a provider failure", () => {
  const settle = (withReply: boolean) => {
    const published: TimelineActivity[] = [];
    const tracker = new ActivityTimelineTracker(item => published.push(item));
    if (withReply) tracker.observeText({ channel: "assistant", actorId: "m", sessionId: "m", nativeId: "reply", phase: "delta", text: "Half a rep", timestamp: "2026-01-01T00:00:00.000Z" });
    return tracker.settleTurn({ actorId: "m", sessionId: "m", error: "Codex app-server exited (code=1, signal=null)", timestamp: "2026-01-01T00:00:01.000Z" });
  };

  it("says the reply was interrupted", () => {
    const result = settle(true);
    expect(result.replyInterrupted).toBe(true);
    expect(result.finished.at(-1)).toMatchObject({ kind: "status", status: "failed", summary: "Reply interrupted: The provider process stopped unexpectedly." });
  });

  it("stays a plain failure when nothing had been said yet", () => {
    const result = settle(false);
    expect(result.replyInterrupted).toBe(false);
    expect(result.finished.at(-1)).toMatchObject({ summary: "Failed: The provider process stopped unexpectedly." });
  });
});

describe("a send the provider never received", () => {
  it("is explained without dispatch jargon", () => {
    for (const reason of ["busy", "closed", "stale_scope"] as const) {
      const message = new ProviderDispatchRejectedError(reason).message;
      expect(message).not.toMatch(/dispatch|rejected before delivery|stale_scope/i);
      expect(message).toMatch(/[.]$/);
    }
    expect(new ProviderDispatchRejectedError("closed").message).toMatch(/send (it|the message) again/i);
  });
});
