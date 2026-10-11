/** Private replay composition: same production owners and startup order as EnvironmentService. */
import crypto from "node:crypto";
import { ChildProcess, execFile } from "node:child_process";
import { promisify } from "node:util";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { SwarmConfig, AgentsStoreFile } from "../../types.js";

export interface BackendReplayBoot { config: SwarmConfig; boot: number; initialStore?: AgentsStoreFile; crashAfterAppend?: string }
const { config, boot, initialStore, crashAfterAppend } = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as BackendReplayBoot;
const fixedNow = Date.parse("2026-10-10T12:00:00.000Z");
let id = 0;
crypto.randomUUID = () => {
  const serial = boot * 1_000_000 + ++id;
  return `${serial.toString(16).padStart(8, "0")}-0000-4000-8000-${serial.toString(16).padStart(12, "0")}`;
};
globalThis.Date = new Proxy(Date, {
  construct(target, args) { return Reflect.construct(target, args.length ? args : [fixedNow]); },
  apply(target, receiver, args) { return args.length ? Reflect.apply(target, receiver, args) : new target(fixedNow).toString(); },
});
Date.now = () => fixedNow;
syncBuiltinESMExports();

// Replace only the provider executable; even the OS pipes and readline parser run for real.
// Retargeting ChildProcess.spawn also covers execFile's CLI version probe on Windows.
const marker = resolve(config.paths.dataDir, "replay-codex.exe");
process.env.CODEX_BIN = marker;
interface NativeSpawnOptions { file: string; args: string[] }
const processPrototype = ChildProcess.prototype as ChildProcess & { spawn(options: NativeSpawnOptions): unknown };
const originalSpawn = processPrototype.spawn;
processPrototype.spawn = function (options: Parameters<typeof originalSpawn>[0]) {
  if (options.file === marker) {
    options.file = process.execPath;
    options.args = [process.execPath, fileURLToPath(new URL("./scripted-peer.mjs", import.meta.url)), ...options.args.slice(1)];
  }
  return originalSpawn.call(this, options);
};
const [swarm, dbLoader, control, adapterModule, workspaceModule, artifactModule, descriptorModule,
  mirrorModule, identityModule, accessModule, exposureModule, shellModule, detailModule, rpcModule, featureModule,
  detailRpcModule, wireModule, unreadModule] = await Promise.all([
  import("../../swarm-manager.js"), import("../../../sqlite-database-loader.js"),
  import("../../../environment/control/database.js"), import("../../../environment/control/swarm-control-adapter.js"),
  import("../../../environment/control/workspace-service.js"), import("../../../environment/control/artifact-service.js"),
  import("../../../environment/control/descriptor-persistence.js"), import("../../../environment/control/swarm-event-mirror.js"),
  import("../../../environment/identity.js"), import("../../../environment/access/access-service.js"),
  import("../../../environment/exposure-policy.js"), import("../../../environment/streams/shell-stream.js"),
  import("../../../environment/streams/detail-stream.js"), import("../../../ws/rpc/rpc-server.js"),
  import("../../../ws/session-feature-publisher.js"), import("../../../ws/rpc/detail-feature-rpc.js"),
  import("../../../environment/streams/wire-projection.js"), import("../../session/unread-tracker.js"),
]);
const { createProjectPolicy } = await import("../../../environment/control/project-policy.js");
const { getEnvironmentDbPath } = await import("../../storage/data-paths.js");
const manager = new swarm.SwarmManager(config, { now: () => new Date(fixedNow).toISOString() });
const Database = await dbLoader.loadConfiguredSqliteDatabaseConstructor();
mkdirSync(dirname(getEnvironmentDbPath(config.paths.dataDir)), { recursive: true });
const database = new Database(getEnvironmentDbPath(config.paths.dataDir));
const identity = await identityModule.loadEnvironmentIdentity({ dataDir: config.paths.dataDir, installationStateDir: resolve(config.paths.rootDir, "installation"), label: "Codex replay" });
const workspace = workspaceModule.createWorkspaceService({ database, dataDir: config.paths.dataDir, swarmManager: manager });
const artifacts = artifactModule.createArtifactService({ database, dataDir: config.paths.dataDir, swarmManager: manager });
const core = await control.createControlCore({ database, clock: Date.now, random: () => crypto.randomUUID(),
  swarm: {
    resolveSession: agentId => adapter.resolveSession!(agentId),
    ensureSession: input => adapter.ensureSession(input), applyInput: input => adapter.applyInput(input),
    acquireProvider: (scope,conversation) => adapter.acquireProvider(scope,conversation),
    applyChoice: input => adapter.applyChoice(input), stopSession: input => adapter.stopSession(input),
  }, workspace, artifacts, policy: createProjectPolicy(manager),
  inputRoute: adapterModule.createControlledInputRoutePreflight({ swarmManager: manager }),
  isDeviceRevoked: device => {
    const row = database.prepare("SELECT revoked_at, expires_at FROM device_sessions WHERE device_session_id=?").get(device) as { revoked_at: number | null; expires_at: number } | undefined;
    return !row || row.revoked_at !== null || row.expires_at <= Date.now();
  },
});
database.prepare("UPDATE environment_meta SET environment_id=?,stream_epoch=? WHERE singleton=1").run(identity.environmentId, identity.file.streamEpoch);
const exposure = exposureModule.createExposurePolicy({ host: "127.0.0.1", port: 0 });
const { applyAccessMigrations } = await import("../../../environment/access/access-migrations.js");
applyAccessMigrations(database);
const access = accessModule.createEnvironmentAccess({ database, identity, exposure });
const adapter = adapterModule.createSwarmControlAdapter({ swarmManager: manager, database, eventSink: core.eventSink, controlService: core.controlService, workspaceService: workspace, artifactService: artifacts });
const descriptors = descriptorModule.createControlDescriptorPersistence({ database, eventSink: core.eventSink, dataDir: config.paths.dataDir, storeFilePath: config.paths.agentsStoreFile });
if (initialStore) await descriptors.save(initialStore);
manager.installDescriptorPersistence(descriptors);
const unread = new unreadModule.UnreadTracker({ dataDir: config.paths.dataDir,
  getProfileIds: () => manager.listProfiles().map(p => p.profileId),
  getSessionAgentIds: profileId => manager.listAgents().filter(a => a.profileId === profileId).map(a => a.agentId),
});
const mirror = mirrorModule.createSwarmEventMirror({ swarmManager: manager, database, eventSink: core.eventSink,
  wireProjection: {
    project: async profile => {
      const cwd = manager.getAgentForInternalUse(profile.defaultSessionAgentId)?.cwd ?? config.defaultCwd;
      const repository = await workspace.getRepositoryIdentity(cwd);
      let isGit = false;
      let defaultBranch: string | null = null;
      try {
        isGit = (await promisify(execFile)("git", ["rev-parse", "--is-inside-work-tree"], { cwd, windowsHide: true })).stdout.trim() === "true";
        defaultBranch = (await promisify(execFile)("git", ["symbolic-ref", "--short", "HEAD"], { cwd, windowsHide: true })).stdout.trim();
      } catch { /* Non-Git and detached projects remain selectable, as in EnvironmentService. */ }
      return { projectId: profile.profileId, title: profile.displayName, cwd, repository, isGit, defaultBranch,
        updatedAt: profile.updatedAt, sortKey: String(profile.sortOrder ?? profile.createdAt), archived: Boolean(profile.archivedAt),
        defaultSessionId: profile.defaultSessionAgentId,
        delegationDefaults: { managerPosture: profile.defaultManagerPosture, rosterId: profile.defaultDelegationRosterId },
        contextMode: profile.defaultContextMode ?? "summary",
        defaultModel: { provider: profile.defaultModel.provider, modelId: profile.defaultModel.modelId, thinkingLevel: profile.defaultModel.thinkingLevel } };
    },
    unread: (sessionId, projectId) => unread.getCount(projectId, sessionId),
    observeUnread: listener => unread.observe(listener),
    artifacts: (entry, sessionId) => artifacts.refsForEntry(sessionId, entry),
    prepareArtifacts: (sessionId, entries) => artifacts.prepareHistoricalArtifacts(sessionId, entries),
  },
});
mirror.attach();
// Persisted-event observations are installed before any command can arrive.
core.eventSink.subscribe(event => process.send?.({ type: "persisted", value: { sequence: event.sequence, event: event.event } }));
const apply = manager.applyControlledInput.bind(manager);
manager.applyControlledInput = (text, input) => apply(text, { ...input, controlledInput: {
  ...input.controlledInput,
  onLocator(locator) {
    if (crashAfterAppend === input.controlledInput.commandId) {
      const raw = readFileSync(manager.getAgentForInternalUse(input.targetAgentId)!.sessionFile, "utf8");
      const inputId = input.controlledInput.inputId;
      const boundary = { appendPersisted: raw.split("\n").some(line => { try { return JSON.parse(line).data?.id === inputId; } catch { return false; } }),
        locatorCommitted: Boolean(database.prepare("SELECT 1 FROM mirror_sources WHERE source_key=?").get(`input:${inputId}`)) };
      writeFileSync(resolve(config.paths.rootDir, "crash-boundary.json"), JSON.stringify(boundary));
      process.kill(process.pid, "SIGKILL");
    }
    input.controlledInput.onLocator?.(locator);
  },
} });
await manager.boot();
if (!manager.listAgents().length) throw new Error("Replay fixture descriptor was not seeded");
await descriptors.load();
await unread.load();
await core.reconcileOnBoot();
await manager.hydrateArchivedLastUsed();
await mirror.reconcileBeforeReady();
const deps = { database, recovery: () => wireModule.recoveryProjection(manager),
  subscribeCommitted: core.eventSink.subscribe, withReadBarrier: <T>(fn: () => T) => core.eventSink.readBarrier(fn).value,
  getDescriptor: () => identity.descriptor(), ensureDetailInitialized: mirror.ensureDetailInitialized,
  readHistory: mirror.readHistory, readContent: mirror.readContent,
};
const shellStream = shellModule.createShellStream(deps);
const detailStream = detailModule.createDetailStream(deps);
const features = new featureModule.SessionFeaturePublisher({ swarmManager: manager });
features.setEnvironmentControl({ access, control: core.controlService });
const { createSessionLifecycleRpc } = await import("../../../ws/rpc/session-lifecycle-rpc.js");
const unavailable = () => { throw new Error("No terminal in replay"); };
const rpc = rpcModule.createEnvironmentRpcServer({ access, control: core.controlService, shellStream, detailStream,
  lifecycle: createSessionLifecycleRpc({ swarmManager: manager, control: core.controlService }),
  detailFeatures: detailRpcModule.createDetailFeatureRpc({ swarmManager: manager, control: core.controlService }),
  browserHost: features.browserHost, browser: features.browser,
  terminalTransport: { attach: unavailable, input: async () => unavailable(), resize: async () => unavailable(), closeDevice: async () => {} },
});
const server = createServer((request, response) => {
  const url = new URL(request.url!, exposure.publicBaseUrl);
  const route = access.routes.find(r => r.matches(url.pathname));
  if (!route) { response.writeHead(404); response.end(); return; }
  void route.handle(request, response, url).catch(() => { response.writeHead(500); response.end(); });
});
server.on("upgrade", (request, socket, head) => void rpc.handleUpgrade(request, socket, head));
await new Promise<void>(resolve => server.listen(config.port, "127.0.0.1", resolve));
exposure.setLoopbackPort((server.address() as { port: number }).port);
core.effectWorker.start();
process.on("message", message => {
  const request = message as { requestId: string; operation: string; commandId?: string };
  void (async () => {
    let value: unknown;
    if (request.operation === "drain") { await core.effectWorker.drain(); await manager.flushPendingPersistence(); value = true; }
    else if (request.operation === "grant") value = await access.createBootstrapGrant({ reachableBaseUrl: exposure.publicBaseUrl });
    else if (request.operation === "inspect") value = {
      inputs: database.prepare("SELECT * FROM control_inputs").all(),
      receipts: database.prepare("SELECT receipt_json FROM command_receipts WHERE command_id=?").all(request.commandId),
      recovery: manager.getRestartRecoverySnapshot(),
      sequences: {
        shell: (database.prepare("SELECT COALESCE(MAX(sequence),0) n FROM events WHERE topic='shell'").get() as { n: number }).n,
        detail: (database.prepare("SELECT COALESCE(MAX(sequence),0) n FROM events WHERE session_id='manager' OR event_type='recovery.upsert'").get() as { n: number }).n,
      },
      canonical: manager.listAgentsForInternalUse().map(a => ({ agentId: a.agentId, sessionFile: a.sessionFile })),
    };
    else throw new Error("Unknown private replay operation");
    process.send?.({ type: "result", requestId: request.requestId, value });
  })().catch(error => process.send?.({ type: "result", requestId: request.requestId, error: String(error) }));
});
process.send?.({ type: "ready", value: { baseUrl: exposure.publicBaseUrl, environment: identity.descriptor() } });
