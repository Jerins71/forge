// Failure cases: local device scopes confused with host authority; untyped legacy
// envelopes admitted; resize/host replies replayed; browser canonical state lost.
import { describe, expect, it } from 'vitest'
import { rpcRegistry } from './environment-v2.js'
import { Value } from '@sinclair/typebox/value'
import { BrowserHostStreamV2Schema } from './browser-v2.js'

describe('native Browser contract', () => {
  it.each(['browser.tab.open', 'browser.tab.activate', 'browser.tab.close', 'browser.recording.start', 'browser.recording.stop'])(
    'gives %s an addressed receipt and device scope', method => {
      const entry = (rpcRegistry as unknown as Record<string, { receipt: boolean; scope: string; input: { properties: Record<string, unknown> } }>)[method]
      expect(entry?.receipt).toBe(true)
      expect(entry?.scope).toBe('session:operate')
      expect(entry?.input.properties).toHaveProperty('sessionId')
      expect(entry?.input.properties).toHaveProperty('commandId')
    })
  it.each(['browser.tab.resize', 'browser.host.register', 'browser.host.hydrate', 'browser.host.focus', 'browser.host.send', 'browser.host.reveal'])(
    'keeps %s ephemeral', method => {
      expect((rpcRegistry as unknown as Record<string, { receipt: boolean }>)[method]?.receipt).toBe(false)
    })
})

// Failure mode: canonical multi-session report results exceed a single frame.
it('bounds report result frames with the existing host chunk envelope', () => {
  expect(Value.Check(BrowserHostStreamV2Schema, { kind: 'report.result', requestId: 'report', hostId: 'host', hostGeneration: 1, chunkIndex: 0, chunkCount: 2, payloadBase64: 'e30=' })).toBe(true)
  expect(Value.Check(BrowserHostStreamV2Schema, { kind: 'report.result', requestId: 'report', result: { hostId: 'host', hostGeneration: 1, status: 'processed', sessions: [] } })).toBe(false)
})
