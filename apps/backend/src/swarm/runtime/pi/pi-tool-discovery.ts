import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { AgentSession, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";

const RECEIPT = "forgeToolDiscovery";
const SECURE_TOOLS = new Set(["secure_session_status", "request_secret_access", "request_ssh_host_trust", "secure_bash"]);

/** Browser visibility is runtime-local; the ordinary tool registry still owns execution. */
export function createPiBrowserDiscovery(browserTools: readonly ToolDefinition[]) {
  const names = browserTools.map(tool => tool.name);
  const nameSet = new Set(names);
  const fingerprint = createHash("sha256").update(JSON.stringify(browserTools.map(tool => ({
    name: tool.name, description: tool.description, parameters: tool.parameters,
  })))).digest("hex");
  let session: AgentSession | undefined;
  let loaded = false;

  const restore = () => {
    loaded = session!.sessionManager.getBranch().some(entry => {
      if (entry.type !== "message" || entry.message.role !== "toolResult") return false;
      const message = entry.message;
      if (message.toolName !== "discover_tools" || message.isError) return false;
      const receipt = (message.details as Record<string, unknown> | undefined)?.[RECEIPT];
      return typeof receipt === "object" && receipt !== null
        && (receipt as { version?: unknown }).version === 1
        && (receipt as { browser?: unknown }).browser === true;
    });
  };
  const apply = () => {
    const current = session!.getActiveToolNames();
    const available = new Set(session!.getAllTools().map(tool => tool.name));
    const next = loaded
      ? [...new Set([...current, ...names.filter(name => available.has(name))])]
      : current.filter(name => !nameSet.has(name));
    if (JSON.stringify(current) !== JSON.stringify(next)) session!.setActiveToolsByName(next);
  };
  const tool: ToolDefinition = {
    name: "discover_tools",
    label: "Discover tools",
    description: "Load optional capabilities for this actor. Available bundle: browser — inspect and interact with web pages, select existing Chrome tabs, take screenshots, and record the embedded browser. Call with bundles:[\"browser\"] before using browser tools. Omit bundles to list capabilities. Loading does not open or operate the browser; typed tools become available on the next model call.",
    parameters: Type.Object({ bundles: Type.Optional(Type.Array(Type.Literal("browser"), { minItems: 1, maxItems: 1, uniqueItems: true })) }, { additionalProperties: false }),
    async execute(_id, input) {
      if (!session) throw new Error("Tool discovery is not ready");
      const bundles = (input as { bundles?: unknown }).bundles;
      if (bundles !== undefined && (!Array.isArray(bundles) || bundles.length !== 1 || bundles[0] !== "browser")) {
        throw new Error("Unknown bundle. Available: browser.");
      }
      if (bundles === undefined) {
        return { content: [{ type: "text", text: JSON.stringify({ bundles: [{ id: "browser", loaded, description: "Page inspection, interaction, screenshots, and embedded recording." }] }) }], details: {} };
      }
      const registered = new Set(session.getAllTools().map(entry => entry.name));
      if (!names.every(name => registered.has(name))) {
        throw new Error("Browser tools are not available in this runtime.");
      }
      loaded = true;
      apply();
      const details = { [RECEIPT]: { version: 1, browser: true, fingerprint } };
      return { content: [{ type: "text", text: JSON.stringify({ loaded: "browser", tools: names, guidance: "Use browser_status to inspect available tabs and browser_open to select one. Take a snapshot before interacting. Browser recording is embedded-only." }) }], details };
    },
  };
  const extensionFactory: ExtensionFactory = (pi) => {
    const refresh = () => { if (session) { restore(); apply(); } };
    pi.on("session_start", refresh);
    pi.on("session_tree", refresh);
  };
  return {
    tool,
    extensionFactory,
    attach(target: AgentSession) {
      session = target;
      restore();
      apply();
      // Compose with the installed budget reload wrapper, after it re-augments schemas.
      const reload = target.reload.bind(target);
      target.reload = async (...args) => { await reload(...args); restore(); apply(); };
    },
    snapshot: () => ({ fingerprint, deferredToolCount: loaded ? 0 : names.length, loaded }),
  };
}

/** A busy runtime cannot recycle mid-command. Suppress disabled project tools on its very next request. */
export function installPiProjectToolPolicy(session: AgentSession, enabled: () => boolean): void {
  const stream = session.agent.streamFn;
  session.agent.streamFn = (model, context, options) => stream.call(session.agent, model, enabled() ? context : {
    ...context, tools: context.tools?.filter(tool => !SECURE_TOOLS.has(tool.name)),
  }, options);
}
