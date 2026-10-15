import { describe, expect, it, vi } from 'vitest'
import { createFeatureClients } from '../feature-clients/index.js'
import { EnvironmentRuntimeError } from '../errors.js'

// Compacting a long conversation outlasts the 10-second request timeout. The command's
// durable receipt, not the timeout, decides whether it worked.
function features(compact: () => Promise<unknown>, receipts: Array<unknown | Error>) {
  const commandIds: string[] = []
  const request = vi.fn(async (method: string, input: { commandId: string }) => {
    commandIds.push(input.commandId)
    if (method === 'session.compact') return compact()
    const next = receipts.shift()
    if (next instanceof Error) throw next
    return next
  })
  const clients = createFeatureClients({ entry: { environmentId: 'environment' }, fetch: vi.fn(), json: vi.fn() } as never, { request, subscribe: vi.fn() } as never)
  return { clients, request, commandIds }
}
const timedOut = () => Promise.reject(new EnvironmentRuntimeError('UNAVAILABLE', 'Request timed out', true))
const receipt = (state: string, error?: string) => ({ state, ...(error ? { error: { message: error } } : {}) })

describe('manual compaction outlasting the request timeout', () => {
  it('waits for the same command to finish when the request times out', async () => {
    const f = features(timedOut, [receipt('running'), receipt('running'), receipt('succeeded')])
    await expect(f.clients.sessions.compact('session')).resolves.toBeUndefined()
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['session.compact', 'command.get', 'command.get', 'command.get'])
    expect(new Set(f.commandIds).size).toBe(1)
  })
  it('reports the real failure when the compaction itself fails', async () => {
    const f = features(timedOut, [receipt('running'), receipt('failed', 'Claude compaction failed')])
    await expect(f.clients.sessions.compact('session')).rejects.toThrow('Claude compaction failed')
  })
  it('keeps the timeout when the receipt cannot be read', async () => {
    const f = features(timedOut, [new EnvironmentRuntimeError('UNAVAILABLE', 'Disconnected', true)])
    await expect(f.clients.sessions.compact('session')).rejects.toThrow('Request timed out')
  })
  it('does not poll after a definite rejection', async () => {
    const f = features(() => Promise.reject(new EnvironmentRuntimeError('FORBIDDEN', 'Not allowed')), [])
    await expect(f.clients.sessions.compact('session')).rejects.toThrow('Not allowed')
    expect(f.request).toHaveBeenCalledTimes(1)
  })
})
