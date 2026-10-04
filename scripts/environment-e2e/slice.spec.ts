import { test, expect } from '@playwright/test';
import { readManifest, verifyFleetHealth } from './launch.js';
import { legacySmoke } from './fixtures/legacy-smoke.js';
import { proxySelfTest } from './fixtures/proxy-self-test.js';

// These acceptance cases precede the harness implementation. V2 integration is
// deliberately fixme: current-backend infrastructure passes are separate evidence.
test('fleet: distinct processes, ports, data roots and checkout markers are healthy', async () => {
  const manifest = await readManifest(process.env.FORGE_E2E_MANIFEST!);
  expect(manifest.environments.length).toBeGreaterThanOrEqual(3);
  await verifyFleetHealth(manifest);
});
test('native fixture: legacy WS creates manager, streams reply, answers choice and receives worker result', async () => {
  const manifest = await readManifest(process.env.FORGE_E2E_MANIFEST!);
  const evidence = await legacySmoke(manifest.environments[0]!);
  expect(evidence.assistantReplies).toBeGreaterThanOrEqual(3);
  expect(evidence.workerResults).toBe(1);
});
test('fault proxy: HTTP and binary WS forwarding, lost result and selected close', proxySelfTest);

const pending = [
  '9.2.1 primary bootstrap, link/code pairing, consumed-grant replay and stable identity',
  '9.2.2 repository grouping, manual split/merge and environment-qualified session IDs',
  '9.2.3 B new worktree/attachment with post-COMMIT lost ack: one command/input/workspace/dispatch',
  '9.2.4 manager/worker choice and native worker result; lost choice ack, conflicting answer, authenticated history/content',
  '9.2.5 B files/diff/audit/model/terminal routing; A/C streams and mounted-only detail subscriptions',
  '9.2.6 small-gap reconnect and reload from persisted cursors without catalog snapshot',
  '9.2.7 crash at pre-commit, post-commit/pre-ack, post-Git, post-meta, post-JSONL, dispatch-marker and provider-accept boundaries',
  '9.2.8 active message/worker stop, writer exclusion, restart-safe stop and interrupted pending choice',
  '9.2.9 C revocation closes RPC/download/created PTY within 1s, host terminal detach and A/B isolation',
  '9.2.10 wrong protocol/environment, forged ticket, scopes, invalid/oversized input and changed duplicate fail closed',
  '9.2.10 copied-root identity, snapshot barrier race, retention and buffer overflow fail closed'
];
for (const name of pending) test.fixme(name, async () => {});
