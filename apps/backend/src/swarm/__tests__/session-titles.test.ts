import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ManagerProfile } from "@forge/protocol";
import { placeholderSessionTitle } from "@forge/protocol/environment-v2";
import { isPlaceholderSessionTitle, sanitizeSessionTitle, SessionTitleError, SessionTitleNamer, setSessionAutoTitlesEnabled, titleProviderOrder } from "../session-titles.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";

// Ways a model reply can go wrong: quoted, JSON-wrapped, prefixed with "Title:", markdown, several
// lines, trailing punctuation, too long, empty, or the literal placeholder.
describe("sanitizeSessionTitle", () => {
  it.each([
    ["Fix sidebar rename race", "Fix sidebar rename race"],
    ['"Fix sidebar rename race."', "Fix sidebar rename race"],
    ["`Fix sidebar rename race`", "Fix sidebar rename race"],
    ["Title: Fix sidebar rename race", "Fix sidebar rename race"],
    ["**Fix sidebar rename race**", "Fix sidebar rename race"],
    ["# Fix sidebar rename race", "Fix sidebar rename race"],
    ['{"title":"Fix sidebar rename race"}', "Fix sidebar rename race"],
    ["\n\n  Fix   sidebar\trename race!?\nThis title names the bug.", "Fix sidebar rename race"],
    ["“Plan the fixture launch.”", "Plan the fixture launch"],
  ])("cleans %j", (raw, expected) => {
    expect(sanitizeSessionTitle(raw)).toBe(expected);
  });

  it("keeps at most eight words and 60 characters", () => {
    expect(sanitizeSessionTitle("one two three four five six seven eight nine ten")).toBe("one two three four five six seven eight");
    const long = sanitizeSessionTitle("Supercalifragilistic expialidocious antidisestablishmentarianism pneumonoultramicroscopic")!;
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).not.toMatch(/\s$/);
  });

  it.each(["", "   ", '""', "New session", "...", '{"title":""}'])("rejects %j", raw => {
    expect(sanitizeSessionTitle(raw)).toBeUndefined();
  });
});

describe("placeholder titles", () => {
  it("matches the first-prompt placeholder and the default names only", () => {
    const text = "I have a problem I'm wanting you to work on. The scenario is that the sidebar loses renames.";
    expect(placeholderSessionTitle(text)).toBe("I have a problem I'm wanting you to work on. The scenario…");
    expect(isPlaceholderSessionTitle(placeholderSessionTitle(text), text)).toBe(true);
    expect(isPlaceholderSessionTitle("New session", text)).toBe(true);
    expect(isPlaceholderSessionTitle("CLI session", text)).toBe(true);
    expect(isPlaceholderSessionTitle("Sidebar bug", text)).toBe(false);
    expect(isPlaceholderSessionTitle(undefined, text)).toBe(false);
  });
});

describe("titleProviderOrder", () => {
  it("tries the session's own native provider first, then the cheapest other configured one", () => {
    expect(titleProviderOrder("claude-native")).toEqual(["claude-native", "codex-native"]);
    expect(titleProviderOrder("codex-native")).toEqual(["codex-native", "claude-native"]);
    expect(titleProviderOrder("openai-codex")).toEqual(["claude-native", "codex-native"]);
    expect(titleProviderOrder(undefined)).toEqual(["claude-native", "codex-native"]);
  });
});

// Ways regeneration could go wrong: it reads only the first message, or every message unbounded, or
// assistant/worker text; it is skipped because auto-titles are off; it overwrites a rename made while
// it ran; it changes the title when generation fails; or it reports success with no title.
describe("SessionTitleNamer.regenerate", () => {
  async function fixture(messages: string[], generate: (message: string) => Promise<string | undefined>) {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-title-regen-"));
    await setSessionAutoTitlesEnabled(dataDir, false);
    const descriptor = { agentId: "session-1", role: "manager", profileId: "project-1", sessionLabel: "Original title", model: { provider: "codex-native" } } as AgentDescriptor;
    const history = messages.flatMap((text, index) => [
      { type: "conversation_message", role: "user", source: "user_input", text },
      { type: "conversation_message", role: "assistant", source: "speak_to_user", text: `assistant reply ${index}` },
    ]);
    const renames: string[] = [];
    const host = {
      getConfig: () => ({ paths: { dataDir } }) as SwarmConfig,
      getAgent: (id: string) => id === descriptor.agentId ? descriptor : undefined,
      getConversationHistory: () => history,
      listProfiles: () => [{ profileId: "project-1" } as ManagerProfile],
      renameSession: async (_id: string, label: string) => { renames.push(label); descriptor.sessionLabel = label; },
    };
    const inputs: string[] = [];
    const namer = new SessionTitleNamer(host, async (_descriptor, message) => { inputs.push(message); return generate(message); });
    return { namer, descriptor, renames, inputs };
  }

  it("names the thread from its first message and its most recent ones, bounded, even with auto-titles off", async () => {
    const long = `Recent ${"word ".repeat(1000)}`;
    const { namer, renames, inputs } = await fixture(["First goal", "Second", "Third", "Fourth", long], async () => "Ship the rollout");
    await expect(namer.regenerate("session-1")).resolves.toBe("Ship the rollout");
    expect(renames).toEqual(["Ship the rollout"]);
    const [input] = inputs;
    expect(input).toContain("First goal");
    for (const text of ["Third", "Fourth", "Recent"]) expect(input).toContain(text);
    expect(input).not.toContain("Second");
    expect(input).not.toContain("assistant reply");
    expect(input!.length).toBeLessThan(5_000);
  });

  it("uses the lone first message as is", async () => {
    const { namer, inputs } = await fixture(["Only message"], async () => "Only title");
    await namer.regenerate("session-1");
    expect(inputs).toEqual(["Only message"]);
  });

  it("lets a rename made while the title was generating win", async () => {
    let release!: () => void;
    const { namer, descriptor, renames } = await fixture(["First goal"], () => new Promise(resolve => { release = () => resolve("Generated title"); }));
    const pending = namer.regenerate("session-1");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    descriptor.sessionLabel = "My own name";
    release();
    await expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
    expect(renames).toEqual([]);
    expect(descriptor.sessionLabel).toBe("My own name");
  });

  it("leaves the title unchanged and says why when generation fails or no provider is signed in", async () => {
    const failed = await fixture(["First goal"], async () => undefined);
    await expect(failed.namer.regenerate("session-1")).rejects.toMatchObject({ code: "UNAVAILABLE", message: expect.stringMatching(/title/i) });
    const unavailable = await fixture(["First goal"], async () => { throw new SessionTitleError("UNAVAILABLE", "No signed-in provider on this machine can name threads."); });
    await expect(unavailable.namer.regenerate("session-1")).rejects.toThrow("No signed-in provider");
    for (const { renames, descriptor } of [failed, unavailable]) {
      expect(renames).toEqual([]);
      expect(descriptor.sessionLabel).toBe("Original title");
    }
  });

  it("rejects a thread with no messages and an unknown session", async () => {
    const { namer, inputs } = await fixture([], async () => "Unused");
    await expect(namer.regenerate("session-1")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(namer.regenerate("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(inputs).toEqual([]);
  });
});
