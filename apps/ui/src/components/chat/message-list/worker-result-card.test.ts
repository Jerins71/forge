// Failure cases: a worker result's body was drawn as plain text, so its markdown read as "- findings:";
// a failed worker's header said "Error" while its sidebar row said "Failed".
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ConversationMessageRow } from './ConversationMessageRow'
import { formatAgentStatus } from '../ChatHeader'

const card = (text: string) => renderToStaticMarkup(createElement(ConversationMessageRow, { message: {
  type: 'conversation_message', id: 'result', agentId: 'session', role: 'system', source: 'worker_report', sourceWorkerId: 'reviewer',
  text, timestamp: '2026-10-11T20:41:00.000Z',
} } as never))

it('renders a worker result body as markdown and keeps the status chip', () => {
  const structured = card('status: done\nsummary: Checked **two** files.\n- findings: none\nrisks: `rm` is unguarded')
  expect(structured).toContain('data-worker-result-status="done"')
  expect(structured).toMatch(/<strong[^>]*>two<\/strong>/)
  expect(structured).toMatch(/<li[^>]*>[^]*findings: none/)
  expect(structured).toContain('<code')
  const plain = card('- findings:\n  - one')
  expect(plain).toMatch(/<li[^>]*>/)
  expect(plain).not.toContain('- findings:')
})

it('names a failed worker "Failed" in the header, as the sidebar does', () => {
  expect(formatAgentStatus('error', 'worker')).toBe('Failed')
  expect(formatAgentStatus('error', 'manager')).toBe('Error')
})
