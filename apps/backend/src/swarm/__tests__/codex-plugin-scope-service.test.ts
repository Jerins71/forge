import { describe, expect, it } from "vitest";
import { CodexPluginScopeService, type CodexPluginScopeCatalogAdapter } from "../codex-app-server/codex-plugin-scope-service.js";
import { CodexMcpCatalog, type CodexCatalogSnapshot } from "../codex-app-server/codex-mcp-catalog.js";

function catalog(overrides: Partial<CodexCatalogSnapshot> = {}): CodexCatalogSnapshot {
  return {
    apps: [{ id: "fireflies", name: "Fireflies" }],
    plugins: [
      {
        selector: "fireflies",
        name: "fireflies",
        pluginId: "fireflies@openai-curated",
        displayName: "Fireflies",
        enabled: true,
        availability: "available",
      },
      {
        selector: "repo-prompt",
        name: "repo-prompt",
        pluginId: "repo-prompt",
        displayName: "RepoPrompt",
        enabled: true,
        availability: "available",
        relatedServerNames: ["RepoPrompt"],
      },
    ],
    tools: [
      {
        selector: "fireflies/list_recent",
        serverName: "fireflies",
        toolName: "list_recent",
        description: "List recent meetings",
        readOnly: true,
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
      },
      {
        selector: "fireflies/delete_meeting",
        serverName: "fireflies",
        toolName: "delete_meeting",
        description: "Delete a meeting",
        readOnly: true,
        annotations: { readOnlyHint: true },
      },
      {
        selector: "RepoPrompt/get_code_structure",
        serverName: "RepoPrompt",
        toolName: "get_code_structure",
        description: "Inspect repository structure",
        readOnly: true,
        annotations: { readOnlyHint: true },
      },
    ],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function adapter(snapshot: CodexCatalogSnapshot): CodexPluginScopeCatalogAdapter {
  const resolver = new CodexMcpCatalog(async () => {
    throw new Error("should not fetch");
  });

  return {
    listCatalog: async () => snapshot,
    resolvePlugin: (selector, current) => resolver.resolvePlugin(selector, current),
    resolveTool: (selector, current) => resolver.resolveTool(selector, current),
    filterToolsForAuthorizedSelectors: (current, selectors) =>
      resolver.filterToolsForAuthorizedSelectors(current, selectors),
  };
}

describe("CodexPluginScopeService", () => {
  it("materializes plugin scopes with only safe tools for that plugin", async () => {
    const service = new CodexPluginScopeService({ catalog: adapter(catalog()) });
    const { scope } = await service.materializePendingScope({
      managerAgentId: "manager",
      workerAgentId: "codex-plugin-fireflies",
      delegationId: "delegation-1",
      selectors: ["fireflies"],
    });

    expect(scope.allowedTools.map((tool) => tool.displaySelector)).toEqual(["fireflies/list_recent"]);
    expect(scope.allowedTools.some((tool) => tool.displaySelector.includes("delete"))).toBe(false);
    expect(scope.allowedTools.some((tool) => tool.serverName === "RepoPrompt")).toBe(false);
  });

  it("fails closed for disabled plugins and open-world exact tools", async () => {
    const disabledCatalog = catalog({
      plugins: [
        {
          selector: "fireflies",
          displayName: "Fireflies",
          enabled: false,
          availability: "disabled",
        },
      ],
    });
    await expect(
      new CodexPluginScopeService({ catalog: adapter(disabledCatalog) }).materializePendingScope({
        managerAgentId: "manager",
        workerAgentId: "worker",
        selectors: ["fireflies"],
      }),
    ).rejects.toThrow(/unavailable|disabled/i);

    const openWorldCatalog = catalog({
      tools: [
        {
          selector: "fireflies/list_recent",
          serverName: "fireflies",
          toolName: "list_recent",
          readOnly: true,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
      ],
    });
    await expect(
      new CodexPluginScopeService({ catalog: adapter(openWorldCatalog) }).materializePendingScope({
        managerAgentId: "manager",
        workerAgentId: "worker",
        selectors: ["fireflies/list_recent"],
      }),
    ).rejects.toThrow(/open-world/i);
  });

  it("rejects scoped tool calls after the worker scope is closed", async () => {
    const service = new CodexPluginScopeService({ catalog: adapter(catalog()) });
    const { scope } = await service.materializePendingScope({
      managerAgentId: "manager",
      workerAgentId: "codex-plugin-fireflies",
      delegationId: "delegation-1",
      selectors: ["fireflies"],
    });

    expect(() => service.authorizeScopedToolCall("codex-plugin-fireflies", scope.allowedTools[0]!.scopedToolName)).not.toThrow();
    expect(() => service.authorizeScopedToolCall("codex-plugin-fireflies", "codex_repoprompt_get_code_structure")).toThrow(/not allowed/i);

    service.activateScopeForWorker("codex-plugin-fireflies", "delegation-1");
    service.closeScopeForWorker("codex-plugin-fireflies");
    expect(() => service.authorizeScopedToolCall("codex-plugin-fireflies", scope.allowedTools[0]!.scopedToolName)).toThrow(/No active|closed/i);
  });
});
