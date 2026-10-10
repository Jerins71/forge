import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { BROWSER_HOST_PROTOCOL_VERSION, isBrowserHostProtocolCompatible, type BrowserSessionSnapshot, type BrowserHostConnectionSnapshot } from '@forge/protocol';
import { BrowserHostMessageV2Schema, rpcSchemas, rpcScopes, type RpcInput, type RpcOutput, type RpcStreamItem, type BrowserHostMessageV2 } from '@forge/protocol/environment-v2';
import type { Principal } from '../../environment/control/control-types.js';
import type { BrowserAutomationService } from '../../swarm/browser-automation/browser-automation-service.js';
import { StreamFault, StreamQueue } from '../../environment/streams/stream-budget.js';
export type BrowserHostMethod = 'browser.host.register' | 'browser.host.hydrate' | 'browser.host.focus' | 'browser.host.reveal';
type Item = RpcStreamItem<'browser.host.attach'>;
const MAX_TRANSFERS = 8;
const MAX_BUFFERED_CHARS = 32 * 1024 * 1024;
interface Attachment { connectionId: string; queue: StreamQueue<Item>; transfers: Map<string, { count: number; parts: string[]; expiresAt: number }>; bufferedChars: number }
export interface BrowserHostRpc {
  attach(principal: Principal, signal: AbortSignal): AsyncIterable<Item>;
  execute<M extends BrowserHostMethod>(principal: Principal, method: M, input: RpcInput<M>): Promise<RpcOutput<M>>;
  send(principal: Principal, input: RpcInput<'browser.host.send'>): Promise<RpcOutput<'browser.host.send'>>;
  connectionId(principal: Principal): string | undefined;
  requireCurrent(principal: Principal): string;
  publishSession(snapshot: BrowserSessionSnapshot): void;
  publishHost(host: BrowserHostConnectionSnapshot): void;
}
/** A platform capability is checked at ticket issuance, in addition to the
 * environment grant. Object identity binds the host to its own live socket. */
export function createBrowserHostRpc(deps: { service: BrowserAutomationService; hydrateSessions(): Promise<BrowserSessionSnapshot[]>; resolveSession(sessionId: string): string | undefined }): BrowserHostRpc {
  const attachments = new Map<Principal, Attachment>();
  function authorize(principal: Principal) {
    if (!principal.localBrowserHost || !principal.scopes.has('session:operate')) throw new StreamFault('FORBIDDEN', 'Local Desktop browser capability and session scope are required');
  }
  function attachment(principal: Principal): Attachment {
    authorize(principal);
    const result = attachments.get(principal);
    if (!result) throw new StreamFault('UNAVAILABLE', 'Browser host is not attached on this connection');
    return result;
  }
  function requireCurrent(principal: Principal): string {
    const current = attachment(principal);
    const host = deps.service.broker.getConnectionSnapshot();
    if (!host.hostId || host.hostGeneration === null || !deps.service.broker.isCurrentConnection(current.connectionId, host.hostId, host.hostGeneration)) throw new StreamFault('UNAVAILABLE', 'Browser host generation is unavailable');
    return current.connectionId;
  }
  async function* attach(principal: Principal, signal: AbortSignal): AsyncGenerator<Item> {
    authorize(principal);
    if (attachments.has(principal)) throw new StreamFault('CONFLICT', 'A browser host is already attached');
    const current: Attachment = { connectionId: randomUUID(), queue: new StreamQueue<Item>(), transfers: new Map(), bufferedChars: 0 };
    const end = () => current.queue.end(); signal.addEventListener('abort', end, { once: true }); attachments.set(principal, current);
    try { if (signal.aborted) return; current.queue.push({ kind: 'attached' }); yield* current.queue; }
    finally { signal.removeEventListener('abort', end); if (attachments.get(principal) === current) attachments.delete(principal); deps.service.unregisterHost(current.connectionId); }
  }
  async function execute<M extends BrowserHostMethod>(principal: Principal, method: M, input: RpcInput<M>): Promise<RpcOutput<M>> {
    if (!principal.scopes.has(rpcScopes[method])) throw new StreamFault('FORBIDDEN', 'Missing browser scope');
    if (!Value.Check(rpcSchemas[method].input, input)) throw new StreamFault('INVALID_INPUT', 'Invalid browser host input');
    const current = attachment(principal);
    let result: unknown;
    switch (method) {
      case 'browser.host.register': {
        const { registration } = input as RpcInput<'browser.host.register'>;
        if (!isBrowserHostProtocolCompatible(registration.capabilities.protocolVersions)) throw new StreamFault('PROTOCOL_MISMATCH', `Automatic Browser Host requires protocol v${BROWSER_HOST_PROTOCOL_VERSION}`);
        result = await deps.service.registerHostWithLifecycleRelease({ connectionId: current.connectionId, registration,
          sendRequest: request => { if (signalEnded(principal, current)) throw new Error('Browser host disconnected'); current.queue.push({ kind: 'automation', request }); },
          sendLifecycleRequest: request => { if (signalEnded(principal, current)) throw new Error('Browser host disconnected'); current.queue.push({ kind: 'lifecycle', request }); },
          hydrateSessionsForReplacement: deps.hydrateSessions });
        if (signalEnded(principal, current)) { deps.service.unregisterHost(current.connectionId); throw new StreamFault('UNAVAILABLE', 'Browser host disconnected during registration'); }
        break;
      }
      case 'browser.host.hydrate': {
        const hydration = input as RpcInput<'browser.host.hydrate'>; assertLease(current, hydration);
        const snapshots = await deps.hydrateSessions(); assertLease(current, hydration);
        if (snapshots.length > 500) throw new StreamFault('PAYLOAD_TOO_LARGE', 'Browser hydration exceeds its budget');
        await sendChunks(current, { kind: 'hydration', ...hydration }, snapshots);
        result = {}; break;
      }
      case 'browser.host.focus': { const focus = input as RpcInput<'browser.host.focus'>; assertLease(current, focus); deps.service.setHostFocused(current.connectionId, focus.hostId, focus.hostGeneration, focus.focused); result = {}; break; }
      case 'browser.host.reveal': {
        const reveal = input as RpcInput<'browser.host.reveal'>; assertLease(current, reveal);
        const profileId = deps.resolveSession(reveal.sessionId); if (!profileId) throw new StreamFault('NOT_FOUND', 'Local Builder session is unavailable');
        result = await deps.service.acknowledgePanelReveal(profileId, reveal.sessionId, reveal.tabId, reveal.sequence); break;
      }
    }
    return result as RpcOutput<M>;
  }
  const signalEnded = (principal: Principal, current: Attachment) => attachments.get(principal) !== current;
  function assertLease(current: Attachment, lease: { hostId: string; hostGeneration: number }) {
    if (!deps.service.broker.isCurrentConnection(current.connectionId, lease.hostId, lease.hostGeneration)) throw new StreamFault('CONFLICT', 'Stale browser host generation');
  }
  async function sendChunks(current: Attachment, header: { kind: 'hydration' | 'report.result'; requestId: string; hostId: string; hostGeneration: number }, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value)); const chunkBytes = 256 * 1024;
    if (bytes.length > 32 * 1024 * 1024) throw new StreamFault('PAYLOAD_TOO_LARGE', 'Browser host read exceeds its budget');
    const chunkCount = Math.max(1, Math.ceil(bytes.length / chunkBytes));
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      if (header.kind === 'hydration') assertLease(current, header);
      current.queue.push({ ...header, chunkIndex, chunkCount, payloadBase64: bytes.subarray(chunkIndex * chunkBytes, (chunkIndex + 1) * chunkBytes).toString('base64') });
      // Drain the existing stream pump between bounded read chunks.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  async function handleMessage(current: Attachment, message: BrowserHostMessageV2) {
    switch (message.kind) {
      case 'respond': deps.service.acceptHostResponse(current.connectionId, message.response); return;
      case 'lifecycle.respond': deps.service.acceptHostLifecycleResponse(current.connectionId, message.response); return;
      case 'report': {
        // Membership is environment addressed; a host cannot invent remote or Collaboration sessions.
        for (const session of message.sessions) if (deps.resolveSession(session.sessionAgentId) !== session.profileId) throw new StreamFault('FORBIDDEN', 'Host report targets an unavailable local session');
        const result = await deps.service.reportHostState(current.connectionId, message.hostId, message.hostGeneration, message.sessions);
        await sendChunks(current, { kind: 'report.result', requestId: message.requestId, hostId: message.hostId, hostGeneration: message.hostGeneration }, result);
      }
    }
  }
  async function send(principal: Principal, input: RpcInput<'browser.host.send'>): Promise<RpcOutput<'browser.host.send'>> {
    const current = attachment(principal);
    const drop = (id: string) => { for (const part of current.transfers.get(id)?.parts ?? []) current.bufferedChars -= part.length; current.transfers.delete(id); };
    for (const [id, transfer] of current.transfers) if (transfer.expiresAt <= Date.now()) drop(id);
    let transfer = current.transfers.get(input.transferId);
    if (!transfer && input.index === 0 && current.transfers.size < MAX_TRANSFERS) current.transfers.set(input.transferId, transfer = { count: input.count, parts: [], expiresAt: Date.now() + 15000 });
    if (!transfer || transfer.count !== input.count || transfer.parts.length !== input.index || current.bufferedChars + input.data.length > MAX_BUFFERED_CHARS) { drop(input.transferId); throw new StreamFault('INVALID_INPUT', 'Invalid browser host transfer'); }
    transfer.parts.push(input.data); current.bufferedChars += input.data.length;
    if (transfer.parts.length < transfer.count) return {};
    const text = transfer.parts.join(''); drop(input.transferId);
    let message: unknown; try { message = JSON.parse(text); } catch { throw new StreamFault('INVALID_INPUT', 'Invalid browser host JSON'); }
    if (!Value.Check(BrowserHostMessageV2Schema, message)) throw new StreamFault('INVALID_INPUT', 'Invalid browser host message');
    await handleMessage(current, message); return {};
  }
  return { attach, execute, send, requireCurrent, connectionId: principal => attachments.get(principal)?.connectionId,
    publishSession: snapshot => { for (const current of attachments.values()) current.queue.push({ kind: 'session', snapshot }); },
    publishHost: host => { for (const current of attachments.values()) current.queue.push({ kind: 'host', host }); } };
}
