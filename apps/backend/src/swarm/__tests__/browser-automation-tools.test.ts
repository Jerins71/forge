import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildBrowserAutomationTools } from "../browser-automation/browser-automation-tools.js";
import { buildBaseRuntimeTools, isBrowserAutomationEligible } from "../runtime/runtime-tool-plan.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import type { AgentDescriptor } from "../types.js";

function descriptor(patch: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: "manager-1",
    displayName: "Manager",
    role: "manager",
    managerId: "manager-1",
    status: "idle",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    cwd: "/repo",
    model: { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "medium" },
    sessionFile: "/data/session.jsonl",
    profileId: "profile-1",
    ...patch,
  };
}

function host(invoke = vi.fn(async (_agentId: string, operation: string) => ({ ok: true, operation, result: {} }))): SwarmToolHost {
  return {
    invokeBrowserAutomation: invoke,
    listAgents: () => [],
    getWorkerActivity: () => undefined,
  } as unknown as SwarmToolHost;
}

function byName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing ${name}`);
  return tool;
}

describe("browser automation tools", () => {
  it("preserves snapshot PNG as a native image while removing base64 from text and details", async () => {
    const invoke = vi.fn(async () => ({
      ok: true as const,
      operation: "snapshot" as const,
      result: {
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        loading: false,
        viewportSetting: { mode: "fill" as const },
        viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
        visibleText: "Hello",
        interactiveElements: [],
        accessibility: { role: "document" },
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
        compaction: { omitted: { consoleEntries: 1 } },
        screenshot: { mimeType: "image/png" as const, data: "U0VDUkVU", width: 800, height: 600 },
      },
    }));
    const tool = byName(buildBrowserAutomationTools(host(invoke), descriptor()), "browser_snapshot");
    const result = await tool.execute("call-1", {}, undefined, undefined, undefined as never) as {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      details: unknown;
    };
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text" }),
      { type: "image", data: "U0VDUkVU", mimeType: "image/png" },
    ]);
    expect(result.content[0]?.text).not.toContain("U0VDUkVU");
    expect(JSON.stringify(result.details)).not.toContain("U0VDUkVU");
    expect(result.details).toMatchObject({ ok: true, result: { compaction: { omitted: { consoleEntries: 1 } } } });
  });

  it("limits eligibility to normal local Builder managers", () => {
    expect(isBrowserAutomationEligible(descriptor())).toBe(true);
    expect(isBrowserAutomationEligible(descriptor({ role: "worker", managerId: "manager-1" }))).toBe(false);
    expect(isBrowserAutomationEligible(descriptor({ sessionPurpose: "capture_check" }))).toBe(false);
    expect(isBrowserAutomationEligible(descriptor({ sessionPurpose: "agent_creator" }))).toBe(false);
    expect(isBrowserAutomationEligible(descriptor({ archetypeId: "cortex" }))).toBe(false);
    expect(isBrowserAutomationEligible(descriptor({ cli: { transport: "headless", connectedAt: "2026-07-22T00:00:00.000Z" } as never }))).toBe(false);
    expect(buildBaseRuntimeTools(host(), descriptor()).map((tool) => tool.name)).toContain("browser_snapshot");
    expect(buildBaseRuntimeTools(host(), descriptor({ sessionPurpose: "capture_check" })).map((tool) => tool.name)).not.toContain("browser_snapshot");
  });
});
