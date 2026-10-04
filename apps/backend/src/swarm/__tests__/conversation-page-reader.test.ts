import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConversationHistoryPage } from "../session/conversation-page-reader.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture(): { root: string; sessionFile: string } {
  const root = mkdtempSync(join(tmpdir(), "forge-conversation-page-"));
  roots.push(root);
  return { root, sessionFile: join(root, "session.jsonl") };
}

function conversationRow(index: number): string {
  return JSON.stringify({
    type: "custom",
    customType: "swarm_conversation_entry",
    id: `row-${index}`,
    parentId: index > 0 ? `row-${index - 1}` : null,
    timestamp: new Date(index * 1000).toISOString(),
    data: {
      type: "conversation_message",
      id: `message-${index}`,
      agentId: "worker",
      role: "assistant",
      text: `message ${index}`,
      timestamp: new Date(index * 1000).toISOString(),
      source: "system",
    },
  });
}

describe("readConversationHistoryPage", () => {
  it("fills wire pages across retired-source rows while retaining them for internal cold loads", () => {
    const { sessionFile } = createFixture();
    const rows = [0, 1, 2].map((index) => {
      const row = JSON.parse(conversationRow(index)) as { data: { sourceContext?: { channel: string } } };
      row.data.sourceContext = { channel: index === 1 ? "telegram" : "web" };
      return JSON.stringify(row);
    });
    writeFileSync(sessionFile, `${rows.join("\n")}\n`);

    const wirePage = readConversationHistoryPage({ sessionFile, limit: 2 });
    expect(wirePage.messages.map((entry) => entry.type === "conversation_message" ? entry.id : "unexpected"))
      .toEqual(["message-0", "message-2"]);
    expect(JSON.stringify(wirePage)).not.toContain("message 1");

    const internalPage = readConversationHistoryPage({ sessionFile, limit: 3, projectForWire: false });
    expect(internalPage.messages.map((entry) => entry.type === "conversation_message" ? entry.id : "unexpected"))
      .toEqual(["message-0", "message-1", "message-2"]);
  });
});
