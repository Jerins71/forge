import { describe, expect, it } from 'vitest'
import { Value } from '@sinclair/typebox/value'
import { decodeEnvironmentValue, rpcSchemas, rpcScopes, BrowserEngineSnapshotSchema, BrowserCookiePreviewSchema, BrowserScreencastItemSchema } from './environment-v2.js'

describe('environment browser engine wire contract', () => {
  it('uses scoped ephemeral actions with no durable command or host lease', () => {
    for (const method of ['browser.tabs.open', 'browser.tabs.close', 'browser.tabs.navigate', 'browser.tabs.input', 'browser.cookies.apply'] as const) {
      expect(rpcSchemas[method].receipt).toBe(false)
      expect(rpcScopes[method]).toBe('session:operate')
    }
    expect(Value.Check(rpcSchemas['browser.tabs.open'].input, { sessionId: 's', url: 'https://example.com' })).toBe(true)
    expect(Value.Check(rpcSchemas['browser.tabs.open'].input, { sessionId: 's', commandId: 'old-command' })).toBe(false)
    expect(Value.Check(rpcSchemas['browser.tabs.input'].input, { sessionId: 's', tabId: 't', input: { kind: 'text', text: 'hello' } })).toBe(true)
    expect(Value.Check(rpcSchemas['browser.tabs.input'].input, { sessionId: 's', tabId: 't', input: { kind: 'mouse', type: 'mousePressed', x: 2, y: 3, button: 'left', clickCount: 1 } })).toBe(true)
  })
  it('bounds frames below the existing environment frame envelope and ignores future response fields', () => {
    const frame = { kind: 'frame', tabId: 't', frameId: 1, data: 'a'.repeat(500000), mimeType: 'image/jpeg', width: 1280, height: 720, timestamp: 2 }
    expect(Value.Check(BrowserScreencastItemSchema, frame)).toBe(true)
    expect(Value.Check(BrowserScreencastItemSchema, { ...frame, data: 'a'.repeat(800001) })).toBe(false)
    expect(decodeEnvironmentValue(BrowserScreencastItemSchema, { ...frame, future: true })).toEqual(frame)
    expect(Value.Check(rpcSchemas['browser.screencast.ack'].input, { subscriptionId: 'sub', frameId: 1, other: true })).toBe(false)
  })
  it('previews only site counts; committing selected domains is explicit', () => {
    const preview = { ok: true, importId: 'i', source: 'chrome-running', domains: [{ domain: 'example.com', count: 2 }], expiresAt: '2026-10-13T12:00:00.000Z' }
    expect(Value.Check(BrowserCookiePreviewSchema, preview)).toBe(true)
    expect(Value.Check(BrowserCookiePreviewSchema, { ...preview, cookies: [{ value: 'private' }] })).toBe(false)
    expect(Value.Check(rpcSchemas['browser.cookies.apply'].input, { sessionId: 's', importId: 'i', domains: ['example.com'] })).toBe(true)
    expect(Value.Check(rpcSchemas['browser.cookies.apply'].input, { sessionId: 's', importId: 'i', domains: [] })).toBe(false)
    expect(Value.Check(BrowserCookiePreviewSchema, { ok: false, error: { code: 'files-folders-denied', message: 'Allow Forge to read Chrome cookies in Files & Folders.', settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders' } })).toBe(true)
  })
  it('shares simple session tabs across local and remote hosts', () => {
    const snapshot = { sessionId: 's', projectId: 'p', tabs: [], activeTabId: null, revision: 0 }
    expect(Value.Check(BrowserEngineSnapshotSchema, snapshot)).toBe(true)
    expect(rpcScopes['browser.tabs.subscribe']).toBe('session:read')
    expect(rpcScopes['browser.screencast.subscribe']).toBe('session:read')
    expect(rpcScopes['browser.cookies.preview']).toBe('session:operate')
  })
})
