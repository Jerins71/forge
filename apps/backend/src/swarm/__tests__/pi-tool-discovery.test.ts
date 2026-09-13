import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import {
  AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry,
  SessionManager, SettingsManager, type AgentSession, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerFauxProvider } from "../pi/pi-ai-compat.js";
import { createPiBrowserDiscovery, installPiProjectToolPolicy } from "../runtime/pi/pi-tool-discovery.js";
import { createModelVisibleToolResultBudget } from "../model-visible-tool-result-budget.js";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function setup(sessionManager?: SessionManager) {
  const cwd = await mkdtemp(join(tmpdir(), "forge-discovery-test-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const faux = registerFauxProvider({ api: "forge-discovery-test", provider: "forge-discovery-test", models: [{ id: "fake" }] });
  cleanup.push(() => faux.unregister());
  const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Fixture inspected" }], details: {} }));
  const browser: ToolDefinition = { name: "browser_status", label: "Browser", description: "Inspect fixture", parameters: Type.Object({}), execute };
  const discovery = createPiBrowserDiscovery([browser]);
  const budget = createModelVisibleToolResultBudget();
  const customTools = [discovery.tool, browser];
  budget.augmentToolDefinitions(customTools);
  const authStorage = AuthStorage.inMemory({});
  authStorage.setRuntimeApiKey(faux.getModel().provider, "synthetic");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [discovery.extensionFactory, budget.extensionFactory], systemPrompt: "Offline fixture." });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir: cwd, authStorage, modelRegistry: ModelRegistry.inMemory(authStorage),
    model: faux.getModel(), settingsManager, resourceLoader, sessionManager: sessionManager ?? SessionManager.create(cwd, join(cwd, "sessions")),
    noTools: "all", tools: customTools.map(tool => tool.name), customTools });
  cleanup.push(() => session.dispose());
  budget.augmentSessionTools(session);
  await session.bindExtensions({});
  discovery.attach(session);
  return { session, discovery, faux, execute };
}

describe("Pi browser discovery", () => {
  it("loads typed browser tools between model calls in the same prompt and preserves result budgeting", async () => {
    const { session, faux, execute } = await setup();
    const requests: string[][] = [];
    const respond = (name?: string) => (context: { tools: Array<{ name: string; parameters: unknown }> }) => {
      requests.push(context.tools.map(tool => tool.name));
      for (const tool of context.tools) expect(tool.parameters).toHaveProperty("properties.max_output_tokens");
      return name ? fauxAssistantMessage(fauxToolCall(name, name === "discover_tools" ? { bundles: ["browser"] } : {}), { stopReason: "toolUse" }) : fauxAssistantMessage("Done");
    };
    faux.setResponses([respond("discover_tools"), respond("browser_status"), respond()]);
    await session.prompt("Inspect the fixture using browser tools.");
    expect(requests).toEqual([["discover_tools"], ["discover_tools", "browser_status"], ["discover_tools", "browser_status"]]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(session.agent.state.messages.filter(message => message.role === "toolResult" && message.isError)).toEqual([]);
    await session.reload();
    expect(session.getActiveToolNames()).toContain("browser_status");
    const restored = createPiBrowserDiscovery([session.getToolDefinition("browser_status")!]);
    restored.attach(session);
    expect(restored.snapshot().loaded).toBe(true);
  });

  it("restores browser activation from a reopened native transcript after compaction", async () => {
    const first = await setup();
    first.faux.setResponses([fauxAssistantMessage(fauxToolCall("discover_tools", { bundles: ["browser"] }), { stopReason: "toolUse" }), fauxAssistantMessage("Loaded")]);
    await first.session.prompt("Load browser.");
    const manager = first.session.sessionManager;
    manager.appendCompaction("Browser capability loaded.", manager.getLeafId()!, 500);
    expect(manager.buildSessionContext().messages.some(message => message.role === "toolResult")).toBe(false);
    const reopened = SessionManager.open(first.session.sessionFile!);
    const second = await setup(reopened);
    expect(second.discovery.snapshot().loaded).toBe(true);
    expect(second.session.getActiveToolNames()).toContain("browser_status");
    expect(second.execute).not.toHaveBeenCalled();
  });

  it("keeps unloaded tools deferred after reload; listing and invalid requests do not activate them", async () => {
    const { session, discovery } = await setup();
    expect(session.getActiveToolNames()).toEqual(["discover_tools"]);
    await session.reload();
    expect(session.getActiveToolNames()).toEqual(["discover_tools"]);
    await discovery.tool.execute("list", {}, undefined, undefined, {} as never);
    await expect(discovery.tool.execute("bad", { bundles: ["secrets"] }, undefined, undefined, {} as never)).rejects.toThrow("Unknown bundle");
    expect(session.getActiveToolNames()).toEqual(["discover_tools"]);
    expect(session.getAllTools().map(tool => tool.name)).toContain("browser_status");
  });

  it("restores only retained branch receipts and does not duplicate activation", async () => {
    const { session, faux, discovery } = await setup();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("discover_tools", { bundles: ["browser"] }), { stopReason: "toolUse" }), fauxAssistantMessage("Loaded")]);
    await session.prompt("Load browser.");
    await discovery.tool.execute("again", { bundles: ["browser"] }, undefined, undefined, {} as never);
    expect(session.getActiveToolNames().filter(name => name === "browser_status")).toHaveLength(1);
    // A new canonical branch must not inherit the previous branch's tools.
    await session.navigateTree(session.getUserMessagesForForking()[0]!.entryId, { summarize: false });
    expect(session.getActiveToolNames()).toEqual(["discover_tools"]);
    expect(discovery.snapshot().loaded).toBe(false);
  });

  it("suppresses secure schemas on the next request when a busy project's setting changes", () => {
    const streamFn = vi.fn();
    const session = { agent: { streamFn } } as unknown as AgentSession;
    let enabled = true;
    installPiProjectToolPolicy(session, () => enabled);
    const tools = ["read", "secure_session_status", "request_secret_access", "request_ssh_host_trust", "secure_bash"].map(name => ({ name }));
    session.agent.streamFn({} as never, { messages: [], tools } as never, {});
    expect(streamFn.mock.calls[0][1].tools).toHaveLength(5);
    enabled = false;
    session.agent.streamFn({} as never, { messages: [], tools } as never, {});
    expect(streamFn.mock.calls[1][1].tools).toEqual([{ name: "read" }]);
  });
});
