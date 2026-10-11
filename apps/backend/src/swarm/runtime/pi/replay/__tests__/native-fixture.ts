import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeExtensionSnapshot, ContextMode, InstructionBundle, ProviderObservation, ProviderScope } from "@forge/protocol";
import { createProviderBoundaryFixture } from "../../../../__tests__/provider-boundary-fixture.js";
import { ForgeExtensionHost } from "../../../../forge-extension-host.js";
import { createStaticCompactionRuntimeSettingsProvider } from "../../../../compaction-runtime-settings-provider.js";
import type { RuntimeCreationOptions } from "../../../../runtime-contracts.js";
import { PiRuntimeCreator } from "../../pi-runtime-creator.js";
import type { AgentRuntime } from "../../../pi-agent-runtime.js";
import { ReplaySignals, watchdog } from "../../../replay/replay-harness.js";

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
  await fixture.put(join(fixture.config.paths.dataDir, "profiles/profile/pi/extensions/index.ts"), piExtension("profile-pi"));
  await fixture.put(join(fixture.root, ".pi/extensions/index.ts"), piExtension("project-pi"));
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
  const extensionSnapshots: AgentRuntimeExtensionSnapshot[] = [];
  const legacySettlements: string[] = [];
  const callbacks = { onStatusChange: async () => {}, onSessionEvent: async () => {},
    onAgentEnd: async () => { legacySettlements.push("agent_end"); }, onRuntimeError: async () => {}, onRuntimeExtensionSnapshot: async (_token: number, _id: string, snapshot: AgentRuntimeExtensionSnapshot) => { extensionSnapshots.push(snapshot); },
  };
  const instructions = await fixture.service.buildInstructionBundle(descriptor);
  const creator = new PiRuntimeCreator({ ...fixture.deps, forgeExtensionHost, host,
    resolveProjectExecutableTrustPlan: async () => trust,
    getPiModelsJsonPath: () => modelsPath,
    getCompactionRuntimeSettingsProvider: () => createStaticCompactionRuntimeSettingsProvider({
      timeoutMs: 10000, model: { provider: "openai-codex", modelId: "gpt-5.5" }, reasoningLevel: "low",
    }),
    mergeRuntimeContextFiles: (base: Array<{ path: string; content: string }>, resources: { swarmContextFiles: Array<{ path: string; content: string }>; memoryContextFile: { path: string; content: string } }) => [...base, ...resources.swarmContextFiles, resources.memoryContextFile],
    now: () => new Date().toISOString(), logDebug: () => {}, callbacks,
  } as unknown as ConstructorParameters<typeof PiRuntimeCreator>[0]);
  const runtimes: AgentRuntime[] = [];
  const create = async (bundle: InstructionBundle = instructions, scope: ProviderScope = { threadId: descriptor.agentId, bindingId: "pi-binding", generation: 7 }) => {
    let prepared: Parameters<NonNullable<RuntimeCreationOptions["onProviderPrepared"]>>[0] | undefined;
    let preparedCount = 0;
    const runtime = await creator.createRuntimeForDescriptor({ descriptor, systemPrompt: bundle.parts.map(p => p.separator + p.text).join(""),
      runtimeToken: runtimes.length + 1, sessionDescriptor: descriptor, creationOptions: { instructionBundle: bundle, providerScope: scope, onProviderPrepared: value => { prepared = value; preparedCount++; } },
    }) as AgentRuntime;
    runtimes.push(runtime);
    const session = (runtime as unknown as { session: AgentSession }).session;
    session.setAutoRetryEnabled(false);
    session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1000 } });
    if (extensionSnapshots.at(-1)?.loadErrors.length) throw new Error(JSON.stringify(extensionSnapshots.at(-1)?.loadErrors));
    if (!prepared) throw new Error("Pi creator did not report the final prepared native inputs.");
    return { runtime, session, toolHost: prepared.toolHostBinding, instructions: prepared.instructionBundle, preparedCount };
  };
  return { ...fixture, descriptor, instructions, create, creator, marker, legacySettlements,
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
    if (event.type === "tool" && event.phase === "update" && JSON.stringify(event.payload).includes("native-ready")) signals.observe(`${event.attemptId}:tool-ready`, event);
    if (event.type === "tool") signals.observe(`${event.attemptId}:tool-${event.phase}`, event);
    if (event.type === "terminal") signals.observe(`${event.attemptId}:terminal`, event);
  } })();
  return { observations, done, wait: (label: string, timeoutMs?: number) => watchdog(label, signals.wait(label), timeoutMs) };
}
