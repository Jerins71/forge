/** Real composition; replace only the provider executable, including its version probe. */
import { ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDescriptor, SwarmConfig } from "../../types.js";
import type { RuntimeCreationOptions } from "../../runtime-contracts.js";
import type { InstructionBundle } from "@forge/protocol";
import type { ToolHostBinding } from "../provider-contract.js";
import { getNativeCodexHome, getSessionMemoryPath } from "../../storage/data-paths.js";

try {
  const { config, descriptor, port } = JSON.parse(await readFile(process.argv[2]!, "utf8")) as { config: SwarmConfig; descriptor: AgentDescriptor; port: number };
  const marker = join(config.paths.dataDir, "replay-codex.exe");
  process.env.CODEX_BIN = marker;
  const native = ChildProcess.prototype as ChildProcess & { spawn(options: { file: string; args: string[] }): unknown };
  const original = native.spawn;
  native.spawn = function (options: Parameters<typeof original>[0]) {
    if (options.file === marker) {
      options.file = process.execPath;
      options.args = [process.execPath, fileURLToPath(new URL("../replay/scripted-peer.mjs", import.meta.url)), ...options.args.slice(1)];
    }
    return original.call(this, options);
  };
  const home = getNativeCodexHome(config.paths.dataDir);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "replay-peer.json"), JSON.stringify({ port }));
  const { SwarmManager } = await import("../../swarm-manager.js");
  class PreparedManager extends SwarmManager {
    prepare(actor: AgentDescriptor, options: RuntimeCreationOptions) { return this.createRuntimeForDescriptor(actor, "Forge replay contract", 1, options); }
  }
  // Resource fixture only: the normal provisioning owner creates this before runtime creation.
  const memoryPath = getSessionMemoryPath(config.paths.dataDir, descriptor.agentId, descriptor.agentId);
  await mkdir(dirname(memoryPath), { recursive: true });
  await writeFile(memoryPath, "# Synthetic session memory\n");
  const manager = new PreparedManager(config);
  let prepared: { instructionBundle: InstructionBundle; toolHostBinding: ToolHostBinding } | undefined;
  let calls = 0;
  const scope = { threadId: descriptor.agentId, bindingId: "core-prepared", generation: 23 };
  const runtime = await manager.prepare(descriptor, { providerScope: scope, onProviderPrepared: record => { calls++; prepared = record; } });
  if (!prepared || !runtime.providerAdapter) throw new Error("Creator did not expose the prepared provider boundary");
  const binding = await runtime.providerAdapter.open({ scope, model: descriptor.model, instructions: prepared.instructionBundle, toolHost: prepared.toolHostBinding });
  const equivalent = await runtime.providerAdapter.resume({ scope, model: descriptor.model, instructions: prepared.instructionBundle, toolHost: prepared.toolHostBinding, conversation: binding.conversation });
  // Real credential loss before native dispatch is definite; it must not leave
  // the legacy lifecycle owner waiting for an impossible native terminal.
  await writeFile(config.paths.sharedAuthFile, "{}");
  let authRejected = false;
  try { await runtime.sendMessage("Must not dispatch without authentication"); }
  catch { authRejected = true; }
  if (!authRejected || runtime.getStatus() !== "idle") throw new Error("Lost authentication was not rejected before dispatch");
  await runtime.shutdownForReplacement();
  if ((await runtime.providerAdapter.drain(binding)).status !== "clean") throw new Error("Prepared runtime did not drain");
  await manager.disposeHistoryRecall();
  process.send?.({ result: { instructions: prepared.instructionBundle, tools: prepared.toolHostBinding.snapshot, scope: binding.scope, calls, adapterBound: equivalent === binding, authFailureDrained: true } });
  process.exit(0);
} catch (error) { process.send?.({ error: error instanceof Error ? error.stack : String(error) }); process.exit(1); }
