import { blocksOpenRouterFallback } from "./runtime/pi/openrouter-request-policy.js";
import { inferProviderFromModelId, normalizeThinkingLevelForModelDescriptor } from "./catalog/model-presets.js";
import { normalizeOptionalAgentId } from "./swarm-manager-utils.js";
import { normalizeEffortTier, resolveTierConfig } from "./agents/specialists/specialist-registry.js";
import type { AgentDescriptor, AgentModelDescriptor, SwarmReasoningLevel } from "./types.js";
interface FallbackEntry { specialistId:string; fallbackModelId?:string; fallbackReasoningLevel?:SwarmReasoningLevel }
export interface SpecialistFallbackPolicyOptions {
  dataDir?:string; descriptors:Map<string,AgentDescriptor>;
  resolveSpecialistRosterForProfile(profileId:string):Promise<FallbackEntry[]>;
  resolveSpecialistRosterForManager?(manager:AgentDescriptor):Promise<FallbackEntry[]>;
  resolveSpawnModelWithCapacityFallback(model:AgentModelDescriptor):AgentModelDescriptor;
}
/** Selection only. Runs, replay and callback fencing belong to the authoritative core. */
export class SpecialistFallbackPolicy {
  constructor(private readonly options:SpecialistFallbackPolicyOptions) {}
  async resolveSpecialistFallbackModelForDescriptor(
    descriptor: AgentDescriptor
  ): Promise<AgentModelDescriptor | undefined> {
    if (blocksOpenRouterFallback(descriptor.model)) return undefined;
    if (descriptor.role === "worker" && descriptor.delegationFallbackModel) {
      return this.options.resolveSpawnModelWithCapacityFallback({
        ...descriptor.delegationFallbackModel,
      });
    }

    if (descriptor.role !== "worker" || !descriptor.specialistId || !descriptor.profileId) {
      return undefined;
    }

    const specialistId = normalizeOptionalAgentId(descriptor.specialistId)?.toLowerCase();
    if (!specialistId) {
      return undefined;
    }

    const tier = descriptor.specialistTier ?? normalizeEffortTier(specialistId.split(":")[0]);
    if (tier && this.options.dataDir) {
      const tierConfig = await resolveTierConfig(this.options.dataDir, tier);
      if (!tierConfig.fallbackModelId) {
        return undefined;
      }
      const inferredFallbackProvider =
        tierConfig.fallbackProvider ?? inferProviderFromModelId(tierConfig.fallbackModelId);
      if (!inferredFallbackProvider) {
        return undefined;
      }
      const fallbackModel: AgentModelDescriptor = {
        provider: inferredFallbackProvider,
        modelId: tierConfig.fallbackModelId,
        thinkingLevel: tierConfig.fallbackReasoningLevel ?? descriptor.model.thinkingLevel
      };
      fallbackModel.thinkingLevel = normalizeThinkingLevelForModelDescriptor(fallbackModel);
      return this.options.resolveSpawnModelWithCapacityFallback(fallbackModel);
    }

    const managerDescriptor = this.options.descriptors.get(descriptor.managerId);
    const roster = managerDescriptor && this.options.resolveSpecialistRosterForManager
      ? await this.options.resolveSpecialistRosterForManager(managerDescriptor)
      : await this.options.resolveSpecialistRosterForProfile(descriptor.profileId);
    const specialist = roster.find((entry) => entry.specialistId === specialistId);
    if (!specialist?.fallbackModelId) {
      return undefined;
    }

    const inferredFallbackProvider = inferProviderFromModelId(specialist.fallbackModelId);
    if (!inferredFallbackProvider) {
      return undefined;
    }

    const fallbackModel: AgentModelDescriptor = {
      provider: inferredFallbackProvider,
      modelId: specialist.fallbackModelId,
      thinkingLevel: specialist.fallbackReasoningLevel ?? descriptor.model.thinkingLevel
    };
    fallbackModel.thinkingLevel = normalizeThinkingLevelForModelDescriptor(fallbackModel);
    return this.options.resolveSpawnModelWithCapacityFallback(fallbackModel);
  }

}
