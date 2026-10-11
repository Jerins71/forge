import { formatActivityContent, type TimelineActivity, type TimelineActivityKind } from '@forge/protocol'
import type { EnvironmentActivityEntry } from '@/lib/ws-state'

/** One tool or reasoning row, whether it is still streaming or replayed from history. */
export interface ActivityRowModel {
  itemId: string
  /** Session whose history holds the row's persisted content. */
  sessionId: string
  kind: TimelineActivityKind
  status: 'running' | 'completed' | 'failed'
  summary: string
  startedAt: string
  completedAt?: string
  hidden?: boolean
  truncated?: boolean
  exitCode?: number
  /** Live rows carry their bounded content inline. */
  content?: string
  /** Replayed rows fetch their content the first time they are expanded. */
  contentRef?: string
}

export function liveActivityRow(item: TimelineActivity): ActivityRowModel {
  const content = formatActivityContent(item)
  return {
    itemId: item.itemId, sessionId: item.sessionId, kind: item.kind, status: item.status, summary: item.summary,
    startedAt: item.startedAt, completedAt: item.completedAt, hidden: item.hidden, truncated: item.truncated,
    exitCode: item.exitCode, ...(content ? { content } : {}),
  }
}

export function replayedActivityRow(entry: EnvironmentActivityEntry & { type: 'activity_summary' }): ActivityRowModel {
  const activity = entry.activity
  return {
    itemId: entry.itemId, sessionId: entry.agentId, kind: activity?.kind ?? 'tool',
    status: entry.status === 'completed' ? 'completed' : 'failed', summary: entry.displaySummary,
    startedAt: activity?.startedAt ?? entry.timestamp, completedAt: entry.timestamp, hidden: activity?.hidden,
    truncated: activity?.truncated, exitCode: activity?.exitCode, ...(entry.contentRef ? { contentRef: entry.contentRef } : {}),
  }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const GROUP_LABELS: Record<TimelineActivityKind, (count: number) => string> = {
  command: (count) => `Ran ${plural(count, 'command', 'commands')}`,
  file_edit: (count) => `Changed ${plural(count, 'file', 'files')}`,
  file_read: (count) => `Read ${plural(count, 'file', 'files')}`,
  search: (count) => (count === 1 ? 'Searched' : `Searched ${count} times`),
  web: (count) => (count === 1 ? 'Used the web' : `Used the web ${count} times`),
  agent: (count) => `Made ${plural(count, 'agent call', 'agent calls')}`,
  tool: (count) => `Used ${plural(count, 'tool', 'tools')}`,
  reasoning: (count) => (count === 1 ? 'Thought' : `Thought ${count} times`),
}

/** The collapsed header for finished rows: "Ran 2 commands, changed 1 file". */
export function summarizeActivityGroup(rows: readonly ActivityRowModel[]): string {
  const counts = new Map<TimelineActivityKind, number>()
  for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1)
  // The header names the work; thinking is named only when it is all there was.
  const work = [...counts.keys()].filter((kind) => kind !== 'reasoning')
  const parts = (work.length ? work : [...counts.keys()]).map((kind) => GROUP_LABELS[kind](counts.get(kind)!))
  return parts.map((part, index) => (index === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1))).join(', ')
}

/** The icon of the group header: the kind every row shares, or the first kind of work. */
export function groupKind(rows: readonly ActivityRowModel[]): TimelineActivityKind {
  return rows.find((row) => row.kind !== 'reasoning')?.kind ?? 'reasoning'
}

/** "45s", "33m 45s", "2h 05m": the wording of the turn header. */
export function formatWorkDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}
