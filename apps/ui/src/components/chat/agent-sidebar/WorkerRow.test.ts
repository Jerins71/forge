// Failure cases: a worker row's tooltip read `name / ` because worker summaries carried no model or
// preset; a worker whose turn failed was drawn as Idle. Both come from the same projection a live
// worker upsert and a reloaded detail snapshot share.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { ShellState } from '@forge/client-runtime'
import { projectSessionWorkers } from '@/lib/ws-client/environment-projection'
import { WorkerRow } from './WorkerRow'
import { workerTooltipLines } from './worker-tooltip'

const shell = { sessions: new Map([['session', { projectId: 'project', updatedAt: '2026-10-11T00:00:00.000Z', workspace: { cwd: '/repo' } }]]) } as unknown as ShellState
const summary = { agentId: 'reviewer', title: 'reviewer', status: 'idle' as const, model: { provider: 'openai-codex', modelId: 'gpt-6-sol', thinkingLevel: 'high' } }

it('shows the preset, model and reasoning of a worker, and the model alone without a preset', () => {
  const [withPreset] = projectSessionWorkers([], [{ ...summary, preset: 'independent-reviewer' }], 'session', shell)
  expect(workerTooltipLines(withPreset)).toEqual(['reviewer', 'independent-reviewer · openai-codex/gpt-6-sol · high'])
  const [plain] = projectSessionWorkers([], [summary], 'session', shell)
  expect(workerTooltipLines(plain)).toEqual(['reviewer', 'openai-codex/gpt-6-sol'])
  // A later upsert that changes the model is not hidden behind the previous descriptor.
  const [switched] = projectSessionWorkers([plain], [{ ...summary, model: { ...summary.model, modelId: 'gpt-6' } }], 'session', shell)
  expect(workerTooltipLines(switched)[1]).toBe('openai-codex/gpt-6')
})

it('draws a failed worker as failed, not idle', () => {
  const [failed] = projectSessionWorkers([], [{ ...summary, status: 'error' }], 'session', shell)
  const html = renderToStaticMarkup(createElement(WorkerRow, { agent: failed, liveStatus: { status: failed.status, pendingCount: 0 }, isSelected: false, onSelect: () => {} } as never))
  expect(html).toContain('aria-label="Failed"')
  expect(html).toContain('>Failed<')
})
