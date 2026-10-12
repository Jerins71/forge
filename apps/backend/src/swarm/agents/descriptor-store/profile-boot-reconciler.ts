import { normalizePersistedSwarmModelDescriptor } from "../../catalog/model-presets.js";
import { normalizeOptionalAgentId } from "../../swarm-manager-utils.js";
import { isContextMode } from "@forge/protocol";
import type {
  AgentDescriptor,
  AgentModelDescriptor,
  ManagerProfile,
} from "../../types.js";

export interface ProfileBootMutations {
  upsertDescriptor(descriptor: AgentDescriptor): void;
  upsertProfile(profile: ManagerProfile): void;
  deleteProfile(profileId: string): void;
}

export interface ProfileBootReconcilerOptions {
  defaultModel: AgentModelDescriptor;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  mutations: ProfileBootMutations;
  logDebug(message: string, details?: Record<string, unknown>): void;
}

/**
 * Owns boot-time repair of the persisted relationship between manager session
 * descriptors and profiles. Runtime restoration and filesystem provisioning
 * deliberately remain outside this in-memory reconciliation boundary.
 */
export class ProfileBootReconciler {
  constructor(private readonly options: ProfileBootReconcilerOptions) {}

  reconcileProfilesOnBoot(): boolean {
    let changed = false;
    const managerDescriptorsById = new Map<string, AgentDescriptor>();

    for (const descriptor of this.options.descriptors.values()) {
      const normalizedDescriptorModel = cloneModelDescriptor(descriptor.model);
      if (!sameModelDescriptor(descriptor.model, normalizedDescriptorModel)) {
        descriptor.model = normalizedDescriptorModel;
        this.options.mutations.upsertDescriptor(descriptor);
        changed = true;
      }

      if (descriptor.role !== "manager") {
        continue;
      }

      const reconciledProfileId =
        normalizeOptionalAgentId(descriptor.profileId) ?? descriptor.agentId;
      if (descriptor.profileId !== reconciledProfileId) {
        descriptor.profileId = reconciledProfileId;
        this.options.mutations.upsertDescriptor(descriptor);
        changed = true;
      }

      managerDescriptorsById.set(descriptor.agentId, descriptor);

      if (this.options.profiles.has(reconciledProfileId)) {
        continue;
      }

      this.options.mutations.upsertProfile({
        profileId: reconciledProfileId,
        displayName: descriptor.displayName,
        defaultSessionAgentId: reconciledProfileId,
        defaultModel: { ...descriptor.model },
        createdAt: descriptor.createdAt,
        updatedAt: descriptor.createdAt,
      });
      changed = true;
    }

    for (const [profileId, profile] of Array.from(this.options.profiles.entries())) {
      let defaultSessionDescriptor = managerDescriptorsById.get(profile.defaultSessionAgentId);
      if (!defaultSessionDescriptor || defaultSessionDescriptor.role !== "manager") {
        const rootSessionDescriptor = managerDescriptorsById.get(profileId);
        if (!rootSessionDescriptor || rootSessionDescriptor.role !== "manager") {
          this.options.mutations.deleteProfile(profileId);
          changed = true;
          continue;
        }

        profile.defaultSessionAgentId = rootSessionDescriptor.agentId;
        defaultSessionDescriptor = rootSessionDescriptor;
        changed = true;
      }

      const profileSessions = this.getSessionsForProfile(profileId);
      if (profileSessions.length === 0) {
        const rootSessionDescriptor = managerDescriptorsById.get(profileId);
        if (!rootSessionDescriptor || rootSessionDescriptor.role !== "manager") {
          this.options.mutations.deleteProfile(profileId);
          changed = true;
          continue;
        }

        if (rootSessionDescriptor.profileId !== profileId) {
          rootSessionDescriptor.profileId = profileId;
          this.options.mutations.upsertDescriptor(rootSessionDescriptor);
          changed = true;
        }
      }

      const defaultModelWasSynthesized = !isValidPersistedModelDescriptor(profile.defaultModel);
      const normalizedDefaultModel = defaultModelWasSynthesized
        ? cloneModelDescriptor(defaultSessionDescriptor?.model ?? this.options.defaultModel)
        : cloneModelDescriptor(profile.defaultModel);
      if (
        defaultModelWasSynthesized ||
        !sameModelDescriptor(profile.defaultModel, normalizedDefaultModel)
      ) {
        profile.defaultModel = normalizedDefaultModel;
        changed = true;
      }

      for (const session of this.getSessionsForProfile(profileId)) {
        if (session.modelOrigin !== undefined) {
          continue;
        }

        session.modelOrigin = inferLegacySessionModelOrigin(session, profile, {
          forceDefaultSessionInherited: defaultModelWasSynthesized,
        });
        this.options.mutations.upsertDescriptor(session);
        changed = true;
      }

      this.options.mutations.upsertProfile(profile);
    }

    return changed;
  }

  normalizeContextModeStateOnBoot(): boolean {
    let changed = false;
    for (const profile of this.options.profiles.values()) {
      if (profile.defaultContextMode !== undefined && !isContextMode(profile.defaultContextMode)) {
        delete profile.defaultContextMode;
        this.options.mutations.upsertProfile(profile);
        changed = true;
      }
    }
    for (const descriptor of this.options.descriptors.values()) {
      if (descriptor.contextModeOverride !== undefined && !isContextMode(descriptor.contextModeOverride)) {
        delete descriptor.contextModeOverride;
        this.options.mutations.upsertDescriptor(descriptor);
        changed = true;
      }
    }
    return changed;
  }

  private getSessionsForProfile(
    profileId: string,
  ): Array<AgentDescriptor & { role: "manager"; profileId: string }> {
    return Array.from(this.options.descriptors.values()).filter(
      (
        descriptor,
      ): descriptor is AgentDescriptor & { role: "manager"; profileId: string } =>
        descriptor.role === "manager" &&
        descriptor.profileId === profileId,
    );
  }
}

function inferLegacySessionModelOrigin(
  descriptor: AgentDescriptor & { role: "manager"; profileId?: string },
  profile: ManagerProfile,
  options?: { forceDefaultSessionInherited?: boolean },
): "profile_default" | "session_override" {
  if (
    options?.forceDefaultSessionInherited &&
    descriptor.agentId === profile.defaultSessionAgentId
  ) {
    return "profile_default";
  }

  return sameModelDescriptor(descriptor.model, profile.defaultModel)
    ? "profile_default"
    : "session_override";
}

function isValidPersistedModelDescriptor(value: unknown): value is AgentModelDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { provider?: unknown }).provider === "string" &&
    typeof (value as { modelId?: unknown }).modelId === "string" &&
    typeof (value as { thinkingLevel?: unknown }).thinkingLevel === "string"
  );
}

function cloneModelDescriptor(model: AgentModelDescriptor): AgentModelDescriptor {
  return (
    normalizePersistedSwarmModelDescriptor(model) ?? {
      provider: model.provider,
      modelId: model.modelId,
      thinkingLevel: model.thinkingLevel,
    }
  );
}

function sameModelDescriptor(
  left: AgentModelDescriptor,
  right: AgentModelDescriptor,
): boolean {
  return (
    left.provider === right.provider &&
    left.modelId === right.modelId &&
    normalizeModelThinkingLevel(left.thinkingLevel) ===
      normalizeModelThinkingLevel(right.thinkingLevel)
  );
}

function normalizeModelThinkingLevel(level: string): string {
  return level === "x-high" ? "xhigh" : level;
}
