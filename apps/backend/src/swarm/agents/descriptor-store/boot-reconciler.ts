import { migrateDataDirectory } from "../../data-migration.js";
import type { AgentDescriptor, AgentsStoreFile, ManagerProfile, SwarmConfig } from "../../types.js";
import type { ProfileBootReconciler } from "./profile-boot-reconciler.js";
import { prunePersistedWorkerSidecars } from "./worker-boot-recovery.js";
import { migrateDelegationRostersToWorkerPresets } from "../../specialists/worker-presets.js";

interface BootReconcilerOptions {
  config: SwarmConfig;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  loadStore: () => Promise<AgentsStoreFile>;
  saveStore: () => Promise<void>;
  profileReconciler: ProfileBootReconciler;
  preloadPinnedMessageIndexes: () => Promise<void>;
  preloadSessionPlanStates: () => Promise<void>;
  logDebug: (message: string, details?: unknown) => void;
}

export class BootReconciler {
  constructor(private readonly options: BootReconcilerOptions) {}

  async loadAndReconcilePersistedStore(): Promise<AgentsStoreFile> {
    // Before the store is decoded: decoding drops the roster references the migration counts.
    await migrateDelegationRostersToWorkerPresets(this.options.config.paths.dataDir, this.options.config.paths.agentsStoreFile);
    let loaded = await this.options.loadStore();
    const migration = await migrateDataDirectory({ dataDir: this.options.config.paths.dataDir, agentsStoreFile: this.options.config.paths.agentsStoreFile }, loaded.agents, loaded.profiles ?? [], { debug: this.options.logDebug, info: this.options.logDebug, warn: this.options.logDebug });
    loaded = { ...loaded, agents: migration.updatedAgents };

    const workerSidecarPruneResult = prunePersistedWorkerSidecars(loaded, this.options.logDebug);
    loaded = workerSidecarPruneResult.store;

    for (const descriptor of loaded.agents) {
      this.options.descriptors.set(descriptor.agentId, descriptor);
    }
    for (const profile of loaded.profiles ?? []) {
      this.options.profiles.set(profile.profileId, profile);
    }

    await this.options.preloadPinnedMessageIndexes();
    await this.options.preloadSessionPlanStates();

    const normalizedSessionModelState = this.options.profileReconciler.reconcileProfilesOnBoot();
    const normalizedContextModeState = this.options.profileReconciler.normalizeContextModeStateOnBoot();
    if (
      migration.migrated ||
      workerSidecarPruneResult.pruned ||
      normalizedSessionModelState ||
      normalizedContextModeState
    ) {
      await this.options.saveStore();
    }

    return loaded;
  }
}
