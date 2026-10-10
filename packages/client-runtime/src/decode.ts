import { validateLegacySessionEvent } from '@forge/protocol'
export { legacySessionEventAllowlist } from '@forge/protocol'
import {
  rpcRegistry,
  decodeEnvironmentValue,
  type StreamMethod,
  type UnknownStreamItem,
} from '@forge/protocol/environment-v2'
import { EnvironmentRuntimeError } from './errors.js'
const shellTypes = new Set([
  'recovery.upsert',
  'project.upsert',
  'project.remove',
  'session.upsert',
  'session.remove',
])
const detailTypes = new Set([
  'plan.upsert', 'goal.upsert', 'recovery.upsert',
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
          typeof value.streamEpoch !== 'string' ||
          !/^[0-9a-f-]{36}$/.test(value.streamEpoch) ||
          !Number.isSafeInteger(value.sequence) ||
          (value.sequence as number) < 0
        )
          throw new EnvironmentRuntimeError(
            'PROTOCOL_MISMATCH',
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
  const decoded = schema && decodeEnvironmentValue(schema, item)
  if (decoded === undefined)
    throw new EnvironmentRuntimeError('PROTOCOL_MISMATCH', 'Invalid stream item')
  if (method === 'legacy.session.subscribe')
    validateLegacyEvent(
      (decoded as { type: string; payload: unknown }).type,
      (decoded as { payload: unknown }).payload,
      sessionId,
    )
  return decoded
}
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

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
      'PROTOCOL_MISMATCH',
      'Invalid compatibility event',
    )
}
