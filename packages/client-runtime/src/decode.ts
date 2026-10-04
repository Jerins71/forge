import { Value } from '@sinclair/typebox/value'
import {
  rpcRegistry,
  type StreamMethod,
  type UnknownStreamItem,
} from '@forge/protocol/environment-v2'
import { EnvironmentRuntimeError } from './errors.js'
const shellTypes = new Set([
  'project.upsert',
  'project.remove',
  'session.upsert',
  'session.remove',
])
const detailTypes = new Set([
  'item.upsert',
  'worker.upsert',
  'worker.remove',
  'choice.upsert',
  'receipt.upsert',
  'session.upsert',
  'detail.reset',
])
export function decodeStreamItem(
  method: StreamMethod,
  item: unknown,
  sessionId?: string,
): unknown {
  if (method === 'shell.subscribe' || method === 'session.subscribe') {
    if (item && typeof item === 'object') {
      const value = item as {
        kind?: unknown
        streamEpoch?: unknown
        sequence?: unknown
        event?: { type?: unknown }
      }
      const known = method === 'shell.subscribe' ? shellTypes : detailTypes
      if (
        value.kind === 'event' &&
        typeof value.event?.type === 'string' &&
        !known.has(value.event.type)
      ) {
        if (
          Object.keys(value).length !== 4 ||
          typeof value.streamEpoch !== 'string' ||
          !/^[0-9a-f-]{36}$/.test(value.streamEpoch) ||
          !Number.isSafeInteger(value.sequence) ||
          (value.sequence as number) < 0
        )
          throw new EnvironmentRuntimeError(
            'RESYNC_REQUIRED',
            'Invalid unknown event envelope',
          )
        return {
          kind: 'unknown',
          streamEpoch: value.streamEpoch,
          sequence: value.sequence as number,
          eventType: value.event.type,
        } satisfies UnknownStreamItem
      }
    }
  }
  const schema = rpcRegistry[method].stream
  if (!schema || !Value.Check(schema, item))
    throw new EnvironmentRuntimeError('RESYNC_REQUIRED', 'Invalid stream item')
  if (method === 'legacy.session.subscribe')
    validateLegacyEvent(
      (item as { type: string; payload: unknown }).type,
      (item as { payload: unknown }).payload,
      sessionId,
    )
  return item
}
export const legacySessionEventAllowlist = [
  'session_plan_snapshot',
  'session_goal_snapshot',
  'manager_tool_activity',
  'browser_session_snapshot',
  'browser_session_changed',
  'secure_session_snapshot',
  'secure_secret_catalog_changed',
  'codex_elicitation_request',
  'codex_elicitation_dismissed',
  'generation_throughput',
  'generation_throughput_snapshot',
] as const
type LegacyType = (typeof legacySessionEventAllowlist)[number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= 128
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
function bounded(value: unknown, depth = 0): boolean {
  if (depth > 12) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= 32_768
  if (Array.isArray(value))
    return value.length <= 256 && value.every((v) => bounded(v, depth + 1))
  return (
    isRecord(value) &&
    Object.keys(value).length <= 128 &&
    Object.entries(value).every(
      ([key, v]) =>
        key.length <= 128 && (v === undefined || bounded(v, depth + 1)),
    )
  )
}

/** Explicit event-specific requirements plus recursive byte/depth/string/array caps. */
function validateLegacySessionEvent(
  value: unknown,
  sessionId: string,
): boolean {
  if (
    !isRecord(value) ||
    !legacySessionEventAllowlist.includes(value.type as LegacyType) ||
    !bounded(value) ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536
  )
    return false
  if (
    ('sessionAgentId' in value && value.sessionAgentId !== sessionId) ||
    ('agentId' in value && value.agentId !== sessionId)
  )
    return false
  switch (value.type as LegacyType) {
    case 'manager_tool_activity':
      return (
        value.sessionAgentId === sessionId &&
        number(value.revision) &&
        number(value.toolCount) &&
        (value.backgroundCount === undefined || number(value.backgroundCount))
      )
    case 'session_plan_snapshot':
      return (
        value.sessionAgentId === sessionId &&
        id(value.profileId) &&
        number(value.revision) &&
        (typeof value.updatedAt === 'string' || value.updatedAt === null) &&
        Array.isArray(value.plan) &&
        value.plan.every(
          (step) =>
            isRecord(step) &&
            typeof step.step === 'string' &&
            ['pending', 'in_progress', 'completed'].includes(
              String(step.status),
            ),
        )
      )
    case 'session_goal_snapshot':
      return (
        value.sessionAgentId === sessionId &&
        id(value.profileId) &&
        number(value.revision) &&
        typeof value.measuredAt === 'string' &&
        (value.goal === null ||
          (isRecord(value.goal) &&
            id(value.goal.id) &&
            typeof value.goal.objective === 'string' &&
            ['active', 'paused', 'blocked', 'completed', 'cancelled'].includes(
              String(value.goal.status),
            ) &&
            number(value.goal.activeElapsedMs) &&
            number(value.goal.turnCount) &&
            isRecord(value.goal.usage)))
      )
    case 'secure_secret_catalog_changed':
      return number(value.revision)
    case 'secure_session_snapshot':
      return (
        value.sessionAgentId === sessionId &&
        id(value.profileId) &&
        number(value.revision) &&
        typeof value.updatedAt === 'string' &&
        ['manager', 'worker'].includes(String(value.principalKind)) &&
        typeof value.executionMode === 'string' &&
        typeof value.environmentStatus === 'string' &&
        Array.isArray(value.leases) &&
        value.leases.every(isRecord) &&
        Array.isArray(value.pendingRequests) &&
        value.pendingRequests.every(isRecord)
      )
    case 'browser_session_snapshot':
    case 'browser_session_changed':
      return (
        isRecord(value.snapshot) &&
        value.snapshot.sessionAgentId === sessionId &&
        id(value.snapshot.profileId) &&
        Array.isArray(value.snapshot.tabs) &&
        value.snapshot.tabs.every((tab) => isRecord(tab) && id(tab.tabId)) &&
        (value.type === 'browser_session_snapshot' ||
          [
            'host-report',
            'automation',
            'human-command',
            'lifecycle',
            'recovery',
          ].includes(String(value.reason)))
      )
    case 'codex_elicitation_dismissed':
      return value.agentId === sessionId && id(value.elicitationId)
    case 'codex_elicitation_request':
      return (
        value.agentId === sessionId &&
        id(value.elicitationId) &&
        id(value.sidecarAgentId) &&
        ['form', 'url'].includes(String(value.mode)) &&
        typeof value.message === 'string' &&
        Array.isArray(value.persistScopes) &&
        value.persistScopes.every((s) => s === 'session' || s === 'always') &&
        (value.fields === undefined ||
          (Array.isArray(value.fields) &&
            value.fields.every(
              (f) =>
                isRecord(f) &&
                id(f.key) &&
                typeof f.label === 'string' &&
                ['string', 'boolean', 'number', 'enum'].includes(
                  String(f.type),
                ) &&
                typeof f.required === 'boolean',
            )))
      )
    case 'generation_throughput':
      return (
        isRecord(value.measurement) &&
        value.measurement.sessionId === sessionId &&
        id(value.measurement.measurementId) &&
        number(value.measurement.sequence) &&
        ['starting', 'generating', 'completed', 'aborted'].includes(
          String(value.measurement.phase),
        )
      )
    case 'generation_throughput_snapshot':
      return (
        value.sessionAgentId === sessionId &&
        Array.isArray(value.measurements) &&
        value.measurements.every(
          (m) =>
            isRecord(m) &&
            m.sessionId === sessionId &&
            id(m.measurementId) &&
            number(m.sequence),
        ) &&
        isRecord(value.sessionSummary)
      )
  }
}

export function validateLegacyEvent(
  type: string,
  payload: unknown,
  sessionId?: string,
): void {
  if (
    !isRecord(payload) ||
    payload.type !== type ||
    !validateLegacySessionEvent(
      payload,
      sessionId ?? String(payload.sessionAgentId ?? payload.agentId ?? ''),
    )
  )
    throw new EnvironmentRuntimeError(
      'RESYNC_REQUIRED',
      'Invalid compatibility event',
    )
}
