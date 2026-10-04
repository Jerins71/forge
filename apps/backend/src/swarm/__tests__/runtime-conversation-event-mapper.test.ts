import { describe, expect, it } from "vitest";
import { RuntimeConversationEventMapper } from "../session/runtime-conversation-event-mapper.js";
import type { RuntimeSessionEvent } from "../runtime-contracts.js";
import type { AgentDescriptor } from "../types.js";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";

function makeDescriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: overrides.agentId ?? "worker",
    displayName: overrides.displayName ?? "Worker",
    role: overrides.role ?? "worker",
    managerId: overrides.managerId ?? "manager",
    status: overrides.status ?? "idle",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    cwd: "/tmp/forge-test",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium"
    },
    sessionFile: "/tmp/forge-test/session.jsonl",
    ...overrides
  };
}

function mapRuntimeEvent(options: {
  agentId?: string;
  event: RuntimeSessionEvent;
  descriptor?: AgentDescriptor;
}) {
  return new RuntimeConversationEventMapper().mapRuntimeEvent({
    agentId: options.agentId ?? options.descriptor?.agentId ?? "worker",
    event: options.event,
    timestamp: FIXED_NOW,
    descriptor: options.descriptor
  });
}

describe("RuntimeConversationEventMapper", () => {
  it("strips full Codex Plugin content from worker and manager audit projections while preserving runtime result and preview", () => {
    const descriptor = makeDescriptor({ internalWorkerKind: "codex_plugin" } as Partial<AgentDescriptor>);
    const preview = "synthetic transcript preview";
    const transcriptTail = "SYNTHETIC_TRANSCRIPT_TAIL_SHOULD_NOT_PERSIST";
    const runtimeResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            selector: "fireflies/fetch_transcript",
            serverName: "fireflies",
            toolName: "fetch_transcript",
            preview,
            fullRedactedContent: `redacted transcript body ${transcriptTail}`,
            fullRedactedContentTruncated: false,
            redactedModelContent: `alternate full content ${transcriptTail}`,
            note:
              "fullRedactedContent is model-only; persisted audit rows must stay preview-bounded."
          })
        }
      ],
      details: {
        ok: true,
        selector: "fireflies/fetch_transcript",
        serverName: "fireflies",
        toolName: "fetch_transcript",
        preview,
        auditId: "audit-1"
      }
    };
    const event: RuntimeSessionEvent = {
      type: "tool_execution_end",
      toolName: "codex_fireflies_fetch_transcript",
      toolCallId: "tool-4",
      result: runtimeResult,
      isError: false
    };

    const projections = mapRuntimeEvent({ descriptor, event });

    expect(JSON.stringify(event.result)).toContain(transcriptTail);
    expect(JSON.stringify(event.result)).toContain("fullRedactedContent");
    expect(projections).toHaveLength(2);
    expect(projections).toMatchObject([
      { type: "agent_tool_call", kind: "tool_execution_end" },
      { type: "conversation_log", kind: "tool_execution_end" }
    ]);

    for (const projection of projections) {
      expect(projection.type === "agent_tool_call" || projection.type === "conversation_log").toBe(true);
      expect(projection.text).toContain(preview);
      expect(projection.text).toContain("fireflies/fetch_transcript");
      expect(projection.text).not.toContain(transcriptTail);
      expect(projection.text).not.toContain("fullRedactedContent");
      expect(projection.text).not.toContain("redactedModelContent");

      const persistedResult = JSON.parse(projection.text) as { content: Array<{ text: string }> };
      expect(JSON.parse(persistedResult.content[0]!.text)).toEqual(runtimeResult.details);
    }
  });

  it("sanitizes browser input and result audit projections without mutating immediate provider data", () => {
    const descriptor = makeDescriptor();
    const input = {
      tabId: "tab-1",
      expression: "document.body.innerText",
      awaitPromise: true,
      selector: "#SECRET_SELECTOR",
      locator: "role=button[name=SECRET_NAME]",
      name: "SECRET_ELEMENT_NAME",
      urlIncludes: "/secret-path",
    };
    const start = mapRuntimeEvent({
      descriptor,
      event: {
        type: "tool_execution_start",
        toolName: "browser_evaluate",
        toolCallId: "browser-1",
        args: input,
      },
    });
    expect(input.expression).toBe("document.body.innerText");
    expect(input.selector).toBe("#SECRET_SELECTOR");
    for (const projection of start) {
      expect(projection.text).not.toContain("document.body.innerText");
      expect(projection.text).not.toContain("SECRET");
      expect(projection.text).not.toContain("selector");
      expect(projection.text).not.toContain("locator");
      expect(projection.text).toContain("utf8Bytes");
      expect(JSON.parse(projection.text)).toMatchObject({
        tabId: "tab-1",
        awaitPromise: true,
        expression: { characters: 23, utf8Bytes: 23 },
      });
    }

    const screenshotData = "SCREENSHOT_BASE64_SECRET";
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            result: {
              tabId: "tab-1",
              url: "https://SNAPSHOT_URL_SECRET.test/page",
              title: "SNAPSHOT_TITLE_SECRET",
              visibleText: "PAGE_TEXT_SECRET",
              accessibility: { name: "A11Y_SECRET" },
              consoleEntries: [{ text: "CONSOLE_SECRET" }],
              networkEntries: [{ url: "https://secret.test/body" }],
              interactiveElements: [{ tag: "button", name: "Increment", selector: "#increment" }],
              actionTimeline: [{ id: "act-1", action: "click", status: "succeeded" }],
              selector: "#nested-selector-secret",
              screenshot: { data: screenshotData, mimeType: "image/png", width: 800, height: 600 },
            },
          }),
        },
        { type: "image", data: screenshotData, mimeType: "image/png" },
      ],
      details: {
        value: "EVALUATE_RESULT_SECRET",
        remoteObject: { description: "REMOTE_SECRET" },
        expression: "document.body.innerText",
        serializedBytes: 22,
        screenshot: { data: screenshotData, mimeType: "image/png", width: 800, height: 600 },
      },
    };
    const end = mapRuntimeEvent({
      descriptor,
      event: {
        type: "tool_execution_end",
        toolName: "browser_evaluate",
        toolCallId: "browser-1",
        result,
        isError: false,
      },
    });
    expect(JSON.stringify(result)).toContain(screenshotData);
    expect(JSON.stringify(result)).toContain("PAGE_TEXT_SECRET");
    for (const projection of end) {
      expect(projection.text).toContain("serializedBytes");
      expect(projection.text).toContain("image/png");
      expect(projection.text).not.toMatch(/SECRET|visibleText|accessibility|consoleEntries|networkEntries|remoteObject|interactiveElements|actionTimeline/);
      expect(projection.text).not.toContain("SNAPSHOT_URL_SECRET");
      expect(projection.text).not.toContain("SNAPSHOT_TITLE_SECRET");
      expect(projection.text).not.toContain(screenshotData);
      expect(projection.text).not.toContain("document.body.innerText");
      expect(projection.type === "agent_tool_call" || projection.type === "conversation_log").toBe(true);
    }
  });
});
