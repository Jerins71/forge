import { randomUUID } from "node:crypto";
import { assembleNativeInstructionBundle } from "../../runtime-prompt-assembler.js";
import { renderInstructionBundle } from "../instruction-bundle.js";
import { createNativeSecureBashTool } from "../../secure-sessions/runtime/native-secure-bash-tool.js";
import type { ForgeExtensionHost } from "../../forge-extension-host.js";
import type { ProjectExecutableTrustPlan } from "../../project-executable-trust.js";
import type { RuntimeCreationOptions, SwarmAgentRuntime, SwarmRuntimeCallbacks } from "../../runtime-contracts.js";
import type { SwarmToolHost } from "../../swarm-tool-host.js";
import type { AgentDescriptor, SwarmConfig } from "../../types.js";
import type { SkillMetadata } from "../../skills/skill-metadata-service.js";
import { isInternalSessionPurpose, planRuntimeTools, bindRuntimeToolHost } from "../runtime-tool-plan.js";
import { assertClaudeSetup, claudeRuntimeEnvironment, resolveClaudeExecutable } from "./claude-runtime-environment.js";
import { ClaudeAgentRuntime } from "./claude-agent-runtime.js";
import { TaskNotesStore } from "../../task-notes-store.js";
import { createTaskNotesTool } from "../../task-notes-tool.js";
import type { ObservabilityFacade } from "../../../observability/observability-types.js";
import { recordRuntimePromptAndCreation, summarizeRuntimeTools } from "../runtime-observability-capture.js";

interface Dependencies {
  config: SwarmConfig;
  host: SwarmToolHost;
  forgeExtensionHost: ForgeExtensionHost;
  observability?: ObservabilityFacade;
  resolveProjectExecutableTrustPlan(options: { descriptor: AgentDescriptor; sessionDescriptor?: AgentDescriptor }): Promise<ProjectExecutableTrustPlan>;
  getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<{
    memoryContextFile: { path: string; content: string }; additionalSkillPaths: string[]; skillMetadata: SkillMetadata[];
  }>;
  getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>>;
}

export class ClaudeRuntimeCreator {
  constructor(private readonly deps: Dependencies) {}

  async create(options: { descriptor: AgentDescriptor; sessionDescriptor?: AgentDescriptor; systemPrompt: string; runtimeToken: number;
    callbacks: SwarmRuntimeCallbacks; creationOptions?: RuntimeCreationOptions }): Promise<SwarmAgentRuntime> {
    const { descriptor } = options;
    const sessionDescriptor = descriptor.role === "manager" ? descriptor : options.sessionDescriptor;
    if (!sessionDescriptor || isInternalSessionPurpose(sessionDescriptor) || sessionDescriptor.internalWorkerKind
      || isInternalSessionPurpose(descriptor) || descriptor.internalWorkerKind) {
      throw new Error("Claude native is available for ordinary local Builder sessions and their roster workers.");
    }
    const trust = await this.deps.resolveProjectExecutableTrustPlan({ descriptor, sessionDescriptor });
    const prepared = await this.deps.forgeExtensionHost.prepareRuntimeBindings({ descriptor, sessionDescriptor,
      runtimeType: "claude", runtimeToken: options.runtimeToken, projectExecutableTrustPlan: trust });
    const { swarmTools } = planRuntimeTools({ host: this.deps.host, descriptor,
      forgeExtensionHost: this.deps.forgeExtensionHost, preparedForgeBindings: prepared });
    // Resolve authority per command so a secret grant never interrupts native work.
    const tools = [...swarmTools, createNativeSecureBashTool(descriptor,
      actor => this.deps.host.getSecureRuntimeBinding?.(actor))];
    if (descriptor.profileId && tools.some(tool => tool.name === "history")) {
      tools.push(createTaskNotesTool(new TaskNotesStore({ dataDir: this.deps.config.paths.dataDir }).forActor({
        profileId: descriptor.profileId, sessionAgentId: sessionDescriptor.agentId, actorAgentId: descriptor.agentId,
      })));
    }
    const [memory, contextFiles] = await Promise.all([
      this.deps.getMemoryRuntimeResources(descriptor), this.deps.getSwarmContextFiles(descriptor.cwd),
    ]);
    const secureSessionsEnabled = this.deps.host.isSecureSessionsEnabledForAgent?.(descriptor.agentId) !== false;
    const instructionBundle = await assembleNativeInstructionBundle({
      runtime: "claude", descriptor, instructions: options.creationOptions?.instructionBundle ?? options.systemPrompt,
      memory, contextFiles, secureSessionsEnabled,
    });
    const systemPrompt = renderInstructionBundle(instructionBundle);
    const providerScope = options.creationOptions?.providerScope ?? { threadId: descriptor.agentId, bindingId: randomUUID(), generation: 0 };
    const toolHostBinding = bindRuntimeToolHost({ descriptor, tools, forgeExtensionHost: this.deps.forgeExtensionHost,
      preparedForgeBindings: prepared, secureRuntimeBinding: options.creationOptions?.secureRuntimeBinding, mechanism: "in_process_mcp", scope: providerScope });
    const creationOptions = { ...options.creationOptions, providerScope, instructionBundle, toolHostBinding };
    const env = await claudeRuntimeEnvironment(this.deps.config);
    const executable = await resolveClaudeExecutable(process.env, process.platform, process.arch, this.deps.config.paths.dataDir);
    await assertClaudeSetup(executable, env, descriptor.cwd);
    const runtime = await ClaudeAgentRuntime.create({ descriptor, callbacks: options.callbacks,
      systemPrompt, env, executable, projectTrusted: trust.trusted, tools, host: this.deps.host,
      creationOptions });
    options.creationOptions?.onProviderPrepared?.({ instructionBundle, toolHostBinding });
    if (prepared) this.deps.forgeExtensionHost.activateRuntimeBindings(prepared);
    recordRuntimePromptAndCreation({ observability: this.deps.observability, descriptor,
      runtimeToken: options.runtimeToken, runtimeType: "claude", forgeResolvedPrompt: options.systemPrompt,
      finalSystemPrompt: systemPrompt, activeTools: summarizeRuntimeTools(tools),
      metadata: { promptRole: "system_append", nativeBaseInstructions: "preserved", nativeTools: "owned_by_claude" },
    });
    return runtime;
  }
}
