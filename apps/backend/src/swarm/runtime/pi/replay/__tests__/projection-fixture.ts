import { randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempConfig } from "../../../../../test-support/temp-config.js";
import { SwarmManager } from "../../../../swarm-manager.js";
import { getPiModelsProjectionPath } from "../../../../catalog/model-catalog-projection.js";
import { getSessionFilePath } from "../../../../storage/data-paths.js";
import { createControlCore } from "../../../../../environment/control/database.js";
import { createProjectPolicy } from "../../../../../environment/control/project-policy.js";
import { createControlledInputRoutePreflight, createSwarmControlAdapter } from "../../../../../environment/control/swarm-control-adapter.js";
import { createWorkspaceService } from "../../../../../environment/control/workspace-service.js";
import { createArtifactService } from "../../../../../environment/control/artifact-service.js";
import { createControlDescriptorPersistence } from "../../../../../environment/control/descriptor-persistence.js";
import { loadState } from "../../../../../environment/control/orchestration/store.js";
import type { SwarmRuntimeController } from "../../../../swarm-runtime-controller.js";
import { ReplaySignals, watchdog } from "../../../replay/replay-harness.js";

/** Real core/manager/projection owners; only the Pi model endpoint is a replay peer. */
export async function createPiProjectionFixture(baseUrl: string) {
  const handle = await createTempConfig({ prefix: "forge-pi-projection-", port: 0,
    sharedAuthContent: { "openai-codex": { type: "api_key", key: "synthetic-pi-projection-key" } } });
  const { config } = handle;
  config.defaultCwd = await realpath(config.defaultCwd);
  config.cwdAllowlistRoots = [config.defaultCwd];
  const manager = new SwarmManager(config);
  const core = await createControlCore({ dataDir: config.paths.dataDir, clock: Date.now, random: randomUUID,
    isDeviceRevoked: () => false, policy: createProjectPolicy(manager),
    inputRoute: createControlledInputRoutePreflight({ swarmManager: manager }),
    swarm: {
      resolveSession: id => adapter.resolveSession!(id),
      ensureSession: input => adapter.ensureSession(input),
      acquireProvider: (scope, conversation, model) => adapter.acquireProvider(scope, conversation, model),
      enqueuePresentation: (threadId, runId, presentation) => adapter.enqueuePresentation!(threadId, runId, presentation),
      applyInput: input => adapter.applyInput(input),
      applyChoice: input => adapter.applyChoice(input), stopSession: input => adapter.stopSession(input),
    },
    workspace: { prepareLaunch: input => workspace.prepareLaunch(input), isLaunchCurrent: input => workspace.isLaunchCurrent(input),
      ensure: commandId => workspace.ensure(commandId), reconcile: commandId => workspace.reconcile(commandId) },
    artifacts: { validateInput: input => artifacts.validateInput(input), pinInput: (inputId, rows) => artifacts.pinInput(inputId, rows) },
  });
  core.database.prepare("INSERT INTO device_sessions (device_session_id,token_hash,proof_thumbprint,device_name,kind,scopes_json,created_at,last_seen_at,expires_at) VALUES ('fixture-device','fixture-token','fixture-proof','Fixture','cli','[]',0,0,?)").run(Date.now() + 86_400_000);
  const workspace = createWorkspaceService({ database: core.database, dataDir: config.paths.dataDir, swarmManager: manager });
  const artifacts = createArtifactService({ database: core.database, dataDir: config.paths.dataDir, swarmManager: manager });
  const adapter = createSwarmControlAdapter({ swarmManager: manager, database: core.database, eventSink: core.eventSink,
    controlService: core.controlService, workspaceService: workspace, artifactService: artifacts });
  const descriptors = createControlDescriptorPersistence({ database: core.database, eventSink: core.eventSink,
    dataDir: config.paths.dataDir, storeFilePath: config.paths.agentsStoreFile });
  const at = new Date().toISOString();
  const sessionFile = getSessionFilePath(config.paths.dataDir, "manager", "manager");
  await descriptors.save({ agents: [{ agentId: "manager", managerId: "manager", profileId: "manager", displayName: "Manager", role: "manager", status: "idle",
    createdAt: at, updatedAt: at, cwd: config.defaultCwd, model: config.defaultModel, sessionFile }],
    profiles: [{ profileId: "manager", displayName: "Manager", defaultSessionAgentId: "manager", defaultModel: config.defaultModel, createdAt: at, updatedAt: at }] });
  manager.installDescriptorPersistence(descriptors);
  const signals = new ReplaySignals<void>();
  const statuses: string[] = [];
  manager.on("agent_status", event => { if (event.agentId === "manager") statuses.push(event.status); });
  const detach = core.eventSink.subscribe(() => {
    const runs = Object.values(loadState(core.database).runs);
    for (const run of runs) if (run.state === "terminal") signals.observe(`terminal:${run.commandId}`, undefined);
  });
  await manager.boot();
  // Boot writes the ordinary catalog projection; retarget only its model transport.
  await writeFile(getPiModelsProjectionPath(config.paths.dataDir), JSON.stringify({ providers: { "openai-codex": {
    apiKey: "synthetic-pi-projection-key", baseUrl, api: "openai-completions", models: [{ id: "gpt-5.5", name: "Replay", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256000, maxTokens: 2048 }],
  } } }));
  await core.reconcileOnBoot();
  const controller = (manager as unknown as { runtimeController: SwarmRuntimeController }).runtimeController;
  return { ...handle, manager, core, controller, sessionFile, statuses, state: () => loadState(core.database),
    async send(commandId: string, text: string) {
      await core.controlService.execute({ deviceSessionId: "fixture-device", scopes: new Set(["session:operate"]) }, "session.send", {
        commandId, sessionId: "manager", message: { text, artifactIds: [] },
      });
      await core.effectWorker.drain();
      const failed = core.database.prepare("SELECT kind,state,last_error_json FROM effects WHERE state IN ('failed','interrupted')").all();
      if (failed.length) throw new Error(`Core dispatch failed: ${JSON.stringify(failed)}`);
    },
    waitTerminal: (commandId: string) => watchdog("core terminal projection", signals.wait(`terminal:${commandId}`)),
    async canonical() { return (await readFile(sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line)); },
    async cleanup() {
      detach(); await core.effectWorker.stop(); await manager.stopSession("manager"); await manager.disposeHistoryRecall();
      await core.close();
      await handle.cleanup();
    },
    async evidence(value: unknown) {
      if (process.env.FORGE_PI_REPLAY_EVIDENCE_DIR) await writeFile(join(process.env.FORGE_PI_REPLAY_EVIDENCE_DIR, "pi-adapter-projection.json"), JSON.stringify(value, null, 2) + "\n");
    },
  };
}
