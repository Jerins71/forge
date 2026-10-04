import { describe, expect, it } from "vitest";
import { boundCompactionPreparation } from "../compaction/forge-pi-compaction-bounds.js";

function createPreparation() {
  return {
    firstKeptEntryId: "entry-keep",
    messagesToSummarize: [
      {
        role: "user" as const,
        content: `User request start\n${"U".repeat(5_000)}\nUser request end`,
        timestamp: 1,
      },
      {
        role: "assistant" as const,
        api: "openai-codex-responses" as const,
        provider: "openai-codex" as const,
        model: "gpt-5.5",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse" as const,
        content: [
          { type: "thinking" as const, thinking: `think-${"T".repeat(4_000)}-end` },
          { type: "text" as const, text: `assistant-${"A".repeat(4_000)}-tail` },
          {
            type: "toolCall" as const,
            id: "tool-1",
            name: "write",
            arguments: {
              path: "src/file.ts",
              content: `${"x".repeat(4_000)}RAW_TOOL_SECRET${"y".repeat(4_000)}`,
              imageData: `data:image/png;base64,${"a".repeat(5_000)}`,
              encodedBlob: `${"Ab9+/".repeat(900)}==`,
              archiveData: `QUJDMTIz+/=${"AbC123".repeat(900)}`,
            },
          },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult" as const,
        toolCallId: "tool-1",
        toolName: "write",
        content: [{ type: "text" as const, text: `result-${"R".repeat(8_000)}-tail` }],
        isError: false,
        timestamp: 3,
      },
      {
        role: "custom" as const,
        customType: "custom_type",
        content: [{ type: "text" as const, text: `custom-${"C".repeat(6_000)}-tail` }],
        display: true,
        timestamp: 4,
      },
      {
        role: "user" as const,
        content: [{ type: "image" as const, mimeType: "image/png", data: "b".repeat(6_000) }],
        timestamp: 5,
      },
    ],
    turnPrefixMessages: [
      {
        role: "bashExecution" as const,
        command: "npm test",
        output: `bash-${"B".repeat(4_000)}-tail`,
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 6,
      },
    ],
    isSplitTurn: true,
    tokensBefore: 100,
    previousSummary: "Preserve this previous summary verbatim.",
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 2_000 },
  };
}

describe("forge pi compaction bounds", () => {
  it("keeps instrumentation/details redacted with no raw prompt payloads", () => {
    const secret = "VERY_SECRET_BOUNDING_VALUE";
    const preparation = createPreparation();
    preparation.messagesToSummarize.push({
      role: "assistant",
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.5",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      content: [{ type: "text", text: `${secret}${"z".repeat(5_000)}` }],
      timestamp: 7,
    });

    const result = boundCompactionPreparation(preparation, {
      customInstructions: `${secret}-INSTRUCTIONS`,
      maxPromptChars: 2_400,
    });

    const serializedStats = JSON.stringify(result.stats);
    expect(serializedStats).not.toContain(secret);
    expect(serializedStats).not.toContain(`${secret}-INSTRUCTIONS`);
    expect(serializedStats).toContain("promptChars");
    expect(serializedStats).toContain("base64_payload");
  });
});
