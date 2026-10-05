import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDescriptor } from "@forge/protocol";
import { isCliOriginatedSession } from "../notification-settings-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const user = (channel: string) => `${JSON.stringify({ type: "conversation_message", source: "user_input", sourceContext: { channel }, text: "hi" })}\n`;
const assistant = `${JSON.stringify({ type: "conversation_message", source: "speak_to_user", text: "x".repeat(4096) })}\n`;

async function session() {
  const root = await mkdtemp(join(tmpdir(), "forge-cli-origin-"));
  roots.push(root);
  const sessionFile = join(root, "session.jsonl");
  return { sessionFile, descriptor: { role: "manager", agentId: "m", sessionFile } as AgentDescriptor };
}

describe("isCliOriginatedSession", () => {
  it("tracks the latest user input across appends, partial lines, truncation and replacement", async () => {
    const { sessionFile, descriptor } = await session();
    await writeFile(sessionFile, user("cli") + assistant);
    expect(await isCliOriginatedSession(descriptor)).toBe(true);

    await appendFile(sessionFile, assistant.repeat(3));
    expect(await isCliOriginatedSession(descriptor)).toBe(true);

    // A partially written line is not consumed until its newline lands.
    const next = user("web");
    await appendFile(sessionFile, next.slice(0, 20));
    expect(await isCliOriginatedSession(descriptor)).toBe(true);
    await appendFile(sessionFile, next.slice(20));
    expect(await isCliOriginatedSession(descriptor)).toBe(false);

    // Truncation below the scanned offset rescans from the start.
    await truncate(sessionFile, 0);
    await appendFile(sessionFile, user("cli"));
    expect(await isCliOriginatedSession(descriptor)).toBe(true);

    // An atomically replaced file (new inode) is rescanned even when it is larger.
    const replacement = `${sessionFile}.next`;
    await writeFile(replacement, user("web") + assistant.repeat(4));
    await rename(replacement, sessionFile);
    expect(await isCliOriginatedSession(descriptor)).toBe(false);

    await rm(sessionFile);
    expect(await isCliOriginatedSession(descriptor)).toBe(false);
  });
});
