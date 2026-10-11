import type { DetailFeatureEvent } from '@forge/protocol/environment-v2'
import type { ServerEvent } from '@forge/protocol'
/** Typed V2 metadata feeds the existing feature reducers without a legacy
 * envelope or unknown payload. Components retain their established state shape. */
export function projectFeatureEvent(event: DetailFeatureEvent): ServerEvent {
  switch (event.type) {
    case 'tool.activity': return { type: 'manager_tool_activity', ...event.activity }
    case 'activity.upsert': return { type: 'timeline_activity', sessionAgentId: event.item.sessionId, item: event.item }
    case 'throughput.upsert': return { type: 'generation_throughput', measurement: event.measurement, sessionSummary: event.summary }
    case 'throughput.snapshot': return { type: 'generation_throughput_snapshot', sessionAgentId: event.summary.sessionAgentId, measurements: event.measurements, sessionSummary: event.summary }
    case 'secure.upsert': return { type: 'secure_session_snapshot', ...event.snapshot }
    case 'secure.catalog.changed': return { type: 'secure_secret_catalog_changed', revision: event.revision }
    case 'elicitation.request': return { type: 'codex_elicitation_request', ...event.request }
    case 'elicitation.dismissed': return { type: 'codex_elicitation_dismissed', elicitationId: event.elicitationId, agentId: event.agentId }
    case 'terminals.snapshot': return { type: 'terminals_snapshot', sessionAgentId: event.scopeId, terminals: event.terminals }
    case 'terminal.upsert': return { type: 'terminal_updated', sessionAgentId: event.scopeId, terminal: event.terminal }
    case 'terminal.closed': return { type: 'terminal_closed', sessionAgentId: event.scopeId, terminalId: event.terminalId, reason: event.reason }
  }
}
