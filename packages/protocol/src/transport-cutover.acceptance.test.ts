import { describe, expect, it } from 'vitest'
import { Value } from '@sinclair/typebox/value'
import { EnvironmentCapabilitiesSchema, rpcSchemas, rpcScopes, WsTicketRequestSchema } from './environment-v2.js'

describe('native transport cutover', () => {
  it('has no legacy RPC registry, scope, capability or ticket audience', () => {
    expect(Object.keys(rpcSchemas).filter(method => method.startsWith('legacy.'))).toEqual([])
    expect(Object.keys(rpcScopes).filter(method => method.startsWith('legacy.'))).toEqual([])
    expect(Object.keys(EnvironmentCapabilitiesSchema.properties)).not.toContain('legacyAdapter')
    expect(Value.Check(WsTicketRequestSchema, { audience: 'legacy', protocolVersion: 1 })).toBe(false)
  })
})
