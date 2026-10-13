/** One environment-local Playwright engine. Tabs and profile data stay on their
 * owning machine; no lease, journal or durable command semantics. */
import { Type, type Static, type TSchema } from '@sinclair/typebox'
const O = <P extends Record<string, TSchema>>(p: P) => Type.Object(p, { additionalProperties: false })
const E = <T extends string>(...v: T[]) => Type.Union(v.map(x => Type.Literal(x)))
const id = Type.String({ minLength: 1, maxLength: 128 })
const url = Type.String({ minLength: 1, maxLength: 8192 })
const dimension = Type.Integer({ minimum: 240, maximum: 3840 })
const sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const domain = Type.String({ minLength: 1, maxLength: 253 })
const domains = Type.Array(domain, { minItems: 1, maxItems: 1000, uniqueItems: true })
export const BrowserEngineViewportSchema = O({ width: dimension, height: dimension })
export const BrowserEngineTabSchema = O({
  tabId: id, sessionId: id, projectId: id, host: E('desktop', 'headless'),
  url: Type.String({ maxLength: 8192 }), title: Type.String({ maxLength: 4096 }),
  loading: Type.Boolean(), canGoBack: Type.Boolean(), canGoForward: Type.Boolean(),
  viewport: BrowserEngineViewportSchema, controller: E('human', 'agent', 'none'),
  agentAction: Type.Optional(Type.String({ maxLength: 256 })),
  agentCursor: Type.Optional(O({ x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }), phase: E('move', 'click'), sequence })),
  faviconUrl: Type.Optional(Type.String({ maxLength: 8192 })),
  errorCode: Type.Optional(E('crashed', 'navigation_failed', 'unreachable', 'execution_failed')),
  recordingId: Type.Optional(id), error: Type.Optional(Type.String({ maxLength: 1024 })),
})
export type BrowserEngineTab = Static<typeof BrowserEngineTabSchema>
export const BrowserEngineSnapshotSchema = O({ sessionId: id, projectId: id,
  tabs: Type.Array(BrowserEngineTabSchema, { maxItems: 100 }),
  activeTabId: Type.Union([id, Type.Null()]), revision: sequence,
  browserEngineState: Type.Optional(E('ready', 'missing', 'installing', 'failed')),
  browserEngineMessage: Type.Optional(Type.String({ maxLength: 1024 })) })
export const BrowserEngineSetupSchema = O({ browserEngineState: E('ready', 'missing', 'installing', 'failed'), browserEngineMessage: Type.Optional(Type.String({ maxLength: 1024 })) })
export type BrowserEngineSnapshot = Static<typeof BrowserEngineSnapshotSchema>
export const BrowserEngineStreamSchema = O({ kind: Type.Literal('snapshot'), snapshot: BrowserEngineSnapshotSchema })
export const BrowserEngineInputSchema = Type.Union([
  O({ kind: Type.Literal('mouse'), type: E('mousePressed', 'mouseReleased', 'mouseMoved'),
    x: Type.Number({ minimum: 0, maximum: 3840 }), y: Type.Number({ minimum: 0, maximum: 3840 }),
    button: Type.Optional(E('none', 'left', 'middle', 'right')), buttons: Type.Optional(Type.Integer({ minimum: 0, maximum: 7 })),
    clickCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })), modifiers: Type.Optional(Type.Integer({ minimum: 0, maximum: 15 })) }),
  O({ kind: Type.Literal('wheel'), x: Type.Number({ minimum: 0, maximum: 3840 }), y: Type.Number({ minimum: 0, maximum: 3840 }), deltaX: Type.Number({ minimum: -100000, maximum: 100000 }), deltaY: Type.Number({ minimum: -100000, maximum: 100000 }), modifiers: Type.Optional(Type.Integer({ minimum: 0, maximum: 15 })) }),
  O({ kind: Type.Literal('key'), type: E('keyDown', 'keyUp'), key: Type.String({ maxLength: 128 }),
    code: Type.Optional(Type.String({ maxLength: 128 })), windowsVirtualKeyCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
    modifiers: Type.Optional(Type.Integer({ minimum: 0, maximum: 15 })), text: Type.Optional(Type.String({ maxLength: 16 })) }),
  O({ kind: Type.Literal('text'), text: Type.String({ maxLength: 16384 }) }),
])
export type BrowserEngineInput = Static<typeof BrowserEngineInputSchema>
/** At most one unacknowledged frame per subscription. Frames are transient,
 * never replayed or written to history. JPEG base64 fits the 1 MiB RPC envelope. */
export const BrowserScreencastItemSchema = Type.Union([
  O({ kind: Type.Literal('frame'), tabId: id, frameId: sequence,
    data: Type.String({ maxLength: 800000 }), mimeType: Type.Literal('image/jpeg'),
    width: dimension, height: dimension, timestamp: Type.Number({ minimum: 0 }) }),
  O({ kind: Type.Literal('state'), tabId: id, state: E('starting', 'ready', 'closed', 'error'), message: Type.Optional(Type.String({ maxLength: 1024 })) }),
])
export type BrowserScreencastItem = Static<typeof BrowserScreencastItemSchema>
export const BrowserCookieSourceSchema = E('chrome-running', 'chrome-database')
export type BrowserCookieSource = Static<typeof BrowserCookieSourceSchema>
export const BrowserCookieErrorSchema = O({ code: E('chrome-not-running', 'chrome-consent-required', 'chrome-disconnected', 'files-folders-denied', 'keychain-denied', 'secret-service-unavailable', 'unsupported-platform', 'import-expired', 'source-unavailable'), message: Type.String({ maxLength: 1024 }), settingsUrl: Type.Optional(url) })
export type BrowserCookieError = Static<typeof BrowserCookieErrorSchema>
export const BrowserCookiePreviewSchema = Type.Union([
  O({ ok: Type.Literal(true), importId: id, source: BrowserCookieSourceSchema,
    domains: Type.Array(O({ domain, count: Type.Integer({ minimum: 1, maximum: 100000 }), lastUsedAt: Type.Optional(Type.String({ maxLength: 32 })) }), { maxItems: 10000 }),
    expiresAt: Type.String({ maxLength: 32 }) }),
  O({ ok: Type.Literal(false), error: BrowserCookieErrorSchema }),
])
export type BrowserCookiePreview = Static<typeof BrowserCookiePreviewSchema>
export const BrowserCookieAuditSchema = O({ domains: Type.Array(O({ domain, importedAt: Type.String({ maxLength: 32 }), count: Type.Integer({ minimum: 0, maximum: 100000 }) }), { maxItems: 10000 }), skipped: Type.Optional(Type.Array(O({ domain, reason: E('expired', 'unsupported', 'conflict', 'failed'), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })) }), { maxItems: 1000 })) })
export const BrowserEngineStatusSchema = O({ state: E('ready', 'missing', 'installing', 'failed'), message: Type.Optional(Type.String({ maxLength: 1024 })), version: Type.Optional(Type.String({ maxLength: 128 })) })
/** Explicit one-time transfer only. Clients must keep this value in memory,
 * never in persisted caches, logs, artifacts or conversations. */
export const BrowserCookieTransferSchema = O({ transferId: id, expiresAt: Type.String({ maxLength: 32 }), domains,
  cookies: Type.Array(O({ name: Type.String({ maxLength: 4096 }), value: Type.String({ maxLength: 16384 }),
    domain, path: Type.String({ maxLength: 4096 }), expires: Type.Number(), httpOnly: Type.Boolean(), secure: Type.Boolean(),
    sameSite: E('Strict', 'Lax', 'None') }), { maxItems: 2000 }) })
export type BrowserCookieTransfer = Static<typeof BrowserCookieTransferSchema>
export const browserEngineSchemas = {
  session: O({ sessionId: id }), tab: O({ sessionId: id, tabId: id }),
  open: O({ sessionId: id, url: Type.Optional(url), activate: Type.Optional(Type.Boolean()) }),
  navigate: Type.Union([O({ sessionId: id, tabId: id, url }), O({ sessionId: id, tabId: id, direction: E('back', 'forward', 'reload') })]),
  resize: O({ sessionId: id, tabId: id, viewport: BrowserEngineViewportSchema }),
  input: O({ sessionId: id, tabId: id, input: BrowserEngineInputSchema }),
  screencast: O({ sessionId: id, tabId: id, maxWidth: Type.Optional(dimension), maxHeight: Type.Optional(dimension), quality: Type.Optional(Type.Integer({ minimum: 20, maximum: 85 })) }),
  ack: O({ subscriptionId: id, frameId: sequence }),
  preview: O({ sessionId: id, source: BrowserCookieSourceSchema }),
  apply: O({ sessionId: id, importId: id, domains }),
  prepareSend: O({ sessionId: id, importId: id, domains }),
  receive: O({ sessionId: id, transfer: BrowserCookieTransferSchema }),
  forget: O({ sessionId: id, domain }),
} as const

/** Trusted Desktop renderer presentation only. It never drives the page or
 * exposes CDP. Remote tabs use the authenticated environment screencast. */
export interface BrowserEngineDesktopBridge {
  present(input: { tabId: string; bounds: { x: number; y: number; width: number; height: number } }): Promise<void>
  hide(): Promise<void>
}
/** The Electron parent creates tabs and relays CDP on its existing private fork
 * channel. These messages never enter environment RPC or renderer state. */
export type DesktopBrowserCommand =
  | { type: 'forge:browser:cookies.read'; requestId: string }
  | { type: 'forge:browser:create'; requestId: string; tabId: string; projectId: string; viewport: { width: number; height: number } }
  | { type: 'forge:browser:close'; tabId: string }
  | { type: 'forge:browser:cdp'; tabId: string; message: string }
  | { type: 'forge:browser:resize'; tabId: string; viewport: { width: number; height: number } }
export type DesktopBrowserEvent =
  | { type: 'forge:browser:cookies.result'; requestId: string; cookies?: Array<BrowserCookieTransfer['cookies'][number] & { lastUsedAt?: string }>; error?: BrowserCookieError }
  | { type: 'forge:browser:created'; requestId: string; tabId: string }
  | { type: 'forge:browser:closed'; tabId: string }
  | { type: 'forge:browser:cdp'; tabId: string; message: string }
  | { type: 'forge:browser:input'; tabId: string }
  | { type: 'forge:browser:error'; requestId: string; message: string }
