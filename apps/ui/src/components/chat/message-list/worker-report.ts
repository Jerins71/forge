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

/**
 * Reads the "status / summary / changed / verified / risks / follow-up" shape workers end with.
 * Returns null for anything else, so free-form results keep rendering as written.
 */
export function parseWorkerReport(text: string): WorkerReport | null {
  const fields = new Map<string, string>()
  const preamble: string[] = []
  let current: string | null = null
  for (const line of text.split('\n')) {
    const match = FIELD_LINE.exec(line)
    if (match) {
      current = match[1]!.toLowerCase().replace(/[- ]/g, '')
      fields.set(current, match[2]!.trim())
    } else if (current) {
      fields.set(current, `${fields.get(current)}\n${line}`.trim())
    } else {
      preamble.push(line)
    }
  }

  const status = STATUSES[(fields.get('status') ?? '').toLowerCase().split(/[^a-z]/)[0] ?? '']
  if (!status) return null

  const followUp = fields.get('followup')
  return {
    status,
    summary: [preamble.join('\n').trim(), fields.get('summary') ?? ''].filter(Boolean).join('\n\n'),
    details: ['changed', 'verified', 'risks']
      .map((label) => ({ label, value: fields.get(label) ?? '' }))
      .filter((detail) => detail.value && !/^none\.?$/i.test(detail.value)),
    ...(followUp && !/^none\.?$/i.test(followUp) ? { followUp } : {}),
  }
}
