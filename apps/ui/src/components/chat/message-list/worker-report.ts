export type WorkerReportStatus = 'done' | 'partial' | 'blocked' | 'failed'

export interface WorkerReport {
  status: WorkerReportStatus
  summary: string
  /** Remaining labelled lines, such as changed, verified and risks, in the order written. */
  details: Array<{ label: string; value: string }>
  followUp?: string
}

const FIELD_LINE = /^\s*(?:[-*]\s*)?\**(status|summary|changed|verified|risks|follow[- ]?up)\**\s*:\**\s*(.*)$/i

const STATUSES: Record<string, WorkerReportStatus> = {
  done: 'done', complete: 'done', completed: 'done', success: 'done',
  partial: 'partial',
  blocked: 'blocked',
  failed: 'failed', error: 'failed',
}

/** The report status a field value names, if any: `done`, `**Blocked**`, `failed.` */
function reportStatus(value: string): WorkerReportStatus | undefined {
  return STATUSES[value.toLowerCase().match(/[a-z]+/)?.[0] ?? '']
}

/**
 * Reads the "status / summary / changed / verified / risks / follow-up" shape workers end with.
 * The environment wraps a reply as `status:` / `summary:`, and the reply often carries its own report
 * (`- status:` lines) or markdown: the first status is the card's, a repeated field adds to the one
 * already read, and a "status" line that names no report status is the worker's own text.
 * Returns null for anything else, so free-form results keep rendering as written.
 */
export function parseWorkerReport(text: string): WorkerReport | null {
  const fields = new Map<string, string>()
  const preamble: string[] = []
  let status: WorkerReportStatus | undefined
  let current: string | null = null
  const append = (line: string) => {
    if (current) fields.set(current, `${fields.get(current) ?? ''}\n${line}`)
    else preamble.push(line)
  }
  for (const line of text.split('\n')) {
    const match = FIELD_LINE.exec(line)
    if (!match) { append(line); continue }
    const label = match[1]!.toLowerCase().replace(/[- ]/g, '')
    const value = match[2]!.trim()
    if (label === 'status') {
      const named = reportStatus(value)
      if (!named) append(line)
      else status ??= named
      continue
    }
    current = label
    const prior = fields.get(label)?.trim()
    // A repeated field continues the one already read: a blank line apart if it had text.
    fields.set(label, prior ? `${prior}\n\n${value}` : value)
  }
  if (!status) return null

  const read = (label: string) => (fields.get(label) ?? '').trim()
  const followUp = read('followup')
  return {
    status,
    summary: [preamble.join('\n').trim(), read('summary')].filter(Boolean).join('\n\n'),
    details: ['changed', 'verified', 'risks']
      .map((label) => ({ label, value: read(label) }))
      .filter((detail) => detail.value && !/^none\.?$/i.test(detail.value)),
    ...(followUp && !/^none\.?$/i.test(followUp) ? { followUp } : {}),
  }
}
