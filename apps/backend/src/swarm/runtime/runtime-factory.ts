import { runtimeProviderCapabilities } from "./provider-selection.js";
import { type AgentRuntimeExtensionSnapshot, type InstructionBundle } from "@forge/protocol";
import type { ObservabilityFacade } from "../../observability/observability-types.js";
import type { CredentialPoolService } from "../credential-pool.js";
import type { OpenAIAuthBrokerRuntimeService } from "../openai-auth/openai-auth-broker-runtime-service.js";
import type { ForgeExtensionHost } from "../forge-extension-host.js";
import type { ProjectExecutableTrustPlan } from "../project-executable-trust.js";
import type {
  RuntimeCreationOptions,
  RuntimeErrorEvent,
  RuntimeGenerationEvent,
  RuntimeSessionEvent,
  SwarmAgentRuntime
} from "../runtime-contracts.js";
import type { SkillMetadata } from "../skills/skill-metadata-service.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  SwarmConfig
} from "../types.js";
import type { CompactionRuntimeSettingsProvider } from "../compaction-runtime-settings-provider.js";
import { assertForgeRuntimeEligibleDescriptor } from "../external-thread-compatibility.js";
import { assertSwarmModelIdNotRetired } from "../catalog/model-presets.js";
import { assertProviderRequirements } from "./provider-contract.js";
import { createInstructionBundle, renderInstructionBundle } from "./instruction-bundle.js";
import { PiRuntimeCreator } from "./pi/pi-runtime-creator.js";
import { CursorSdkRuntimeCreator } from "./cursor-sdk/cursor-sdk-runtime-creator.js";
import { ClaudeRuntimeCreator } from "./claude/claude-runtime-creator.js";
import { CodexRuntimeCreator } from "./codex/codex-runtime-creator.js";
import {
  SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE,
  type GetSecureRuntimeBinding,
} from "../secure-sessions/runtime/secure-runtime-binding.js";

interface RuntimeFactoryDependencies {
  host: SwarmToolHost;
  forgeExtensionHost: ForgeExtensionHost;
  config: SwarmConfig;
  now: () => string;
  logDebug: (message: string, details?: unknown) => void;
  getPiModelsJsonPath: () => string;
  getAgentDescriptor?: (agentId: string) => AgentDescriptor | undefined;
  getSecureRuntimeBinding?: GetSecureRuntimeBinding;
  getCredentialPoolService?: () => CredentialPoolService;
  getOpenAIAuthBrokerRuntimeService?: () => OpenAIAuthBrokerRuntimeService;
  observability?: ObservabilityFacade;
  getCompactionRuntimeSettingsProvider: () => CompactionRuntimeSettingsProvider;
  onSessionFileRotated?: (descriptor: AgentDescriptor, sessionFile: string) => Promise<void>;
  getMemoryRuntimeResources: (descriptor: AgentDescriptor) => Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
    skillMetadata: SkillMetadata[];
  }>;
  getSwarmContextFiles: (cwd: string) => Promise<Array<{ path: string; content: string }>>;
  resolveProjectExecutableTrustPlan: (options: {
    descriptor: AgentDescriptor;
    sessionDescriptor?: AgentDescriptor;
  }) => Promise<ProjectExecutableTrustPlan>;
  buildCursorSdkRuntimeInstructionBundle?: (descriptor: AgentDescriptor, systemPrompt: InstructionBundle | string) => Promise<InstructionBundle>;
  buildCursorSdkRuntimeSystemPrompt: (descriptor: AgentDescriptor, systemPrompt: string) => Promise<string>;
  mergeRuntimeContextFiles: (
    baseAgentsFiles: Array<{ path: string; content: string }>,
    options: {
      memoryContextFile: { path: string; content: string };
      swarmContextFiles: Array<{ path: string; content: string }>;
    }
  ) => Array<{ path: string; content: string }>;
  callbacks: {
    onStatusChange: (
      runtimeToken: number,
      agentId: string,
      status: AgentStatus,
      pendingCount: number,
      contextUsage?: AgentContextUsage
    ) => Promise<void>;
    onSessionEvent: (runtimeToken: number, agentId: string, event: RuntimeSessionEvent) => Promise<void>;
    onAgentEnd: (runtimeToken: number, agentId: string) => Promise<void>;
    onRuntimeError: (runtimeToken: number, agentId: string, error: RuntimeErrorEvent) => Promise<void>;
    onGenerationEvent?: (
      runtimeToken: number,
      agentId: string,
      event: RuntimeGenerationEvent,
    ) => Promise<void>;
    onRuntimeExtensionSnapshot: (
      runtimeToken: number,
      agentId: string,
      snapshot: AgentRuntimeExtensionSnapshot
    ) => Promise<void>;
    /** Projector ground truth: epoch-ms of last user-facing manager output (see SwarmRuntimeCallbacks). */
    getLastUserFacingManagerOutputAt?: (agentId: string) => number | undefined;
  };
}

export class RuntimeFactory {
  private readonly cursorSdkRuntimeCreator: CursorSdkRuntimeCreator;
  private readonly piRuntimeCreator: PiRuntimeCreator;

  constructor(private readonly deps: RuntimeFactoryDependencies) {
    this.cursorSdkRuntimeCreator = new CursorSdkRuntimeCreator(deps);
    this.piRuntimeCreator = new PiRuntimeCreator(deps);
  }

  async createRuntimeForDescriptor(descriptor: AgentDescriptor, instructions: InstructionBundle | string, runtimeToken = 0, options?: RuntimeCreationOptions): Promise<SwarmAgentRuntime> {
    const runtime = await this.create(descriptor, instructions, runtimeToken, options);
    try {
      if (!runtime.providerAdapter) throw new Error("Runtime has no provider adapter");
      assertProviderRequirements(runtime.providerAdapter.capabilities(), { ...options?.providerRequirements, ...(options?.secureRuntimeRequired || options?.secureRuntimeBinding ? { secureSessions:true } : {}) });
      return runtime;
    } catch (error) { await runtime.terminate({ abort:true }); throw error; }
  }

  private async create(
    descriptor: AgentDescriptor,
    instructions: InstructionBundle | string,
    runtimeToken = 0,
    options?: RuntimeCreationOptions
  ): Promise<SwarmAgentRuntime> {
    assertForgeRuntimeEligibleDescriptor(descriptor, "create runtime");
    assertSwarmModelIdNotRetired(
      descriptor.model.provider,
      descriptor.model.modelId,
      "runtime model",
    );
    const instructionBundle = typeof instructions === "string"
      ? options?.instructionBundle ?? createInstructionBundle(descriptor, instructions)
      : instructions;
    const systemPrompt = renderInstructionBundle(instructionBundle);
    const secureRuntimeBinding =
      options?.secureRuntimeBinding ??
      await this.resolveSecureRuntimeBinding(descriptor, runtimeToken);
    if (options?.secureRuntimeRequired && !secureRuntimeBinding) {
      throw new Error(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);
    }
    const creationOptions = { ...options, instructionBundle, ...(secureRuntimeBinding ? { secureRuntimeBinding } : {}) };

    const provider=runtimeProviderCapabilities(descriptor.model.provider).provider;
    if (["codex", "claude"].includes(provider)) {
      const creator = provider === "codex" ? new CodexRuntimeCreator(this.deps) : new ClaudeRuntimeCreator(this.deps);
      return creator.create({ descriptor, sessionDescriptor: this.getForgeSessionDescriptor(descriptor), systemPrompt, runtimeToken, creationOptions,
        callbacks: {
          onStatusChange: (...args) => this.deps.callbacks.onStatusChange(runtimeToken, ...args),
          onSessionEvent: (...args) => this.deps.callbacks.onSessionEvent(runtimeToken, ...args),
          onAgentEnd: (...args) => this.deps.callbacks.onAgentEnd(runtimeToken, ...args),
          onRuntimeError: (...args) => this.deps.callbacks.onRuntimeError(runtimeToken, ...args),
        },
      });
    }

    if (provider === "cursor-sdk") {
      return this.cursorSdkRuntimeCreator.createRuntimeForDescriptor({
        descriptor,
        systemPrompt,
        runtimeToken,
        sessionDescriptor: this.getForgeSessionDescriptor(descriptor),
        creationOptions
      });
    }

    if (isAcpModelDescriptor(descriptor.model)) {
      throw new Error("Cursor ACP has been removed. Restart Forge to migrate this agent to Cursor SDK Composer 2.5, or change the model manually.");
    }

    return this.piRuntimeCreator.createRuntimeForDescriptor({
      descriptor,
      systemPrompt,
      runtimeToken,
      sessionDescriptor: this.getForgeSessionDescriptor(descriptor),
      creationOptions
    });
  }

  private async resolveSecureRuntimeBinding(
    descriptor: AgentDescriptor,
    runtimeToken: number,
  ) {
    if (!this.deps.getSecureRuntimeBinding) {
      return undefined;
    }

    try {
      return await this.deps.getSecureRuntimeBinding(descriptor, runtimeToken);
    } catch {
      throw new Error(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);
    }
  }

  private getForgeSessionDescriptor(descriptor: AgentDescriptor): AgentDescriptor | undefined {
    if (descriptor.role === "manager") {
      return descriptor;
    }

    const sessionDescriptor = this.deps.getAgentDescriptor?.(descriptor.managerId);
    return sessionDescriptor?.role === "manager" ? sessionDescriptor : undefined;
  }
}

function isAcpModelDescriptor(descriptor: Pick<AgentModelDescriptor, "provider">): boolean {
  return descriptor.provider.trim().toLowerCase() === "cursor-acp";
}
