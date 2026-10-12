import type { AgentDescriptor } from '@forge/protocol'

/**
 * The worker's name, then `preset · provider/model · reasoning`. A part that is unknown (a worker
 * recorded before summaries carried its model) is left out, and an empty line is never shown.
 */
export function workerTooltipLines(agent: Pick<AgentDescriptor, 'agentId' | 'displayName' | 'model' | 'specialistId' | 'specialistDisplayName'>): string[] {
  const preset = agent.specialistDisplayName ?? agent.specialistId
  const model = agent.model.modelId ? `${agent.model.provider}/${agent.model.modelId}` : ''
  return [
    agent.displayName || agent.agentId,
    [preset, model, model ? agent.model.thinkingLevel : ''].filter(Boolean).join(' · '),
  ].filter(Boolean)
}
