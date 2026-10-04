import { describe, expect, it } from "vitest";
import { CodexMcpCatalog } from "../codex-app-server/codex-mcp-catalog.js";
import type { CodexAppServerClientPort } from "../codex-app-server/types.js";

class FakeCatalogClient implements CodexAppServerClientPort {
  readonly requests: Array<{ method: string; params?: unknown; timeoutMs?: number }> = [];

  async connect(): Promise<void> {}

  async request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    this.requests.push({ method, params, timeoutMs });

    if (method === "plugin/list") {
      return {
        plugins: [
          {
            id: "fireflies",
            name: "fireflies",
            displayName: "Fireflies",
            enabled: true,
            availability: "available",
            description: "Meeting notes",
            category: "productivity",
          },
          {
            pluginId: "repo-prompt",
            displayName: "RepoPrompt",
            enabled: true,
            availability: "available",
            description: "Repository browser tools",
            serverNames: ["RepoPrompt"],
          },
          {
            id: "disabled-only",
            name: "disabled_only",
            displayName: "Disabled Only",
            enabled: false,
            availability: "available",
          },
        ],
      } as T;
    }

    if (method === "app/list") {
      return {
        apps: [{ id: "fireflies", name: "Fireflies" }],
      } as T;
    }

    if (method === "mcpServerStatus/list") {
      return {
        servers: [
          {
            name: "fireflies",
            tools: [
              {
                name: "list_recent",
                description: "List recent meetings",
                readOnly: true,
                annotations: { readOnlyHint: true },
                inputSchema: {
                  type: "object",
                  properties: { limit: { type: "integer" } },
                  required: ["limit"],
                },
              },
            ],
          },
        ],
      } as T;
    }

    if (method === "mcpServer/tool/call") {
      return {
        content: [{ type: "text", text: "secret Bearer abc.def.ghi" }],
      } as T;
    }

    throw new Error(`Unexpected method: ${method}`);
  }

  notify(): void {}
  dispose(): void {}
  isDisposed(): boolean {
    return false;
  }
}

describe("CodexMcpCatalog", () => {
  it("validates required args and redacts tool output", async () => {
    const client = new FakeCatalogClient();
    const catalog = new CodexMcpCatalog(async () => client);
    const snapshot = await catalog.listCatalog(true);
    const tool = catalog.resolveTool("fireflies/list_recent", snapshot);
    expect(tool).toBeDefined();

    await expect(
      catalog.callTool(
        {
          managerAgentId: "manager",
          cwd: "/tmp",
          threadId: "thread-1",
          serverName: tool!.serverName,
          toolName: tool!.toolName,
        },
        tool!,
      ),
    ).rejects.toThrow(/Missing required Codex tool argument: limit/);

    const result = await catalog.callTool(
      {
        managerAgentId: "manager",
        cwd: "/tmp",
        threadId: "thread-1",
        serverName: tool!.serverName,
        toolName: tool!.toolName,
        args: { limit: 1, token: "Bearer raw-token-value" },
      },
      tool!,
    );

    expect(result.ok).toBe(true);
    expect(result.redactedPreview).toContain("[redacted]");
    expect(result.redactedPreview).not.toContain("abc.def.ghi");
    expect(Buffer.byteLength(result.redactedPreview, "utf8")).toBeLessThanOrEqual(2048);
    expect("content" in result).toBe(false);
    expect("structuredContent" in result).toBe(false);

    const callRequest = client.requests.find((entry) => entry.method === "mcpServer/tool/call");
    expect((callRequest?.params as { arguments?: Record<string, unknown> })?.arguments).toEqual({
      limit: 1,
      token: "Bearer raw-token-value",
    });
  });

  it("rejects non-read-only tools at call time", async () => {
    const client = new FakeCatalogClient();
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "mcpServerStatus/list") {
        return {
          servers: [
            {
              name: "fireflies",
              tools: [{ name: "delete_item", description: "Delete a record" }],
            },
          ],
        } as T;
      }
      return new FakeCatalogClient().request(method, params);
    };

    const catalog = new CodexMcpCatalog(async () => client);
    const snapshot = await catalog.listCatalog(true);
    const tool = catalog.resolveTool("fireflies/delete_item", snapshot)!;

    await expect(
      catalog.callTool(
        {
          managerAgentId: "manager",
          cwd: "/tmp",
          threadId: "thread-1",
          serverName: tool.serverName,
          toolName: tool.toolName,
        },
        tool,
      ),
    ).rejects.toThrow(/blocked/i);
  });

  it("fails closed on elicitation-style responses", async () => {
    const decliningClient: CodexAppServerClientPort = {
      ...new FakeCatalogClient(),
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "mcpServer/tool/call") {
          return { action: "decline" } as T;
        }
        return new FakeCatalogClient().request(method, params);
      },
    };

    const catalog = new CodexMcpCatalog(async () => decliningClient);
    const snapshot = await catalog.listCatalog(true);
    const tool = catalog.resolveTool("fireflies/list_recent", snapshot)!;

    const result = await catalog.callTool(
      {
        managerAgentId: "manager",
        cwd: "/tmp",
        threadId: "thread-1",
        serverName: tool.serverName,
        toolName: tool.toolName,
        args: { limit: 1 },
      },
      tool,
    );

    expect(result.ok).toBe(false);
    expect(result.errorPreview).toMatch(/approval/i);
    expect("error" in result).toBe(false);
  });
});
