import { describe, expect, it } from 'vitest'
import { Value } from '@sinclair/typebox/value'
import { decodeEnvironmentValue, rpcSchemas, rpcScopes, BrowserEngineSnapshotSchema, BrowserCookiePreviewSchema, BrowserScreencastItemSchema, DeviceSessionSchema } from './environment-v2.js'

describe('environment browser engine wire contract', () => {
  it('preserves a popup opener in the session tab inventory', () => {
    const tab = { tabId: 'popup', openerTabId: 'opener', sessionId: 's', projectId: 'p', host: 'headless', url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false, viewport: { width: 1280, height: 800 }, controller: 'none' }
    expect(Value.Check(BrowserEngineSnapshotSchema, { sessionId: 's', projectId: 'p', tabs: [tab], activeTabId: 'popup', revision: 1 })).toBe(true)
  })
  it('carries a host setup command through status, setup and tab snapshots', () => {
    const command = 'sudo forge browser setup'
    expect(Value.Check(rpcSchemas['browser.engine.status'].output, { state: 'needs-host-setup', setupCommand: command })).toBe(true)
    expect(Value.Check(rpcSchemas['browser.engine.setup'].output, { browserEngineState: 'needs-host-setup', browserEngineSetupCommand: command })).toBe(true)
    expect(Value.Check(BrowserEngineSnapshotSchema, { sessionId: 's', projectId: 'p', tabs: [], activeTabId: null, revision: 0, browserEngineState: 'needs-host-setup', browserEngineSetupCommand: command })).toBe(true)
  })
  it('already projects import authority in the current device session scopes', () => {
    const session = { deviceSessionId: '11111111-1111-1111-1111-111111111111', deviceName: 'test', kind: 'browser', createdAt: '2026-10-13T12:00:00.000Z', lastSeenAt: '2026-10-13T12:00:00.000Z', expiresAt: '2026-10-13T13:00:00.000Z', revokedAt: null, isCurrent: true }
    for (const scopes of [['session:operate'], ['settings:admin']]) {
      const device = decodeEnvironmentValue(DeviceSessionSchema, { ...session, scopes })
      expect(device?.scopes.includes('settings:admin')).toBe(scopes.includes('settings:admin'))
    }
  })
  it('requires admin for all source import and export operations, with strict cancel input', () => {
    for (const method of ['browser.cookies.preview', 'browser.cookies.apply', 'browser.cookies.prepareSend', 'browser.cookies.receive', 'browser.cookies.cancel'] as const)
      expect(rpcScopes[method]).toBe('settings:admin')
    expect(rpcScopes['browser.cookies.audit']).toBe('session:read')
    expect(rpcScopes['browser.cookies.forget']).toBe('session:operate')
    expect(Value.Check(rpcSchemas['browser.cookies.cancel'].input, { sessionId: 's', importId: 'i' })).toBe(true)
    expect(Value.Check(rpcSchemas['browser.cookies.cancel'].input, { sessionId: 's', importId: 'i', domains: [] })).toBe(false)
    expect(Value.Check(rpcSchemas['browser.cookies.cancel'].input, { sessionId: 's' })).toBe(false)
    expect(Value.Check(rpcSchemas['browser.cookies.cancel'].output, {})).toBe(true)
  })
  it('uses scoped ephemeral actions with no durable command or host lease', () => {
    for (const method of ['browser.tabs.open', 'browser.tabs.close', 'browser.tabs.navigate', 'browser.tabs.input'] as const) {
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
    for (const [width, height] of [[360, 225], [1, 1]]) expect(Value.Check(BrowserScreencastItemSchema, { ...frame, width, height })).toBe(true)
    for (const [width, height] of [[0, 1], [1, -1], [1.5, 1], [3841, 1]]) expect(Value.Check(BrowserScreencastItemSchema, { ...frame, width, height })).toBe(false)
    expect(Value.Check(rpcSchemas['browser.tabs.resize'].input, { sessionId: 's', tabId: 't', viewport: { width: 360, height: 225 } })).toBe(false)
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
  it('adds optional activity, setup and diagnostics without breaking earlier snapshots', () => {
    expect(Value.Check(rpcSchemas['browser.engine.status'].input, {})).toBe(true)
    expect(Value.Check(rpcSchemas['browser.engine.status'].output, { state: 'ready', version: '154.0.8037.92' })).toBe(true)
    expect(rpcScopes['browser.engine.status']).toBe('session:read')
    expect(Value.Check(rpcSchemas['browser.engine.setup'].input, {})).toBe(true)
    expect(rpcScopes['browser.engine.setup']).toBe('session:operate')
    expect(Value.Check(BrowserEngineSnapshotSchema, { sessionId: 's', projectId: 'p', tabs: [], activeTabId: null, revision: 0, browserEngineState: 'failed', browserEngineMessage: 'Install libnss3 and libgbm1.' })).toBe(true)
  })
  it('shares simple session tabs across local and remote hosts', () => {
    const snapshot = { sessionId: 's', projectId: 'p', tabs: [], activeTabId: null, revision: 0 }
    expect(Value.Check(BrowserEngineSnapshotSchema, snapshot)).toBe(true)
    expect(rpcScopes['browser.tabs.subscribe']).toBe('session:read')
    expect(rpcScopes['browser.screencast.subscribe']).toBe('session:read')
    expect(rpcScopes['browser.cookies.preview']).toBe('settings:admin')
  })
})
