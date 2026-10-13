import { isEligibleBrowserManager } from "../browser-automation/browser-automation-manager-adapter.js";
import { getCatalogProvider, type ProviderScope, type ProviderToolHostMechanism } from "@forge/protocol";
import type { ToolHostBinding } from "./provider-contract.js";
import type { SecureRuntimeBinding } from "../secure-sessions/runtime/secure-runtime-binding.js";
import { Clone } from "@sinclair/typebox";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CompactionRuntimeSettingsProvider } from "../compaction-runtime-settings-provider.js";
import { createConfiguredForgePiCompactionAuthResolver } from "../compaction/forge-pi-compaction-auth.js";
import { createForgePiCompactionExtensionFactory } from "../compaction/forge-pi-compaction-extension.js";
import { buildCreateProjectAgentTool } from "../agents/agent-creator-tool.js";
import { buildBrowserAutomationTools } from "../browser-automation/browser-automation-tools.js";
import { buildCreateSessionTool } from "../agents/create-session-tool.js";
import type { CredentialPoolService } from "../credential-pool.js";
import type { ForgeExtensionHost } from "../forge-extension-host.js";
import type { ForgePreparedRuntimeBindings } from "../forge-extension-types.js";
import { wrapForgeToolsWithExtensionHooks } from "../forge-instrumented-tools.js";
import { buildForgePiToolBridgeExtensionFactory } from "../forge-pi-tool-bridge.js";
import { createCatalogRequestBehaviorExtensionFactory } from "../catalog/model-catalog-request-behaviors.js";
import type { OpenAIAuthBrokerRuntimeService } from "../openai-auth/openai-auth-broker-runtime-service.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import { buildSwarmTools } from "../swarm-tools.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";

interface PlanRuntimeToolsOptions {
  host: SwarmToolHost;
  descriptor: AgentDescriptor;
  forgeExtensionHost: ForgeExtensionHost;
  preparedForgeBindings?: ForgePreparedRuntimeBindings | null;
}

export interface RuntimeToolPlan {
  baseSwarmTools: ToolDefinition[];
  swarmTools: ToolDefinition[];
}

export function planRuntimeTools(options: PlanRuntimeToolsOptions): RuntimeToolPlan {
  // Runtime instrumentation (including Pi's output-budget parameter) must not
  // mutate module-level schemas used by other sessions or providers.
  const baseSwarmTools = buildBaseRuntimeTools(options.host, options.descriptor)
    .map(tool => ({ ...tool, parameters: Clone(tool.parameters) }));
  const swarmTools = options.preparedForgeBindings
    ? wrapForgeToolsWithExtensionHooks({
        tools: baseSwarmTools,
        forgeExtensionHost: options.forgeExtensionHost,
        bindingToken: options.preparedForgeBindings.bindingToken,
        host: options.host,
        descriptor: options.descriptor
      })
    : baseSwarmTools;

  return { baseSwarmTools, swarmTools };
}

/** Binds the final active tool set; provider-specific schema conversion remains in its native host. */
export function bindRuntimeToolHost(options: {
  descriptor: AgentDescriptor;
  tools: readonly ToolDefinition[];
  forgeExtensionHost?: ForgeExtensionHost;
  preparedForgeBindings?: ForgePreparedRuntimeBindings | null;
  secureRuntimeBinding?: SecureRuntimeBinding;
  mechanism?: ProviderToolHostMechanism;
  scope?: ProviderScope;
}): ToolHostBinding {
  const tools = new Map(options.tools.map(tool => [tool.name, tool]));
  return {
    snapshot: { version: 1, actorAgentId: options.descriptor.agentId,
      ...(options.mechanism ? { mechanism: options.mechanism } : {}),
      tools: options.tools.map(tool => ({ name: tool.name, description: tool.description,
        inputSchema: JSON.parse(JSON.stringify(tool.parameters)) })),
      eligibility: { browser: isBrowserAutomationEligible(options.descriptor), internalSession: isInternalSessionPurpose(options.descriptor), role: options.descriptor.role },
    },
    tools: options.tools,
    ...(options.forgeExtensionHost && options.preparedForgeBindings ? { extensionHooks: {
      host: options.forgeExtensionHost, bindingToken: options.preparedForgeBindings.bindingToken,
    } } : {}),
    ...(options.secureRuntimeBinding ? { security: options.secureRuntimeBinding } : {}),
    async invoke(call) {
      call.signal?.throwIfAborted();
      if (call.ref.threadId !== options.descriptor.agentId) throw new Error("Tool call actor does not match its host binding.");
      if (options.scope && (call.ref.bindingId !== options.scope.bindingId || call.ref.generation !== options.scope.generation)) {
        throw new Error("Tool call binding or generation is stale.");
      }
      const tool = tools.get(call.name);
      if (!tool) throw new Error("Unknown Forge tool");
      return tool.execute(call.ref.nativeId, call.args, call.signal, call.onUpdate, call.context);
    },
    // Accidental JSONL/SQLite/diagnostic serialization must fail, including when no grant is active.
    toJSON() { throw new Error("ToolHostBinding is ephemeral; serialize only its snapshot."); },
  };
}

export function planForgePiToolBridgeFactory(options: {
  forgeExtensionHost: ForgeExtensionHost;
  preparedForgeBindings?: ForgePreparedRuntimeBindings | null;
  baseSwarmTools: readonly ToolDefinition[];
  host?: SwarmToolHost;
  descriptor?: AgentDescriptor;
}): ExtensionFactory | undefined {
  return options.preparedForgeBindings
    ? buildForgePiToolBridgeExtensionFactory({
        forgeExtensionHost: options.forgeExtensionHost,
        bindingToken: options.preparedForgeBindings.bindingToken,
        skippedToolNames: options.baseSwarmTools.map((tool) => tool.name),
        host: options.host,
        descriptor: options.descriptor
      })
    : undefined;
}

export function buildBaseRuntimeTools(host: SwarmToolHost, descriptor: AgentDescriptor): ToolDefinition[] {
  const swarmTools = buildSwarmTools(host, descriptor);

  if (descriptor.role !== "manager") {
    return swarmTools;
  }

  if (isBrowserAutomationEligible(descriptor)) {
    swarmTools.push(...buildBrowserAutomationTools(host, descriptor));
  }

  if (descriptor.projectAgent?.capabilities?.includes("create_session")) {
    swarmTools.push(buildCreateSessionTool(host, descriptor));
  }

  if (descriptor.sessionPurpose === "agent_creator") {
    swarmTools.push(buildCreateProjectAgentTool(host, descriptor));
  }

  if (descriptor.sessionPurpose === "side_chat") {
    return swarmTools.filter((tool) => SIDE_CHAT_TOOL_NAMES.has(tool.name));
  }

  return swarmTools;
}

interface PlanPiExtensionFactoriesOptions {
  descriptor: AgentDescriptor;
  config: SwarmConfig;
  logDebug: (message: string, details?: unknown) => void;
  getCompactionRuntimeSettingsProvider: () => CompactionRuntimeSettingsProvider;
  getPiModelsJsonPath?: () => string;
  getCredentialPoolService?: () => CredentialPoolService;
  getOpenAIAuthBrokerRuntimeService?: () => OpenAIAuthBrokerRuntimeService;
  forgePiToolBridgeFactory?: ExtensionFactory;
  compactionFailureScopeKey?: string;
  toolOutputBudgetExtensionFactory: ExtensionFactory;
}

export function planPiExtensionFactories(options: PlanPiExtensionFactoriesOptions): ExtensionFactory[] {
  const { descriptor } = options;
  const factories: ExtensionFactory[] = [];

  if (descriptor.role === "manager" && descriptor.profileId) {
    factories.push(createForgePiCompactionExtensionFactory({
      descriptor,
      config: options.config,
      logDebug: options.logDebug,
      getCompactionRuntimeSettingsProvider: options.getCompactionRuntimeSettingsProvider,
      resolveCompactionAuth: options.getPiModelsJsonPath
        ? createConfiguredForgePiCompactionAuthResolver({
            config: options.config,
            descriptor,
            getPiModelsJsonPath: options.getPiModelsJsonPath,
            getCredentialPoolService: options.getCredentialPoolService,
            getOpenAIAuthBrokerRuntimeService: options.getOpenAIAuthBrokerRuntimeService,
          })
        : undefined,
      failureScopeKey: options.compactionFailureScopeKey,
    }));
  }

  if (process.env.FORGE_DEBUG === "true") {
    factories.push((pi) => {
      pi.on("tool_call", (event) => {
        try {
          options.logDebug("extension:tool_call", {
            agentId: descriptor.agentId,
            toolName: event.toolName,
            inputPreview: previewJsonForLog(event.input, 200)
          });
        } catch {
          // Extension handler errors must not propagate into tool execution
        }
      });
    });
  }

  if (options.forgePiToolBridgeFactory) {
    // Ordering relative to user Pi extensions is intentionally unspecified in v1.
    factories.push(options.forgePiToolBridgeFactory);
  }

  const provider = getCatalogProvider(descriptor.model.provider);
  if (provider?.requestBehaviorId) {
    factories.push(
      createCatalogRequestBehaviorExtensionFactory({
        webSearchEnabled: descriptor.webSearch === true
      })
    );
  }

  // This must remain last: it is the final model-visible result governor after
  // every user and Forge extension has had a chance to transform tool output.
  factories.push(options.toolOutputBudgetExtensionFactory);

  return factories;
}

function previewJsonForLog(value: unknown, maxLength = 160): string {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) {
      return "<unserializable>";
    }
    return previewForLog(serialized, maxLength);
  } catch {
    return "<unserializable>";
  }
}

function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

/** Internal purposes (agent creation). A side chat is an ordinary conversation. */
export function isInternalSessionPurpose(descriptor: Pick<AgentDescriptor, "sessionPurpose">): boolean {
  return descriptor.sessionPurpose !== undefined && descriptor.sessionPurpose !== "side_chat";
}

export const isBrowserAutomationEligible = isEligibleBrowserManager;

// A side chat is a temporary aside: no delegation, scheduling, peer messaging,
// user publication, new secret requests, or durable memory/knowledge writes.
const SIDE_CHAT_TOOL_NAMES = new Set(["present_choices", "secure_session_status"]);
