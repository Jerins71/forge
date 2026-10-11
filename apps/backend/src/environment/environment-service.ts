import { createSessionLifecycleRpc } from "../ws/rpc/session-lifecycle-rpc.js";
import { recoveryProjection } from "./streams/wire-projection.js";
import { ProjectAgentRpc } from "../ws/rpc/project-agent-rpc.js";
import { createProjectAgentReferenceRoutes } from "../ws/http/routes/project-agent-reference-routes.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import type { EnvironmentDescriptor } from "@forge/protocol/environment-v2";
import { loadConfiguredSqliteDatabaseConstructor } from "../sqlite-database-loader.js";
import { getEnvironmentDbPath, getEnvironmentIdentityPath } from "../swarm/storage/data-paths.js";
import type { SwarmConfig } from "../swarm/types.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import type { UnreadTracker } from "../swarm/session/unread-tracker.js";
import type { TerminalService } from "../terminal/terminal-service.js";
import type { SessionFeaturePublisher } from "../ws/session-feature-publisher.js";
import { createEnvironmentRpcServer } from "../ws/rpc/rpc-server.js";
import { createTerminalRpcTransport } from "../terminal/terminal-rpc-transport.js";
import { createEnvironmentArtifactRoutes } from "../ws/http/routes/environment-artifact-routes.js";
import { loadEnvironmentIdentity, EnvironmentIdentityMismatch, type IdentityOptions } from "./identity.js";
import { createEnvironmentAccess, type EnvironmentAccess } from "./access/access-service.js";
import { applyAccessMigrations } from "./access/access-migrations.js";
import type { ExposurePolicy } from "./exposure-policy.js";
import { loadState } from "./control/orchestration/store.js";
import { createProjectPolicy } from "./control/project-policy.js";
import { createControlDescriptorPersistence } from "./control/descriptor-persistence.js";
import { createControlCore, type ControlCore } from "./control/database.js";
import type { SwarmControlPort } from "./control/control-types.js";
import { createWorkspaceService } from "./control/workspace-service.js";
import { createArtifactService } from "./control/artifact-service.js";
import { createSwarmControlAdapter, createControlledInputRoutePreflight } from "./control/swarm-control-adapter.js";
import { createSwarmEventMirror, type SwarmEventMirror } from "./control/swarm-event-mirror.js";
import { createShellStream } from "./streams/shell-stream.js";
import { createSessionStateRpc } from "../ws/rpc/session-state-rpc.js";
import { createDetailFeatureRpc } from "../ws/rpc/detail-feature-rpc.js";
import { createDetailStream } from "./streams/detail-stream.js";
import type { StreamDependencies } from "./streams/shell-stream.js";
import { StreamFault } from "./streams/stream-budget.js";

/** One environment owner; network ingress remains on the existing server. */
export interface EnvironmentService {
  database: Database.Database;
  access: EnvironmentAccess;
  control: import("./control/command-service.js").EnvironmentControlService;
  exposure: ExposurePolicy;
  descriptor(): EnvironmentDescriptor;
  routes: import("../ws/http/shared/http-route.js").HttpRoute[];
  initialize(): Promise<void>;
  composeTransport(
    sessionFeatures: SessionFeaturePublisher,
    terminalService: TerminalService | null,
  ): {
    rpc: ReturnType<typeof createEnvironmentRpcServer>;
    terminalTransport: ReturnType<typeof createTerminalRpcTransport>;
  };
  start(): void;
  stop(): Promise<void>;
}
export async function createEnvironmentService(options: {
  config: SwarmConfig;
  swarmManager: SwarmManager;
  unreadTracker: UnreadTracker;
  exposure: ExposurePolicy;
  identityOptions?: Pick<IdentityOptions, "installationStateDir" | "label" | "capabilities">;
  localBrowserOrigin?: (request: import("node:http").IncomingMessage) => boolean;
}): Promise<EnvironmentService> {
  const { config, swarmManager, unreadTracker, exposure } = options;
  const databasePath = getEnvironmentDbPath(config.paths.dataDir);
  const hadIdentity = existsSync(getEnvironmentIdentityPath(config.paths.dataDir));
  const hadDatabase = existsSync(databasePath);
  const identity = await loadEnvironmentIdentity({
    dataDir: config.paths.dataDir,
    forgeVersion: process.env.FORGE_APP_VERSION,
    ...options.identityOptions,
  });
  if (hadIdentity && !hadDatabase) throw new EnvironmentIdentityMismatch();
  await mkdir(dirname(databasePath), { recursive: true });
  const Constructor = await loadConfiguredSqliteDatabaseConstructor();
  const database: Database.Database = new Constructor(databasePath);
  let core: ControlCore | undefined;
  let mirror: SwarmEventMirror | undefined;
  let rpc: ReturnType<typeof createEnvironmentRpcServer> | undefined;
  let access: EnvironmentAccess | undefined;
  try {
    const workspaceService = createWorkspaceService({ database, dataDir: config.paths.dataDir, swarmManager });
    const artifactService = createArtifactService({ database, dataDir: config.paths.dataDir, swarmManager });
    // Resolve the whole port lazily so new members and every argument (including model)
    // reach the installed adapter without maintaining a second method inventory.
    const swarm = new Proxy<SwarmControlPort>(Object.create(null), {
      get(_target, key) {
        const member = Reflect.get(adapter, key);
        return typeof member === "function" ? member.bind(adapter) : member;
      },
    });

    core = await createControlCore({
      database,
      dataDir: config.paths.dataDir,
      clock: Date.now,
      random: randomUUID,
      swarm,
      workspace: workspaceService,
      artifacts: artifactService,
      policy: createProjectPolicy(swarmManager, id => loadState(database).threads[id]?.model),
      inputRoute: createControlledInputRoutePreflight({ swarmManager }),
      isDeviceRevoked: (id) => {
        const row = database.prepare("SELECT revoked_at,expires_at FROM device_sessions WHERE device_session_id=?").get(id) as
          { revoked_at: number | null; expires_at: number } | undefined;
        return !row || row.revoked_at !== null || row.expires_at <= Date.now();
      },
    });
    const meta = database.prepare("SELECT environment_id,stream_epoch FROM environment_meta WHERE singleton=1").get() as {
      environment_id: string;
      stream_epoch: string;
    };
    if (hadDatabase && !meta.environment_id.startsWith("uncomposed:") && (meta.environment_id !== identity.environmentId || meta.stream_epoch !== identity.file.streamEpoch))
      throw new EnvironmentIdentityMismatch();
    if (!hadDatabase || meta.environment_id.startsWith("uncomposed:"))
      database
        .prepare("UPDATE environment_meta SET environment_id=?,stream_epoch=? WHERE singleton=1")
        .run(identity.environmentId, identity.file.streamEpoch);
    applyAccessMigrations(database);
    const hostAccess = createEnvironmentAccess({ database, identity, exposure, localBrowserOrigin: options.localBrowserOrigin });
    access = {
      ...hostAccess,
      async revokeDevice(principal, input) {
        const result = await hostAccess.revokeDevice(principal, input);
        await rpc?.closeDevice(input.deviceSessionId);
        return result;
      },
    };
    const adapter = createSwarmControlAdapter({ swarmManager, database, eventSink: core.eventSink, controlService: core.controlService, workspaceService, artifactService });
    mirror = createSwarmEventMirror({
      swarmManager,
      database,
      eventSink: core.eventSink,
      wireProjection: {
        async project(profile) {
          const descriptor = swarmManager.getAgentForInternalUse(profile.defaultSessionAgentId);
          const cwd = descriptor?.cwd ?? config.defaultCwd;
          const repository = await workspaceService.getRepositoryIdentity(cwd);
          let isGit = false;
          let defaultBranch: string | null = null;
          try {
            isGit =
              (await promisify(execFile)("git", ["rev-parse", "--is-inside-work-tree"], { cwd, windowsHide: true })).stdout.trim() ===
              "true";
            defaultBranch = (
              await promisify(execFile)("git", ["symbolic-ref", "--short", "HEAD"], { cwd, windowsHide: true })
            ).stdout.trim();
          } catch {
            /* A non-Git project or detached checkout is still selectable. */
          }
          return {
            projectId: profile.profileId,
            title: profile.displayName,
            cwd,
            repository,
            isGit,
            defaultBranch,
            updatedAt: profile.updatedAt,
            sortKey: String(profile.sortOrder ?? profile.createdAt),
            archived: Boolean(profile.archivedAt),
            defaultSessionId: profile.defaultSessionAgentId,
            delegationDefaults: { managerPosture: profile.defaultManagerPosture, rosterId: profile.defaultDelegationRosterId },
            contextMode: profile.defaultContextMode ?? "summary",
            defaultModel: { provider: profile.defaultModel.provider, modelId: profile.defaultModel.modelId, thinkingLevel: profile.defaultModel.thinkingLevel },
          };
        },
        unread: (sessionId, projectId) => unreadTracker.getCount(projectId, sessionId),
        observeUnread: (listener) => unreadTracker.observe(listener),
        artifacts: (entry, sessionId) => artifactService.refsForEntry(sessionId, entry),
        prepareArtifacts: (sessionId, entries) => artifactService.prepareHistoricalArtifacts(sessionId, entries),
      },
    });
    const descriptorPersistence = createControlDescriptorPersistence({ database, eventSink: core.eventSink, dataDir: config.paths.dataDir, storeFilePath: config.paths.agentsStoreFile });
    swarmManager.installDescriptorPersistence(descriptorPersistence);
    mirror.attach();
    const projectAgents = new ProjectAgentRpc(swarmManager, core.controlService, database);
    const owner = core;
    const source = mirror;
    const auth = access;
    let stopped = false;
    return {
      database,
      access: auth,
      control: core.controlService,
      exposure,
      descriptor: (): EnvironmentDescriptor => identity.descriptor(),
      routes: [...auth.routes, ...createEnvironmentArtifactRoutes({ access: auth, artifactService }), ...createProjectAgentReferenceRoutes(auth, projectAgents)],
      async initialize() {
        await descriptorPersistence.load();
        await unreadTracker.load();
        await owner.reconcileOnBoot();
        await swarmManager.hydrateArchivedLastUsed();
        await source.reconcileBeforeReady();
      },
      composeTransport(sessionFeatures: SessionFeaturePublisher, terminalService: TerminalService | null) {
        if (rpc) throw new Error("Environment transport already composed");
        const dependencies: StreamDependencies = {
          database,
          recovery: () => recoveryProjection(swarmManager),
          subscribeCommitted: (listener) => owner.eventSink.subscribe(listener),
          withReadBarrier: (fn) => owner.eventSink.readBarrier(fn).value,
          getDescriptor: () => identity.descriptor(),
          ensureDetailInitialized: (sessionId) => source.ensureDetailInitialized(sessionId),
          readHistory: (principal, input) => source.readHistory(principal, input),
          readContent: (principal, input) => source.readContent(principal, input),
        };
        const shellStream = createShellStream(dependencies);
        const detailStream = createDetailStream(dependencies);
        sessionFeatures.setEnvironmentControl({ access: auth, control: owner.controlService });

        const unavailable = () => {
          throw new StreamFault("UNAVAILABLE", "Terminal service is unavailable");
        };
        const terminalTransport = terminalService
          ? createTerminalRpcTransport({ terminalService })
          : {
              issueTicket: unavailable,
              attach: unavailable,
              input: async () => unavailable(),
              resize: async () => unavailable(),
              closeDevice: async () => {},
            };
        rpc = createEnvironmentRpcServer({
          access: auth,
          control: owner.controlService,
          projectAgents,
          lifecycle: createSessionLifecycleRpc({ swarmManager, control: owner.controlService }),
          sessionState: createSessionStateRpc({ swarmManager, control: owner.controlService, unreadTracker }),
          detailFeatures: createDetailFeatureRpc({ swarmManager, control: owner.controlService }),
          featureStream: { subscribe: (principal, input, signal) => sessionFeatures.detailFeatures(principal, input, signal) },
          shellStream,
          detailStream,
          browserHost: sessionFeatures.browserHost,
          browser: sessionFeatures.browser,
          terminalTransport,
        });
        return { rpc, terminalTransport };
      },
      start() {
        owner.effectWorker.start();
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        await owner.controlService.close();
        await owner.effectWorker.stop();
        source.dispose();
        await rpc?.stop();
        auth.dispose();
        await swarmManager.flushPendingPersistence();
        await owner.close();
        if (database.open) database.close();
      },
    };
  } catch (error) {
    await rpc?.stop();
    mirror?.dispose();
    access?.dispose();
    await core?.close();
    if (database.open) database.close();
    throw error;
  }
}
