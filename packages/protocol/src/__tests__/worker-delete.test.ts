import { expect, it } from 'vitest'
import { Value } from '@sinclair/typebox/value'
import { rpcSchemas, rpcScopes, EnvironmentCapabilitiesSchema } from '../environment-v2.js'

it('declares worker.delete as a strict durable session operation distinct from worker.kill', () => {
  expect(rpcSchemas).toHaveProperty('worker.delete')
  const contract = rpcSchemas['worker.delete']
  expect(contract.receipt).toBe(true)
  expect(rpcScopes['worker.delete']).toBe('session:operate')
  const input = { commandId: '00000000-0000-4000-8000-000000000001', sessionId: 'manager', workerId: 'worker' }
  expect(Value.Check(contract.input, input)).toBe(true)
  expect(Value.Check(contract.input, { ...input, deleteManager: true })).toBe(false)
  expect(Value.Check(contract.input, { ...input, workerId: undefined })).toBe(false)
  expect(EnvironmentCapabilitiesSchema.properties).toHaveProperty('workerDelete')
})
