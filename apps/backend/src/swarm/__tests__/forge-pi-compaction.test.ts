import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { compact as runPiCompaction } from "@earendil-works/pi-coding-agent";
import { runForgePiCompaction } from "../compaction/forge-pi-compaction.js";
import { createStaticCompactionRuntimeSettingsProvider } from "../compaction-runtime-settings-provider.js";
import { makeCompactionGuardDescriptor } from "../../test-support/compaction-guard-harness.js";

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
    "@earendil-works/pi-coding-agent",
  );
  return {
    ...actual,
    compact: vi.fn(async () => ({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 100,
      details: { readFiles: [], modifiedFiles: [] },
    })),
  };
});

const runPiCompactionMock = vi.mocked(runPiCompaction);

describe("forge pi compaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses configured compaction model and reasoning instead of the active session model", async () => {
    const compactionModel = {
      provider: "openai-codex",
      id: "gpt-5.5",
      reasoning: true,
    };
    const sessionModel = {
      provider: "openai-codex",
      id: "gpt-5.4",
      reasoning: true,
    };
    const modelRegistry = {
      find: vi.fn((provider: string, modelId: string) => {
        if (provider === "openai-codex" && modelId === "gpt-5.5") {
          return compactionModel;
        }
        return undefined;
      }),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true as const,
        apiKey: "compaction-key",
        headers: { Authorization: "Bearer compaction-key", "x-session-id": "sess-1" },
      })),
    } as unknown as ModelRegistry;

    const compactionSettings = createStaticCompactionRuntimeSettingsProvider({
      timeoutMs: 300_000,
      model: { provider: "openai-codex", modelId: "gpt-5.5" },
      reasoningLevel: "low",
    }).getCompactionRuntimeSettings();

    const signal = new AbortController().signal;
    await runForgePiCompaction({
      event: {
        preparation: {
          firstKeptEntryId: "entry-1",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 100,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
          settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
        },
        customInstructions: "Focus on deployment details.",
        signal,
      },
      ctx: { model: sessionModel as never, modelRegistry },
      descriptor: makeCompactionGuardDescriptor(),
      compactionSettings,
      combinedInstructions: "Focus on deployment details.",
      pinnedInstructionsMerged: false,
      logDebug: vi.fn(),
    });

    expect(modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(compactionModel);
    expect(runPiCompactionMock).toHaveBeenCalledWith(
      expect.any(Object),
      compactionModel,
      "compaction-key",
      expect.objectContaining({ Authorization: "Bearer compaction-key" }),
      "Focus on deployment details.",
      signal,
      "low",
      undefined,
      undefined,
    );
    expect(runPiCompactionMock.mock.calls[0]?.[1]).not.toEqual(sessionModel);
  });
});
