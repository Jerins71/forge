// Failure cases: a remote grant impersonates Desktop; report/resize creates an
// effect; retry/restart duplicates open/record; foreign tabs/reveal pass; bootstrap
// differs from live state. All files use a disposable temp root.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import type { BrowserAutomationRequest, BrowserHostRegistration, BrowserTabSnapshot } from '@forge/protocol';
import { BrowserAutomationService } from '../../swarm/browser-automation/browser-automation-service.js';
import { createBrowserHostRpc } from './browser-host-rpc.js';
import { createBrowserWorkspaceRpc } from './browser-workspace-rpc.js';
import { principal, session, streamFixture, socketFixture } from './__tests__/fixtures.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const local = { ...principal, localBrowserHost: true };
const registration: BrowserHostRegistration = { hostId: 'desktop', clientInstanceId: 'renderer', registeredAt: '2026-10-09T00:00:00.000Z', capabilities: { protocolVersions: { minimum: 2, maximum: 2 }, supportedOperations: ['open','resize','recordingStart','recordingStop'], maxResponseBytes: 8388608, features: { resize: true, recording: true, capturePage: true, downloadEvents: false, downloadArtifacts: false, downloadOpen: false, managedOpenRouting: true } } };
function tab(request: BrowserAutomationRequest): BrowserTabSnapshot { return { targetAffinity: 'managed-electron', tabId: 'tab-1', sessionAgentId: request.sessionAgentId, profileId: request.profileId, url: 'about:blank', title: '', lifecycle: 'ready', loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'none', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null, error: null, createdAt: registration.registeredAt, updatedAt: registration.registeredAt }; }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'forge-v2-browser-')); closes.push(() => rm(root, { recursive: true, force: true }));
  const core = await streamFixture(); closes.push(core.close);
  core.sink.transaction(tx => { core.sink.append(tx, { topic: 'shell', sessionId: null, event: { type: 'project.upsert', project: { projectId: 'project', title: 'Project', cwd: root, repository: null, isGit: false, defaultBranch: null, updatedAt: registration.registeredAt, sortKey: 'project', archived: false } } }); core.sink.append(tx, { topic: 'shell', sessionId: 'session', event: { type: 'session.upsert', session: session() } }); });
  const service = new BrowserAutomationService({ dataDir: root });
  const host = createBrowserHostRpc({ service, hydrateSessions: async () => [await service.getHostHydrationSnapshot('project','session')], resolveSession: id => id === 'session' ? 'project' : undefined });
  const browser = createBrowserWorkspaceRpc({ service, host, control: core.core.controlService, resolveSession: id => id === 'session' ? 'project' : undefined });
  const abort = new AbortController(); closes.push(async () => { abort.abort(); await iterator.return(undefined); });
  const iterator = host.attach(local, abort.signal)[Symbol.asyncIterator](); await iterator.next();
  const connected = await host.execute(local, 'browser.host.register', { registration });
  return { root, core, service, host, browser, iterator, connected };
}
it('denies remote authority and read-only devices before registration or control admission', async () => {
  const f = await fixture();
  await expect(f.host.execute(principal, 'browser.host.register', { registration })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(f.browser.execute(principal, 'browser.tab.open', { commandId: randomUUID(), sessionId: 'session' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(f.browser.execute({ ...local, scopes: new Set(['session:read']) }, 'browser.tab.open', { commandId: randomUUID(), sessionId: 'session' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(f.core.database.prepare('SELECT COUNT(*) count FROM commands').get()).toEqual({ count: 0 });
});
it('dispatches open once for a lost result, preserves canonical bootstrap across service restart, and never retries an ambiguous operation', async () => {
  const f = await fixture(); const input = { commandId: randomUUID(), sessionId: 'session' };
  const opening = f.browser.execute(local, 'browser.tab.open', input);
  const { value } = await f.iterator.next(); expect(value).toMatchObject({ kind: 'automation', request: { operation: 'open', requiredTargetAffinity: 'managed-electron' } });
  const request = (value as { request: BrowserAutomationRequest }).request;
  const opened = tab(request);
  f.service.acceptHostResponse(f.host.connectionId(local)!, { ...request, input: undefined, deadlineAt: undefined, artifactDirectory: undefined, requiredTargetAffinity: undefined, ok: true, elapsedMs: 1, updatedTab: opened, result: { tab: opened, created: true, panelRevealRequested: false } });
  expect(await opening).toMatchObject({ state: 'succeeded' });
  expect(await f.browser.execute(local, 'browser.tab.open', input)).toMatchObject({ state: 'succeeded' });
  const snapshot = await f.service.getSessionSnapshot('project','session'); expect(snapshot.tabs).toHaveLength(1);
  const restarted = new BrowserAutomationService({ dataDir: f.root });
  expect((await restarted.getSessionSnapshot('project','session')).tabs.map(t => t.tabId)).toEqual(['tab-1']);
  await expect(f.browser.execute(local, 'browser.tab.open', { ...input, sessionId: 'foreign' })).rejects.toMatchObject({ code: 'CONFLICT' });
  const ambiguousInput = { commandId: randomUUID(), sessionId: 'session' };
  const ambiguous = f.browser.execute(local, 'browser.tab.open', ambiguousInput);
  const next = await f.iterator.next(); expect(next.value).toMatchObject({ kind: 'automation' });
  f.service.unregisterHost(f.host.connectionId(local)!);
  expect(await ambiguous).toMatchObject({ state: 'interrupted', delivery: 'unknown' });
  expect(await f.browser.execute(local, 'browser.tab.open', ambiguousInput)).toMatchObject({ state: 'interrupted', delivery: 'unknown' });
  expect(f.core.database.prepare('SELECT COUNT(*) count FROM commands').get()).toEqual({ count: 2 });
});
it('enforces local host authority through the authenticated RPC socket', async () => {
  const f = await fixture(); const sockets = await socketFixture({ browserHost: f.host, browser: f.browser }); closes.push(sockets.close);
  const remote = await sockets.connect(principal); remote.send({ type: 'request', requestId: 'attach', method: 'browser.host.attach', input: {} });
  expect(await remote.next(frame => 'requestId' in frame && frame.requestId === 'attach')).toMatchObject({ type: 'error', error: { code: 'FORBIDDEN' } });
  remote.send({ type: 'request', requestId: 'open', method: 'browser.tab.open', input: { sessionId: 'session', commandId: randomUUID() } });
  expect(await remote.next(frame => 'requestId' in frame && frame.requestId === 'open')).toMatchObject({ type: 'error', error: { code: 'FORBIDDEN' } });
});
it('rejects old browser frames through the authenticated RPC socket', async () => {
  const f = await fixture(); const sockets = await socketFixture({ browserHost: f.host, browser: f.browser }); closes.push(sockets.close);
  const remote = await sockets.connect(local);
  for (const type of ['browser_host_register','browser_host_hydrate','browser_host_focus','browser_host_response','browser_host_state_report','browser_host_lifecycle_response','browser_panel_reveal_acknowledge','browser_tab_open','browser_tab_activate','browser_tab_close','browser_tab_resize','browser_recording_start','browser_recording_stop']) {
    remote.send({ type: 'request', requestId: type, method: 'legacy.session.operate', input: { command: { type } } });
    expect(await remote.next(frame => 'requestId' in frame && frame.requestId === type)).toMatchObject({ type: 'error', error: { code: 'INVALID_INPUT' } });
  }
});
