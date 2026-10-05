import { validateLegacySessionEvent } from '@forge/protocol'
export { legacySessionEventAllowlist } from '@forge/protocol'
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
      'RESYNC_REQUIRED',
      'Invalid compatibility event',
    )
}
