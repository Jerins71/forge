import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CodexRuntimeCreator } from "../runtime/codex/codex-runtime-creator.js";
import { ClaudeRuntimeCreator } from "../runtime/claude/claude-runtime-creator.js";
import { CodexAgentRuntime } from "../runtime/codex/codex-agent-runtime.js";
import { ClaudeAgentRuntime } from "../runtime/claude/claude-agent-runtime.js";
import { renderInstructionBundle } from "../runtime/instruction-bundle.js";
import { planRuntimeTools } from "../runtime/runtime-tool-plan.js";
import { planPiRuntimePrompt } from "../runtime/runtime-prompt-plan.js";
import { planPiResourceLoaderOptions, planRuntimeResourcePaths } from "../runtime/runtime-resource-plan.js";
import { registerFauxProvider } from "../pi/pi-ai-compat.js";
import { createProviderBoundaryFixture } from "./provider-boundary-fixture.js";

vi.mock("../runtime/claude/claude-runtime-environment.js", () => ({ claudeRuntimeEnvironment: async () => ({}),
  resolveClaudeExecutable: async () => "unused-synthetic-executable", assertClaudeSetup: async () => {} }));

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

describe("production prompt and tool boundary baseline", () => {
  it.each(["codex", "claude", "cursor-sdk", "pi"])("retains %s request bytes for archetype, specialist and project agent sources", async provider => {
    const fixture = await createProviderBoundaryFixture();
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-01-01T00:00:00.000Z");
    const captured: Array<{ systemPrompt: string; tools: Array<{ name: string; description: string; parameters: unknown }> }> = [];
    const codexCreate = CodexAgentRuntime.create.bind(CodexAgentRuntime);
    const claudeCreate = ClaudeAgentRuntime.create.bind(ClaudeAgentRuntime);
    const runtimes: Array<{ terminate(): Promise<void> }> = [];
    vi.spyOn(CodexAgentRuntime, "create").mockImplementation(async options => {
      let disposed = false;
      const client = { connect: async () => {}, notify: () => {}, isDisposed: () => disposed,
        dispose: () => { disposed = true; }, shutdown: async () => { disposed = true; },
        request: async (method: string, params: Record<string, unknown>) => {
          if (method === "thread/start") {
            const path = join(fixture.root, `${options.descriptor.agentId}-native.jsonl`);
            await writeFile(path, `${JSON.stringify({ type: "session_meta", payload: { id: "native-thread", dynamic_tools: params.dynamicTools } })}\n`);
            expect(params.developerInstructions).toBe(options.systemPrompt);
            expect(params).not.toHaveProperty("baseInstructions");
            captured.push({ systemPrompt: String(params.developerInstructions), tools: options.tools });
            return { thread: { id: "native-thread", path } };
          }
          return {};
        },
      };
      const runtime = await codexCreate({ ...options, auth: { login: async () => {}, refresh: options.auth.refresh,
        release: () => options.auth.release() }, createClient: () => client as never });
      runtimes.push(runtime);
      return runtime;
    });
    vi.spyOn(ClaudeAgentRuntime, "create").mockImplementation(async options => {
      let ended = false;
      let waiting: ((value: IteratorResult<never>) => void) | undefined;
      const native = { initializationResult: async () => ({}), supportedModels: async () => [],
        close: () => { ended = true; waiting?.({ done: true, value: undefined }); },
        [Symbol.asyncIterator]() { return this; },
        next: () => ended ? Promise.resolve({ done: true as const, value: undefined }) : new Promise<IteratorResult<never>>(resolve => { waiting = resolve; }),
      };
      const runtime = await claudeCreate({ ...options, createQuery: request => {
        expect(request.options?.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: options.systemPrompt });
        captured.push({ systemPrompt: (request.options?.systemPrompt as { append: string }).append, tools: options.tools });
        return native as never;
      } });
      runtimes.push(runtime);
      return runtime;
    });
    try {
      for (const variant of ["archetype", "specialist", "project-agent"]) {
        const descriptor = fixture.descriptor(provider === "codex" ? "codex-native" : provider === "claude" ? "claude-native" : "openai-codex", variant === "specialist" ? "worker" : "manager");
        if (variant === "specialist") descriptor.specialistId = "contract-specialist";
        if (variant === "project-agent") descriptor.projectAgent = { handle: "contract-project-agent", whenToUse: "Inspect project behavior", promotedAt: descriptor.createdAt };
        fixture.descriptors.set(descriptor.agentId, descriptor);
        const systemPrompt = fixture.service.injectWorkerIdentityContext(descriptor, await fixture.service.resolveSystemPromptForDescriptor(descriptor));
        const instructionBundle = await fixture.service.buildInstructionBundle(descriptor);
        expect(renderInstructionBundle(instructionBundle)).toBe(systemPrompt);
        let rendered = systemPrompt;
        let tools = planRuntimeTools({ ...fixture.deps, descriptor } as never).swarmTools;
        if (provider === "codex" || provider === "claude") {
          const Creator = provider === "codex" ? CodexRuntimeCreator : ClaudeRuntimeCreator;
          await new Creator(fixture.deps as never).create({ descriptor, sessionDescriptor: fixture.descriptors.get("manager"), systemPrompt,
            runtimeToken: 1, creationOptions: { instructionBundle }, callbacks: { onStatusChange: () => {} } });
          await runtimes.pop()!.terminate();
          const request = captured.at(-1)!;
          rendered = request.systemPrompt;
          tools = request.tools as typeof tools;
        } else if (provider === "cursor-sdk") {
          rendered = renderInstructionBundle(await fixture.service.buildCursorSdkRuntimeInstructionBundle(descriptor, instructionBundle));
        } else {
          const memoryResources = await fixture.service.getMemoryRuntimeResources(descriptor);
          const settingsManager = SettingsManager.inMemory({});
          const resourcePlan = planPiResourceLoaderOptions({ descriptor, memoryResources,
            pathsPlan: planRuntimeResourcePaths({ config: fixture.config, descriptor }),
            promptPlan: planPiRuntimePrompt({ systemPrompt, instructionBundle, cwd: descriptor.cwd }),
            swarmContextFiles: await fixture.service.getSwarmContextFiles(descriptor.cwd), extensionFactories: [],
            mergeRuntimeContextFiles: (base, resources) => [...base, ...resources.swarmContextFiles, resources.memoryContextFile] });
          const resourceLoader = new DefaultResourceLoader({ ...resourcePlan, settingsManager, noExtensions: true,
            noPromptTemplates: true, noThemes: true });
          await resourceLoader.reload();
          const faux = registerFauxProvider({ api: "forge-contract-api", provider: "forge-contract",
            models: [{ id: "contract", name: "Contract", contextWindow: 32000, maxTokens: 1024 }] });
          const authStorage = AuthStorage.inMemory({});
          authStorage.setRuntimeApiKey("forge-contract", "synthetic-local-key");
          try {
            const { session } = await createAgentSession({ cwd: descriptor.cwd, agentDir: fixture.config.paths.agentDir,
              model: faux.getModel(), modelRegistry: ModelRegistry.inMemory(authStorage), authStorage,
              sessionManager: SessionManager.inMemory(descriptor.cwd), settingsManager, resourceLoader, customTools: tools });
            rendered = session.systemPrompt;
            session.dispose();
          } finally { faux.unregister(); }
        }
        const normalize = (text: string) => text.replaceAll(fixture.root, "<fixture>").replaceAll(fixture.tempRootDir, "<fixture>").replaceAll(process.cwd(), "<backend>");
        expect(rendered).toContain(variant === "specialist" ? "Synthetic specialist instructions" : variant === "archetype" ? "Synthetic manager archetype" : "Synthetic project agent instructions");
        expect(rendered).toContain("design.md");
        expect({ promptSha256: digest(normalize(rendered)), toolSchemasSha256: digest(normalize(JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))))),
          toolNames: tools.map(tool => tool.name) }).toMatchSnapshot(`${provider}:${variant}`);
      }
    } finally { await Promise.all(runtimes.map(runtime => runtime.terminate())); vi.restoreAllMocks(); await fixture.cleanup(); }
  });
});
