import { Value } from '@sinclair/typebox/value';
import { rpcSchemas, rpcScopes, type RpcInput, type RpcOutput, type RpcStreamItem, type CommandReceipt } from '@forge/protocol/environment-v2';
import type { BrowserSessionSnapshot, BrowserViewportSetting } from '@forge/protocol';
import type { BrowserAutomationService } from '../../swarm/browser-automation/browser-automation-service.js';
import type { ControlService, Principal } from '../../environment/control/control-types.js';
import { StreamFault, StreamQueue } from '../../environment/streams/stream-budget.js';
import type { BrowserHostRpc } from './browser-host-rpc.js';
export type BrowserWorkspaceMethod = 'browser.get' | 'browser.tab.open' | 'browser.tab.activate' | 'browser.tab.close' | 'browser.tab.resize' | 'browser.recording.start' | 'browser.recording.stop';
export function createBrowserWorkspaceRpc(deps: { service: BrowserAutomationService; host: BrowserHostRpc; control: ControlService; resolveSession(sessionId: string): string | undefined }) {
  type Item = RpcStreamItem<'browser.subscribe'>;
  const watchers = new Map<string, Set<StreamQueue<Item>>>();
  const profile = (sessionId: string) => { const id = deps.resolveSession(sessionId); if (!id) throw new StreamFault('NOT_FOUND', 'Local Builder manager session is unavailable'); return id; };
  const authorize = (principal: Principal, scope: 'session:read' | 'session:operate') => { if (!principal.scopes.has(scope)) throw new StreamFault('FORBIDDEN', 'Missing browser scope'); };
  async function execute<M extends BrowserWorkspaceMethod>(principal: Principal, method: M, raw: RpcInput<M>): Promise<RpcOutput<M>> {
    authorize(principal, rpcScopes[method]);
    if (!Value.Check(rpcSchemas[method].input, raw)) throw new StreamFault('INVALID_INPUT', 'Invalid browser input');
    const input = raw as RpcInput<'browser.tab.open'> & Partial<RpcInput<'browser.tab.resize'> & RpcInput<'browser.recording.stop'>>;
    if (method === 'browser.get') return await deps.service.getSessionSnapshot(profile(input.sessionId), input.sessionId) as RpcOutput<M>;
    // Deny a viewer's remote grant before even looking up receipts. The grant
    // never gives another socket the registered physical host's authority.
    if (!principal.localBrowserHost) throw new StreamFault('FORBIDDEN', 'Local Desktop browser capability is required');
    if (method === 'browser.tab.resize') {
      const profileId = profile(input.sessionId); deps.host.requireCurrent(principal); await requireManagedTab(profileId, input.sessionId, input.tabId!);
      const viewport = input.viewport!;
      validateViewport(viewport);
      const outcome = await deps.service.invoke(input.sessionId, profileId, 'resize', viewportInput(viewport, input.tabId!));
      if (!outcome.ok) throw new StreamFault('CONFLICT', `${outcome.error.code}: ${outcome.error.message}; delivery may be unknown. Inspect the tab before retrying.`);
      return await deps.service.getSessionSnapshot(profileId, input.sessionId) as RpcOutput<M>;
    }
    if (!deps.control.admitLifecycle) throw new StreamFault('UNAVAILABLE', 'Browser control is not composed');
    const receiptMethod = method as CommandReceipt['method'];
    await deps.control.admitLifecycle(principal, { commandId: input.commandId, command: method, request: raw, sessionIds: [input.sessionId], intent: 'inspect', requiredScope: rpcScopes[method], receipt: { method: receiptMethod, sessionId: input.sessionId }, receiptReplay: true, ambiguousDelivery: true,
      preflight: () => { profile(input.sessionId); deps.host.requireCurrent(principal); if (method === 'browser.tab.open' && deps.service.broker.getConnectionSnapshot().capabilities?.features?.managedOpenRouting !== true) throw new StreamFault('UNAVAILABLE', 'Update Desktop to open managed browser tabs'); } }, async () => {
        // Authority must still match after admission waits for its session lane.
        deps.host.requireCurrent(principal); const profileId = profile(input.sessionId);
        if (method === 'browser.tab.open') {
          const before = await deps.service.getSessionSnapshot(profileId, input.sessionId);
          const outcome = await deps.service.invoke(input.sessionId, profileId, 'open', { ...(input.url ? { url: input.url } : {}), show: false, reuseExistingTab: false }, { requiredTargetAffinity: 'managed-electron' });
          if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
          if (input.activate === false) await deps.service.setTabSelection(profileId, input.sessionId, before.activeTabId, before.defaultTabId);
          return { tabId: outcome.result.tab.tabId };
        }
        await requireManagedTab(profileId, input.sessionId, input.tabId!);
        if (method === 'browser.tab.activate') { await deps.service.activateTab(profileId, input.sessionId, input.tabId!); return { tabId: input.tabId }; }
        if (method === 'browser.tab.close') { await deps.service.closeTab(profileId, input.sessionId, input.tabId!); return { tabId: input.tabId }; }
        if (method === 'browser.recording.start') {
          const outcome = await deps.service.invoke(input.sessionId, profileId, 'recordingStart', { tabId: input.tabId });
          if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
          return { browserRecording: outcome.result };
        }
        const outcome = await deps.service.invoke(input.sessionId, profileId, 'recordingStop', { tabId: input.tabId, recordingId: input.recordingId! });
        if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
        return { browserRecording: outcome.result };
      });
    return await deps.control.getReceipt(principal, input.commandId) as RpcOutput<M>;
  }
  async function requireManagedTab(profileId: string, sessionId: string, tabId: string) { const snapshot = await deps.service.getSessionSnapshot(profileId, sessionId); if (!snapshot.tabs.some(t => t.tabId === tabId && t.targetAffinity === 'managed-electron' && t.lifecycle !== 'closed')) throw new StreamFault('NOT_FOUND', 'Managed browser tab is unavailable in this session'); }
  async function* subscribe(principal: Principal, input: RpcInput<'browser.subscribe'>, signal: AbortSignal): AsyncGenerator<Item> {
    authorize(principal, 'session:read'); const profileId = profile(input.sessionId);
    const queue = new StreamQueue<Item>(); const end = () => queue.end(); signal.addEventListener('abort', end, { once: true });
    const sessions = watchers.get(input.sessionId) ?? new Set(); sessions.add(queue); watchers.set(input.sessionId, sessions);
    try { if (signal.aborted) return; const snapshot = await deps.service.getSessionSnapshot(profileId, input.sessionId); let revision = snapshot.revision; yield { snapshot }; for await (const item of queue) { if (item.snapshot.revision <= revision) continue; revision = item.snapshot.revision; yield item; } }
    finally { signal.removeEventListener('abort', end); sessions.delete(queue); if (!sessions.size) watchers.delete(input.sessionId); }
  }
  return { execute, subscribe, publish: (snapshot: BrowserSessionSnapshot) => { for (const queue of watchers.get(snapshot.sessionAgentId) ?? []) queue.push({ snapshot }); deps.host.publishSession(snapshot); } };
}
function validateViewport(viewport: BrowserViewportSetting) { if (viewport.mode !== 'fill' && viewport.width * viewport.height > 3840 * 2160) throw new StreamFault('INVALID_INPUT', 'Browser viewport area exceeds its budget'); }
function viewportInput(viewport: BrowserViewportSetting, tabId: string) { if (viewport.mode === 'fill') return { tabId, mode: 'fill' as const, timeoutMs: 15000 }; if (viewport.mode === 'freeform') return { tabId, mode: 'freeform' as const, width: viewport.width, height: viewport.height, timeoutMs: 15000 }; return { tabId, mode: 'preset' as const, presetId: viewport.presetId, orientation: viewport.orientation, timeoutMs: 15000 }; }
