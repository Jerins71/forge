import type { AgentDescriptor } from '@forge/protocol'

/** The worker's name, then `preset · provider/model · reasoning`, or the model alone for a worker started without a preset. */
export function workerTooltipLines(agent: Pick<AgentDescriptor, 'agentId' | 'displayName' | 'model' | 'specialistId' | 'specialistDisplayName'>): string[] {
  const preset = agent.specialistDisplayName ?? agent.specialistId
  const model = agent.model.modelId ? `${agent.model.provider}/${agent.model.modelId}` : ''
  return [
    agent.displayName || agent.agentId,
    ...(preset ? [[preset, model, agent.model.thinkingLevel].filter(Boolean).join(' · ')] : model ? [model] : []),
  ]
}
