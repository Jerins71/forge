// Failure cases: a worker row's tooltip read `name / ` because worker summaries carried no model or
// preset; a worker whose turn failed was drawn as Idle. Both come from the same projection a live
// worker upsert and a reloaded detail snapshot share.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { ShellState } from '@forge/client-runtime'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import { buildProfileTreeRows } from '@/lib/agent-hierarchy'
import { projectSessionWorkers } from '@/lib/ws-client/environment-projection'
import { WorkerRow } from './WorkerRow'
import { workerTooltipLines } from './worker-tooltip'

const shell = { sessions: new Map([['session', { projectId: 'project', updatedAt: '2026-10-11T00:00:00.000Z', workspace: { cwd: '/repo' } }]]) } as unknown as ShellState
const summary = { agentId: 'reviewer', title: 'reviewer', status: 'idle' as const, model: { provider: 'openai-codex', modelId: 'gpt-6-sol', thinkingLevel: 'high' } }

it('shows the preset, model and reasoning of a worker, and the model and reasoning without a preset', () => {
  const [withPreset] = projectSessionWorkers([], [{ ...summary, preset: 'independent-reviewer' }], 'session', shell)
  expect(workerTooltipLines(withPreset)).toEqual(['reviewer', 'independent-reviewer · openai-codex/gpt-6-sol · high'])
  const [plain] = projectSessionWorkers([], [summary], 'session', shell)
  expect(workerTooltipLines(plain)).toEqual(['reviewer', 'openai-codex/gpt-6-sol · high'])
  // A worker recorded before summaries carried its model shows its name alone, never `name / `.
  const [legacy] = projectSessionWorkers([], [{ agentId: 'old', title: 'old', status: 'idle' }], 'session', shell)
  expect(workerTooltipLines(legacy)).toEqual(['old'])
  // A later upsert that changes the model is not hidden behind the previous descriptor.
  const [switched] = projectSessionWorkers([plain], [{ ...summary, model: { ...summary.model, modelId: 'gpt-6' } }], 'session', shell)
  expect(workerTooltipLines(switched)[1]).toBe('openai-codex/gpt-6 · high')
})

it('draws a failed worker as failed, not idle', () => {
  const [failed] = projectSessionWorkers([], [{ ...summary, status: 'error' }], 'session', shell)
  const html = renderToStaticMarkup(createElement(WorkerRow, { agent: failed, liveStatus: { status: failed.status, pendingCount: 0 }, isSelected: false, onSelect: () => {} } as never))
  expect(html).toContain('aria-label="Failed"')
  expect(html).toContain('>Failed<')
})

// Workers were given the session's last update as their start time, so their order depended on when
// each was projected and changed after a reload. They are listed oldest first on every path.
it('lists a session\'s workers oldest first, live and after a reload', () => {
  const manager = { agentId: 'session', managerId: 'session', profileId: 'project', role: 'manager', status: 'idle', displayName: 'session',
    createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', cwd: '/repo', model: summary.model, sessionFile: '' } as AgentDescriptor
  const profiles = [{ profileId: 'project', displayName: 'project', defaultSessionAgentId: 'session', createdAt: manager.createdAt, updatedAt: manager.updatedAt }] as ManagerProfile[]
  const worker = (agentId: string, minute: number) => ({ ...summary, agentId, title: agentId, createdAt: `2026-10-11T20:${String(minute).padStart(2, '0')}:00.000Z` })
  const order = (agents: AgentDescriptor[]) => buildProfileTreeRows(agents, profiles)[0]!.sessions[0]!.workers.map(w => w.agentId)
  // Live: each upsert arrives as the worker starts.
  let live = projectSessionWorkers([manager], [worker('zeta', 1)], 'session', shell)
  live = projectSessionWorkers(live, [worker('zeta', 1), worker('alpha', 2)], 'session', shell)
  // Reload: the snapshot lists them in any order.
  const reloaded = projectSessionWorkers([manager], [worker('alpha', 2), worker('zeta', 1)], 'session', shell)
  expect(order(live)).toEqual(['zeta', 'alpha'])
  expect(order(reloaded)).toEqual(['zeta', 'alpha'])
})
