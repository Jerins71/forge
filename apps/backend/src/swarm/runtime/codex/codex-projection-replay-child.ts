/** Real creator and canonical projectors; only the provider executable is replaced. */
import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDescriptor, SwarmConfig } from "../../types.js";
import type { RuntimeSessionEvent } from "../../runtime-contracts.js";
import type { ProviderConversationRef, ProviderObservation } from "@forge/protocol";
import { getNativeCodexHome } from "../../storage/data-paths.js";
import { ProviderDispatchRejectedError } from "../provider-contract.js";

try {
  const { config, descriptor, port, legacy, appendCrash, conversation } = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
    config: SwarmConfig; descriptor: AgentDescriptor; port: number; legacy: boolean; appendCrash?: boolean; conversation?: ProviderConversationRef;
  };
  const marker = join(config.paths.dataDir, "replay-codex.exe");
  process.env.CODEX_BIN = marker;
  const native = ChildProcess.prototype as ChildProcess & { spawn(options: { file: string; args: string[] }): unknown };
  const original = native.spawn;
  native.spawn = function (options: Parameters<typeof original>[0]) {
    if (options.file === marker) {
      options.file = process.execPath;
      options.args = [process.execPath, fileURLToPath(new URL("./codex-scripted-peer.mjs", import.meta.url)), ...options.args.slice(1)];
    }
    return original.call(this, options);
  };
  const home = getNativeCodexHome(config.paths.dataDir);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "replay-peer.json"), JSON.stringify({ port }));
  const { CodexRuntimeCreator } = await import("./codex-runtime-creator.js");
  const create = CodexRuntimeCreator.prototype.create;
  const statuses: string[] = [];
  const events: RuntimeSessionEvent[] = [];
  let ends = 0;
  // Observe the actual callback quartet, retaining every production callback.
  CodexRuntimeCreator.prototype.create = function (options) {
    const callbacks = options.callbacks;
    return create.call(this, { ...options, callbacks: { ...callbacks,
      onStatusChange: async (...args) => { statuses.push(args[1]); await callbacks.onStatusChange(...args); },
      onSessionEvent: async (...args) => { events.push(args[1]); await callbacks.onSessionEvent?.(...args); },
      onAgentEnd: async (...args) => { ends++; await callbacks.onAgentEnd?.(...args); },
    } });
  };
  const { SwarmManager } = await import("../../swarm-manager.js");
  const { createStandaloneDescriptorPersistence } = await import("../../../environment/control/descriptor-persistence.js");
  await createStandaloneDescriptorPersistence({ dataDir: config.paths.dataDir, storeFilePath: config.paths.agentsStoreFile }).save({
    agents: [descriptor], profiles: [{ profileId: descriptor.profileId!, displayName: "Adapter replay", defaultSessionAgentId: descriptor.agentId,
      defaultModel: descriptor.model, createdAt: descriptor.createdAt, updatedAt: descriptor.updatedAt }],
  });
  class ProjectionManager extends SwarmManager {
    runtime(agentId: string) { return this.getFacadeServices().runtime.runtimes.get(agentId)!; }
  }
  const manager = new ProjectionManager(config);
  await manager.boot();
  const scope = { threadId: descriptor.agentId, bindingId: "projection-binding", generation: appendCrash ? 1 : 2 };
  const { adapter, binding } = await manager.acquireControlledProvider(scope, conversation);
  const runtime = manager.runtime(descriptor.agentId);
  if (appendCrash) {
    await manager.applyControlledInput("Work", { targetAgentId: descriptor.agentId, runId: "projection-run",
      controlledInput: { inputId: "append-input", commandId: "append-command", contentHash: createHash("sha256").update("Work").digest("hex") },
      prepared: { runtimeMessage: { text: "Work" }, presentation: { source: "user_input", runtimeMessageText: "Work", assistantOutputTarget: { kind: "session_transcript", channel: "web" } } },
    });
    await manager.flushPendingPersistence();
    process.send?.({ appended: binding.conversation });
    // The parent abruptly kills this backend after observing the durable append.
    await new Promise(() => {});
  }
  const observations: ProviderObservation[] = [];
  const consume = (async () => {
    for await (const event of adapter.observations(binding)) {
      observations.push(event);
      if (event.type === "terminal" && event.origin.kind === "root") break;
    }
  })();
  const runId = "projection-run";
  const attemptId = "projection-attempt";
  manager.enqueueControlledPresentation(descriptor.agentId, runId, {
    source: "user_input", runtimeMessageText: "Work", assistantOutputTarget: { kind: "session_transcript", channel: "web" },
  });
  const dispatch = legacy ? runtime.sendMessage("Work") : adapter.start({ binding, runId, attemptId, input: { text: "Work" } });
  // A legacy caller can arrive before adapter preparation has published streaming.
  const earlyLegacyBusy = legacy ? undefined : await runtime.sendMessage("Never enqueue", "followUp")
    .catch(error => ({ name: error.name, code: error.code, delivery: error.delivery, reason: error.reason, sharedClass: error instanceof ProviderDispatchRejectedError }));
  const start = await dispatch;
  const activeStatus = runtime.getStatus();
  const busy = await adapter.start({ binding, runId: "busy-run", attemptId: "busy-attempt", input: { text: "Never enqueue" } })
    .catch(error => ({ name: error.name, code: error.code, delivery: error.delivery, reason: error.reason, sharedClass: error instanceof ProviderDispatchRejectedError }));
  // The mixed legacy entry point also must not enqueue work owned by the kernel.
  const legacyBusy = legacy || activeStatus !== "streaming" ? undefined : await runtime.sendMessage("Never enqueue", "followUp")
    .catch(error => ({ name: error.name, code: error.code, delivery: error.delivery, reason: error.reason, sharedClass: error instanceof ProviderDispatchRejectedError }));
  const accepted = legacy ? observations.find(event => event.type === "accepted") : start;
  if (!accepted || !("turn" in accepted)) throw new Error("Expected native turn acceptance");
  await adapter.steer({ binding, turn: accepted.turn, runId, attemptId: legacy ? observations[0]!.attemptId : attemptId, input: { text: "Steer" } });
  process.send?.({ ready: true });
  await consume;
  // close awaits native notification projections as well as the observation stream.
  await adapter.close(binding);
  await manager.flushPendingPersistence();
  const jsonl = (await readFile(descriptor.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  await manager.disposeHistoryRecall();
  process.send?.({ result: { activeStatus, status: runtime.getStatus(), pending: runtime.getPendingCount(), statuses,
    events, ends, busy, earlyLegacyBusy, legacyBusy, jsonl, observations, conversation: binding.conversation, drain: await adapter.drain(binding) } });
  process.exit(0);
} catch (error) { process.send?.({ error: error instanceof Error ? error.stack : String(error) }); process.exit(1); }
