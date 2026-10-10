import type { BrowserSessionSnapshot } from '@forge/protocol'
import type { ManagerWsState } from '../ws-state'
function isSelectedSession(state: ManagerWsState, sessionAgentId: string): boolean {
  if (state.targetAgentId === sessionAgentId || state.subscribedAgentId === sessionAgentId) return true
  const selectedId = state.targetAgentId ?? state.subscribedAgentId
  const selected = state.agents.find((agent) => agent.agentId === selectedId)
  return selected?.role === 'worker' && selected.managerId === sessionAgentId
}

export function projectPanelRevealRequest(
  state: ManagerWsState,
  sessions: Record<string, BrowserSessionSnapshot>,
  hostGeneration: number | null,
): ManagerWsState['browserPanelRevealRequest'] {
  if (hostGeneration === null) return null
  const snapshot = Object.values(sessions).find((candidate) => isSelectedSession(state, candidate.sessionAgentId))
  const reveal = snapshot?.panelReveal
  if (!snapshot || !reveal || reveal.sequence <= reveal.acknowledgedSequence || reveal.tabId === null) return null
  if (!snapshot.tabs.some((tab) => tab.tabId === reveal.tabId
    && tab.targetAffinity === 'managed-electron'
    && tab.lifecycle !== 'closed')) return null
  return {
    sessionAgentId: snapshot.sessionAgentId,
    profileId: snapshot.profileId,
    tabId: reveal.tabId,
    hostGeneration,
    sequence: reveal.sequence,
  }
}

