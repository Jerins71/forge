import { describe, expect, it } from "vitest";
import { placeholderSessionTitle } from "@forge/protocol/environment-v2";
import { isPlaceholderSessionTitle, sanitizeSessionTitle, titleProviderOrder } from "../session-titles.js";

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
