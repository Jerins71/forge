import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ContextMode, InstructionBundle, ProviderObservation } from "@forge/protocol";
import { createProviderBoundaryFixture } from "../../../__tests__/provider-boundary-fixture.js";
import { ForgeExtensionHost } from "../../../forge-extension-host.js";
import { createStaticCompactionRuntimeSettingsProvider } from "../../../compaction-runtime-settings-provider.js";
import { bindRuntimeToolHost } from "../../runtime-tool-plan.js";
import { PiRuntimeCreator } from "../pi-runtime-creator.js";
import { AgentRuntime } from "../../pi-agent-runtime.js";
import { ReplaySignals, watchdog } from "../../replay/replay-harness.js";

export async function createNativePiFixture(baseUrl: string, trusted = false) {
  const fixture = await createProviderBoundaryFixture();
  const descriptor = fixture.descriptor("openai-codex");
  const modelsPath = join(fixture.root, "pi-models.json");
  await fixture.put(modelsPath, JSON.stringify({ providers: { "openai-codex": {
    apiKey: "synthetic-replay-key", baseUrl, api: "openai-completions", models: [{
      id: "gpt-5.5", name: "Replay", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256000, maxTokens: 2048,
    }],
  } } }));
  const marker = join(fixture.root, "extension-events.jsonl");
  const piExtension = (name: string) => `import { appendFileSync } from 'node:fs';
export default pi => { for (const event of ['session_start', 'input', 'tool_call', 'tool_result', 'session_compact', 'session_shutdown'])
pi.on(event, e => { appendFileSync(${JSON.stringify(marker)}, JSON.stringify({source:${JSON.stringify(name)},event,toolCallId:e.toolCallId})+'\\n'); }); };`;
  await fixture.put(join(fixture.config.paths.dataDir, "profiles/profile/pi/extensions/native.ts"), piExtension("profile-pi"));
  await fixture.put(join(fixture.root, ".pi/extensions/project.ts"), piExtension("project-pi"));
  await fixture.put(join(fixture.config.paths.dataDir, "extensions/native.ts"), `import { appendFileSync } from 'node:fs';
export default forge => { for (const event of ['tool:before','tool:after']) forge.on(event,e => {
appendFileSync(${JSON.stringify(marker)},JSON.stringify({source:'forge',event,toolCallId:e.toolCallId})+'\\n'); }); };`);
  await fixture.put(join(fixture.root, ".forge/extensions/project.ts"), `import { appendFileSync } from 'node:fs';
export default forge => forge.on('tool:before', e => {appendFileSync(${JSON.stringify(marker)},JSON.stringify({source:'project-forge',event:'tool:before',toolCallId:e.toolCallId})+'\\n');});`);
  let contextMode: ContextMode = "summary";
  const forgeExtensionHost = new ForgeExtensionHost({ dataDir: fixture.config.paths.dataDir });
  const host = { ...fixture.deps.host, getContextMode: () => contextMode, listAgents: () => [descriptor],
    searchHistory: async () => ({ matches: [] }), readHistory: async () => ({ text: "Synthetic history" }),
  };
  const trust = { trusted, effectiveForgeDirRealpath: join(fixture.root, ".forge"),
    trustedPiExtensionDirs: trusted ? [join(fixture.root, ".pi/extensions")] : [],
    trustedForgeExtensionDirs: trusted ? [join(fixture.root, ".forge/extensions")] : [], trustedPiSettingsPaths: [],
  };
  const callbacks = { onStatusChange: async () => {}, onSessionEvent: async () => {},
    onAgentEnd: async () => {}, onRuntimeError: async () => {}, onRuntimeExtensionSnapshot: async () => {},
  };
  const instructions = await fixture.service.buildInstructionBundle(descriptor);
  const creator = new PiRuntimeCreator({ ...fixture.deps, forgeExtensionHost, host,
    resolveProjectExecutableTrustPlan: async () => trust,
    getPiModelsJsonPath: () => modelsPath,
    getCompactionRuntimeSettingsProvider: () => createStaticCompactionRuntimeSettingsProvider({
      timeoutMs: 10000, model: { provider: "openai-codex", modelId: "gpt-5.5" }, reasoningLevel: "low",
    }),
    mergeRuntimeContextFiles: (base, resources) => [...base, ...resources.swarmContextFiles, resources.memoryContextFile],
    now: () => new Date().toISOString(), logDebug: () => {}, callbacks,
  } as ConstructorParameters<typeof PiRuntimeCreator>[0]);
  const runtimes: AgentRuntime[] = [];
  const create = async (bundle: InstructionBundle = instructions) => {
    const runtime = await creator.createRuntimeForDescriptor({ descriptor, systemPrompt: bundle.parts.map(p => p.separator + p.text).join(""),
      runtimeToken: runtimes.length + 1, sessionDescriptor: descriptor, creationOptions: { instructionBundle: bundle },
    }) as AgentRuntime;
    runtimes.push(runtime);
    const session = (runtime as unknown as { session: AgentSession }).session;
    session.setAutoRetryEnabled(false);
    const toolHost = bindRuntimeToolHost({ descriptor, mechanism: "native_tools",
      tools: session.getActiveToolNames().map(name => session.getToolDefinition(name)!),
    });
    return { runtime, session, toolHost };
  };
  return { ...fixture, descriptor, instructions, create, creator, marker,
    setContextMode(mode: ContextMode) { contextMode = mode; },
    async extensionEvents(): Promise<Array<{ source: string; event: string; toolCallId?: string }>> {
      return (await readFile(marker, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    },
    async evidence(name: string, evidence: unknown) {
      if (process.env.FORGE_PI_REPLAY_EVIDENCE_DIR) {
        await writeFile(join(process.env.FORGE_PI_REPLAY_EVIDENCE_DIR, name), JSON.stringify(evidence, null, 2) + "\n");
      }
    },
    async cleanup() { for (const runtime of runtimes) await runtime.terminate(); await fixture.cleanup(); },
  };
}

export function collectPiObservations(stream: AsyncIterable<ProviderObservation>) {
  const signals = new ReplaySignals<ProviderObservation>();
  const observations: ProviderObservation[] = [];
  const done = (async () => { for await (const event of stream) {
    observations.push(event); signals.observe(`${event.attemptId}:${event.type}`, event);
    if (event.type === "terminal") signals.observe(`${event.attemptId}:terminal`, event);
  } })();
  return { observations, done, wait: (label: string) => watchdog(label, signals.wait(label)) };
}
