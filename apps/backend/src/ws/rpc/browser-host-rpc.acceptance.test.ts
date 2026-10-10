// Failure cases: malformed/multi-part response; another device confuses the
// connection identity; stale generation; unsubscribe/drop leaves registered host.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserAutomationRequest, BrowserHostRegistration, BrowserTabSnapshot } from '@forge/protocol';
import type { BrowserHostMessageV2, Method, RpcInput, RpcServerFrame } from '@forge/protocol/environment-v2';
import { BrowserAutomationService } from '../../swarm/browser-automation/browser-automation-service.js';
import { createBrowserHostRpc } from './browser-host-rpc.js';
import { principal, socketFixture } from './__tests__/fixtures.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const local = { ...principal, localBrowserHost: true };
const registration: BrowserHostRegistration = { hostId: 'forge-browser-desktop', clientInstanceId: 'renderer', registeredAt: '2026-10-09T00:00:00.000Z', capabilities: { protocolVersions: { minimum: 2, maximum: 2 }, supportedOperations: ['status','open','snapshot'], maxResponseBytes: 8388608, features: { resize: true, recording: true, capturePage: true, downloadEvents: false, downloadArtifacts: false, downloadOpen: false, managedOpenRouting: true } } };
function tab(request: BrowserAutomationRequest): BrowserTabSnapshot { return { targetAffinity: 'managed-electron', tabId: 'logical-1', sessionAgentId: request.sessionAgentId, profileId: request.profileId, url: 'about:blank', title: '', lifecycle: 'ready', loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'none', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null, error: null, createdAt: registration.registeredAt, updatedAt: registration.registeredAt }; }
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'forge-browser-host-rpc-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const service = new BrowserAutomationService({ dataDir: root });
  const browserHost = createBrowserHostRpc({ service, resolveSession: id => id === 'manager-1' ? 'profile-1' : undefined, hydrateSessions: async () => [await service.getHostHydrationSnapshot('profile-1','manager-1')] });
  const f = await socketFixture({ browserHost }); cleanups.push(f.close); return { service, f };
}
type Client = Awaited<ReturnType<Awaited<ReturnType<typeof socketFixture>>['connect']>>;
let requests = 0;
async function call<M extends Method>(client: Client, method: M, input: RpcInput<M>): Promise<RpcServerFrame> { const requestId = `r${++requests}`; client.send({ type: 'request', requestId, method, input }); return client.next(frame => 'requestId' in frame && frame.requestId === requestId); }
async function attach(client: Client) { const result = await call(client,'browser.host.attach',{}) as { output: { subscriptionId: string } }; expect(await client.next(frame => frame.type === 'stream')).toMatchObject({ item: { kind: 'attached' } }); return result.output.subscriptionId; }
async function message(client: Client, value: BrowserHostMessageV2, partChars = 262144) { const data = JSON.stringify(value); const transferId = randomUUID(); const count = Math.ceil(data.length / partChars); let result; for (let index = 0; index < count; index++) result = await call(client,'browser.host.send',{ transferId, index, count, data: data.slice(index * partChars, (index + 1) * partChars) }); return result; }
it('registers, hydrates, and reassembles a bounded typed response on the attached socket', async () => {
  const { f, service } = await harness(); const host = await f.connect(local);
  expect(await call(host,'browser.host.register',{ registration })).toMatchObject({ type: 'error', error: { code: 'UNAVAILABLE' } }); await attach(host);
  expect(await call(host,'browser.host.register',{ registration })).toMatchObject({ type: 'result', output: { hostGeneration: 1 } });
  await call(host,'browser.host.hydrate',{ requestId: 'hydrate', hostId: registration.hostId, hostGeneration: 1 });
  const hydration = await host.next(frame => frame.type === 'stream' && (frame.item as { kind: string }).kind === 'hydration') as { item: { payloadBase64: string } };
  expect(JSON.parse(Buffer.from(hydration.item.payloadBase64,'base64').toString())[0]).toMatchObject({ schemaVersion: 2, sessionAgentId: 'manager-1' });
  const opening = service.invoke('manager-1','profile-1','open',{ show: false, reuseExistingTab: false },{ requiredTargetAffinity: 'managed-electron' });
  const stream = await host.next(frame => frame.type === 'stream' && (frame.item as { kind: string }).kind === 'automation') as { item: { request: BrowserAutomationRequest } }; const request = stream.item.request; const opened = tab(request);
  expect(await call(host,'browser.host.send',{ transferId: randomUUID(), index: 1, count: 3, data: 'x' })).toMatchObject({ type: 'error', error: { code: 'INVALID_INPUT' } });
  expect(await message(host,{ kind: 'respond', response: { requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, tabId: null, hostId: request.hostId, hostGeneration: request.hostGeneration, operation: 'open', ok: true, elapsedMs: 1, updatedTab: opened, result: { tab: opened, created: true, panelRevealRequested: false } } },100)).toMatchObject({ type: 'result' });
  expect(await opening).toMatchObject({ ok: true }); expect((await service.getSessionSnapshot('profile-1','manager-1')).activeTabId).toBe('logical-1');
  const remote = await f.connect(principal);
  expect(await call(remote,'browser.host.focus',{ hostId: registration.hostId, hostGeneration: 1, focused: true })).toMatchObject({ type: 'error', error: { code: 'FORBIDDEN' } });
  const otherLocal = await f.connect(local);
  expect(await call(otherLocal,'browser.host.focus',{ hostId: registration.hostId, hostGeneration: 1, focused: true })).toMatchObject({ type: 'error', error: { code: 'UNAVAILABLE' } });
});
it('unregisters on unsubscribe/drop and negotiates a new generation', async () => {
  const { f, service } = await harness(); const host = await f.connect(local); const subscriptionId = await attach(host);
  await call(host,'browser.host.register',{ registration }); host.send({ type: 'unsubscribe', subscriptionId }); await vi.waitFor(() => expect(service.broker.getConnectionSnapshot().connected).toBe(false));
  await attach(host); expect(await call(host,'browser.host.register',{ registration })).toMatchObject({ output: { hostGeneration: 2 } });
  expect(await call(host,'browser.host.focus',{ hostId: registration.hostId, hostGeneration: 1, focused: true })).toMatchObject({ type: 'error', error: { code: 'CONFLICT' } });
  host.socket.terminate(); await vi.waitFor(() => expect(service.broker.getConnectionSnapshot().connected).toBe(false));
});
