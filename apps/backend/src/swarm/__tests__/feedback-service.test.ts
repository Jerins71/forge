import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FeedbackService } from "../feedback-service.js";

describe("feedback-service", () => {
  it("submits feedback and reads it back", async () => {
    const dataDir = await createTempDataDir();
    const profileId = "alpha";
    const sessionId = "alpha--s1";

    const service = new FeedbackService(dataDir);
    const submitted = await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "up",
      reasonCodes: ["accuracy"],
      comment: "Nice answer",
      channel: "web",
      actor: "user"
    });

    expect(submitted.id.length).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(submitted.createdAt))).toBe(true);

    const feedback = await service.listFeedback(profileId, sessionId);
    expect(feedback).toEqual([submitted]);
  });

  it("clearKind vote (or default clear) removes only the vote entry", async () => {
    const dataDir = await createTempDataDir();
    const profileId = "alpha";
    const sessionId = "alpha--s1";

    const service = new FeedbackService(dataDir);

    await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "up",
      reasonCodes: ["accuracy"],
      comment: "Nice answer",
      channel: "web",
      actor: "user"
    });

    await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "comment",
      reasonCodes: ["accuracy"],
      comment: "I like this answer",
      channel: "web",
      actor: "user"
    });

    // Explicit vote-clear
    await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "clear",
      reasonCodes: [],
      comment: "",
      channel: "web",
      actor: "user",
      clearKind: "vote"
    });

    const remainingAfterVoteClear = await service.listFeedback(profileId, sessionId);
    expect(remainingAfterVoteClear).toHaveLength(1);
    expect(remainingAfterVoteClear[0]?.value).toBe("comment");

    await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-2",
      value: "up",
      reasonCodes: ["accuracy"],
      comment: "Nice answer",
      channel: "web",
      actor: "user"
    });

    await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-2",
      value: "comment",
      reasonCodes: ["accuracy"],
      comment: "I like this answer",
      channel: "web",
      actor: "user"
    });

    // Default clear (defaults to vote)
    await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-2",
      value: "clear",
      reasonCodes: [],
      comment: "",
      channel: "web",
      actor: "user"
    });

    const remainingAfterDefaultClear = await service.listFeedback(profileId, sessionId);
    expect(remainingAfterDefaultClear).toHaveLength(2);
    expect(remainingAfterDefaultClear.every((event) => event.value === "comment")).toBe(true);
    expect(remainingAfterDefaultClear.map((event) => event.targetId)).toContain("msg-1");
    expect(remainingAfterDefaultClear.map((event) => event.targetId)).toContain("msg-2");
  });
});

async function createTempDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "feedback-service-"));
  return join(root, "data");
}
