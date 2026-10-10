import { expect, type Page, type CDPSession } from '@playwright/test';
import { test } from './fixtures/test.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname, cpus, totalmem } from 'node:os';
import { readManifest, controlEnvironment, type FleetManifest, type BootstrapSession } from './launch.js';
import { createFixturePlatform, fixturePlatformScript } from './fixtures/ui-platform.js';
import { serveBuiltUi } from './fixtures/ui-fleet.js';
import { seedLoadEnvironment } from './fixtures/load-seed.js';
import { openFixtureRpc, until } from './fixtures/rpc-client.js';
import { loadConfiguredSqliteDatabaseConstructor } from '../../apps/backend/src/sqlite-database-loader.js';
import { getEnvironmentDbPath } from '../../apps/backend/src/swarm/storage/data-paths.js';

test.use({ environmentSuite: 'load' });

type Observation = Record<string, any>;
const percentile = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? sorted[Math.ceil((sorted.length - 1) * p)]! : null;
  return { count: sorted.length, p50: at(.5), p95: at(.95), max: at(1) };
};
const runtime = (page: Page) => page.evaluate(() => (window as any).__forgeE2ERuntime.snapshot());
async function waitFresh(page: Page, count: number) {
  await expect.poll(async () => (await runtime(page)).filter((value: any) => value.fresh && value.sessions === count).length, { timeout: 60000 }).toBe(8);
}
async function heap(cdp: CDPSession) {
  await cdp.send('HeapProfiler.collectGarbage');
  const value = await cdp.send('Runtime.getHeapUsage');
  const performance = await cdp.send('Performance.getMetrics');
  return { usedSize: value.usedSize, totalSize: value.totalSize, JSHeapUsedSize: performance.metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value ?? null };
}
async function snapshot(cdp: CDPSession, path: string, secrets: string[]) {
  const parts: string[] = [];
  const receive = ({ chunk }: { chunk: string }) => parts.push(chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', receive);
  try { await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }); }
  finally { cdp.off('HeapProfiler.addHeapSnapshotChunk', receive); }
  let content = parts.join('');
  for (const secret of secrets) content = content.replaceAll(secret, '[redacted fixture credential]');
  content = content.replace(/ticket\.[A-Za-z0-9_-]{43}/g, 'ticket.[redacted]');
  await writeFile(path, content);
}

test('9.3 real eight-backend production load gate', async ({ browser }) => {
  test.setTimeout(1000000);
  const manifest = await readManifest(process.env.FORGE_E2E_MANIFEST!);
  expect(manifest.environments).toHaveLength(8);
  const report: Observation = { formatVersion: 1, reference: { hostname: hostname(), cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), node: process.version, platform: process.platform, arch: process.arch, browser: browser.version(), build: 'production React profiling; VITE_FORGE_E2E_PROFILE=1; no throttling' }, raw: {}, statistics: {}, budgets: {}, deviations: [] };
  const save = () => writeFile(join(manifest.artifactRoot, 'performance.json'), JSON.stringify(report, null, 2));
  const sessions = await Promise.all(manifest.environments.map(environment => controlEnvironment<BootstrapSession>(manifest, environment.name, 'bootstrap')));
  const metrics = () => Promise.all(manifest.environments.map(environment => controlEnvironment<Observation>(manifest, environment.name, 'fixture', { operation: 'metrics', gc: true })));
  const operation = (index: number, input: unknown) => controlEnvironment(manifest, manifest.environments[index]!.name, 'fixture', input);
  const platform = createFixturePlatform(manifest.environments, sessions[0]!, sessions[0]!, () => `http://127.0.0.1:${manifest.uiPort}`, sessions.slice(1));
  const ui = await serveBuiltUi(join(manifest.repositoryRoot, 'apps/ui/.output/public'), fixturePlatformScript, { port: manifest.uiPort, platform });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    const state = { frames: [] as any[], sockets: [] as WebSocket[], longTasks: [] as any[] };
    (window as any).__forgeLoadWire = state;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(String(url)).pathname !== '/api/v2/rpc') return;
        state.sockets.push(this);
        this.addEventListener('message', event => {
          if (typeof event.data !== 'string') return;
          const frame = JSON.parse(event.data);
          state.frames.push({ direction: 'received', at: performance.now(), bytes: new TextEncoder().encode(event.data).length, type: frame.type, kind: frame.item?.kind, sequence: frame.item?.sequence, eventType: frame.item?.event?.type, shellSnapshot: Array.isArray(frame.item?.snapshot?.sessions), detailSnapshot: Array.isArray(frame.item?.snapshot?.items), requestId: frame.requestId, errorCode: frame.error?.code, subscriptionId: frame.subscriptionId });
        });
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === 'string') {
          const frame = JSON.parse(data);
          state.frames.push({ direction: 'sent', at: performance.now(), bytes: new TextEncoder().encode(data).length, type: frame.type, method: frame.method, commandId: frame.input?.commandId, afterSequence: frame.input?.cursor?.afterSequence });
        }
        return super.send(data);
      }
    };
    new PerformanceObserver(list => { for (const entry of list.getEntries()) state.longTasks.push({ start: entry.startTime, duration: entry.duration, attribution: (entry as any).attribution?.map((value: any) => ({ name: value.name, containerType: value.containerType })) }); }).observe({ type: 'longtask', buffered: true });
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable'); await cdp.send('HeapProfiler.enable');
  const readWire = () => page.evaluate(() => (window as any).__forgeLoadWire.frames);
  const browserSockets = () => page.evaluate(() => (window as any).__forgeLoadWire.sockets.filter((socket: WebSocket) => socket.readyState === 1).length);
  const wireStart = () => page.evaluate(() => (window as any).__forgeLoadWire.frames.length);
  const browserPerf = () => page.evaluate(() => structuredClone((window as any).__forgeE2EPerformance));
  let tracing = false;
  try {
    await page.goto(`${ui.url}/?view=archive`);
    await page.waitForFunction(() => !!(window as any).__forgeE2ERuntime);
    await expect.poll(async () => (await browserPerf()).commits.length, { message: 'The qualification UI must use the production React profiling renderer' }).toBeGreaterThan(0);
    await waitFresh(page, 0);
    report.raw.empty = { heap: await heap(cdp), fleet: await metrics(), freshness: await runtime(page) };
    const seeds = [];
    for (let index = 0; index < 8; index++) seeds.push(await seedLoadEnvironment(manifest, manifest.environments[index]!, sessions[index]!));
    await waitFresh(page, 500);
    await page.waitForTimeout(10000);
    const shellHeap = await heap(cdp);
    report.raw.seed = seeds.map(seed => ({ environmentId: seed.environmentId, summaries: seed.summaries, projects: seed.projects }));
    report.raw.shell = { heap: shellHeap, fleet: await metrics(), freshness: await runtime(page), browserSockets: await browserSockets() };
    report.budgets.shellHeap = { limitBytes: 67108864, actualBytes: shellHeap.usedSize - report.raw.empty.heap.usedSize, pass: shellHeap.usedSize - report.raw.empty.heap.usedSize <= 67108864 };
    await snapshot(cdp, join(manifest.artifactRoot, 'heap-shell.heapsnapshot'), sessions.map(session => session.bearer));
    await mkdir(join(manifest.artifactRoot, 'ui'), { recursive: true }); await page.screenshot({ path: join(manifest.artifactRoot, 'ui/load-shell.png'), fullPage: true });
    const disabledId = sessions[7]!.environmentId;
    await page.evaluate(id => (window as any).__forgeE2ERuntime.setEnabled(id, false), disabledId);
    await expect.poll(browserSockets).toBe(7);
    report.raw.disabled = { sockets: await browserSockets(), fleet: await metrics() };
    await page.evaluate(id => (window as any).__forgeE2ERuntime.setEnabled(id, true), disabledId); await waitFresh(page, 500);
    report.budgets.sockets = { enabled: report.raw.shell.browserSockets, disabled: report.raw.disabled.sockets, pass: report.raw.shell.browserSockets === 8 && report.raw.disabled.sockets === 7 };
    const idleBefore = await metrics(); const idleWireStart = await wireStart(); const idleStart = Date.now();
    const idleSamples = [];
    for (let index = 0; index < 12; index++) { await page.waitForTimeout(5000); idleSamples.push({ elapsedMs: Date.now() - idleStart, fleet: await metrics(), freshness: await runtime(page) }); }
    const idleAfter = await metrics(); const idleFrames = (await readWire()).slice(idleWireStart);
    const idleBytes = idleAfter.map((value, index) => ({ environment: manifest.environments[index]!.name, applicationBytes: value.applicationRxBytes + value.applicationTxBytes - idleBefore[index]!.applicationRxBytes - idleBefore[index]!.applicationTxBytes, tcpBytes: value.tcpRxBytes + value.tcpTxBytes - idleBefore[index]!.tcpRxBytes - idleBefore[index]!.tcpTxBytes, tlsBytes: 0, counters: Object.fromEntries(['catalogSerializations', 'transcriptHydrations', 'gitScans', 'hostResourceProbes'].map(key => [key, value[key] - idleBefore[index]![key]])) }));
    report.raw.idle = { durationMs: Date.now() - idleStart, before: idleBefore, after: idleAfter, samples: idleSamples, perEnvironment: idleBytes, frames: idleFrames };
    report.statistics.idleBytes = percentile(idleBytes.map(value => value.applicationBytes));
    report.budgets.idleTraffic = { limitBytes: 1024, perEnvironment: idleBytes, pass: idleBytes.every(value => value.applicationBytes <= 1024) };
    report.budgets.idleWork = { expectedEach: 0, pass: idleBytes.every(value => Object.values(value.counters).every(count => count === 0)) };
    await save();
    const refs = seeds.slice(0, 3).map(seed => ({ environmentId: seed.environmentId, sessionId: seed.sessionIds[0]! }));
    await page.evaluate(refs => (window as any).__forgeE2ERuntime.mountDetails(refs), refs);
    await expect(page.locator('[data-e2e-detail][data-freshness="live"]')).toHaveCount(3);
    const detailHeap = await heap(cdp); const mountedBefore = await metrics();
    report.raw.mounted = { heap: detailHeap, fleet: mountedBefore };
    report.budgets.detailHeap = { limitBytes: 67108864, actualBytes: detailHeap.usedSize - shellHeap.usedSize, pass: detailHeap.usedSize - shellHeap.usedSize <= 67108864 };
    const mountedSessions = mountedBefore.flatMap(value => value.subscriptions.filter((subscription: any) => subscription.method === 'session.subscribe'));
    report.budgets.detailSubscriptions = { mounted: mountedSessions, logicalCount: mountedSessions.length, pass: mountedSessions.length === 3 && mountedSessions.every((subscription: any) => refs.some(ref => ref.sessionId === subscription.sessionId)) };
    await snapshot(cdp, join(manifest.artifactRoot, 'heap-details.heapsnapshot'), sessions.map(session => session.bearer));
    const traceEvents: unknown[] = []; cdp.on('Tracing.dataCollected', ({ value }) => traceEvents.push(...value));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,blink.user_timing', transferMode: 'ReportEvents' });
    const steadyStart = await page.evaluate(() => performance.now()); const perfBefore = await browserPerf(); const steadyWireStart = await wireStart();
    await Promise.all(refs.map((ref, index) => operation(index, { operation: 'stream-start', sessionId: ref.sessionId, hz: 20, durationMs: 60000, textBytes: 64 })));
    const steadySamples = [];
    for (let index = 0; index < 12; index++) { await page.waitForTimeout(5000); steadySamples.push({ elapsedSeconds: (index + 1) * 5, fleet: await metrics(), freshness: await runtime(page) }); }
    await Promise.all(refs.map((_, index) => operation(index, { operation: 'stream-stop' })));
    const steadyEnd = await page.evaluate(() => performance.now()); const perfAfter = await browserPerf(); const fleetAfter = await metrics();
    const traceComplete = new Promise<void>(resolve => cdp.once('Tracing.tracingComplete', () => resolve())); await cdp.send('Tracing.end'); await traceComplete;
    await writeFile(join(manifest.artifactRoot, 'browser-performance-trace.json'), JSON.stringify({ traceEvents }));
    const commits = perfAfter.commits.slice(perfBefore.commits.length); const longTasks = await page.evaluate(({ start, end }) => (window as any).__forgeLoadWire.longTasks.filter((task: any) => task.start >= start && task.start <= end), { start: steadyStart, end: steadyEnd });
    report.raw.steady = { start: steadyStart, end: steadyEnd, commits, longTasks, samples: steadySamples, wire: (await readWire()).slice(steadyWireStart), fleet: fleetAfter };
    const steadyWire = report.raw.steady.wire;
    const mountedIds = new Set(mountedSessions.map((subscription: any) => subscription.subscriptionId));
    const detailFrames = steadyWire.filter((frame: any) => ['item.upsert', 'item.remove', 'worker.upsert', 'worker.remove', 'choice.upsert', 'choice.remove', 'receipt.upsert'].includes(frame.eventType));
    report.raw.steady.detailFrames = detailFrames;
    report.budgets.unmountedDetailFrames = { actual: detailFrames.filter((frame: any) => !mountedIds.has(frame.subscriptionId)).length, expected: 0, pass: detailFrames.every((frame: any) => mountedIds.has(frame.subscriptionId)) };
    report.raw.steady.injectionsPerView = refs.map((_, index) => fleetAfter[index].injections - mountedBefore[index].injections);
    report.statistics.sidebarCommitMs = percentile(commits.map((value: any) => value.duration)); report.statistics.longTaskMs = percentile(longTasks.map((value: any) => value.duration));
    report.budgets.sidebarCommits = { p95LimitMs: 16, maxLimitMs: 50, ...report.statistics.sidebarCommitMs, pass: commits.length > 0 && report.statistics.sidebarCommitMs.p95 < 16 && report.statistics.sidebarCommitMs.max < 50 };
    report.budgets.longTasks = { limitMs: 100, ...report.statistics.longTaskMs, pass: longTasks.every((value: any) => value.duration <= 100) };
    const isolatedBefore = await browserPerf(); await operation(1, { operation: 'shell-burst', sessionId: refs[1]!.sessionId, count: 1 }); await page.waitForTimeout(500); const isolatedAfter = await browserPerf();
    const unrelatedRows = Object.entries(isolatedAfter.rows).filter(([key]) => !key.startsWith(sessions[1]!.environmentId + ':')).map(([key, count]) => ({ key, renders: Number(count) - (isolatedBefore.rows[key] ?? 0) }));
    report.raw.isolated = { before: isolatedBefore, after: isolatedAfter, unrelatedRows }; report.budgets.unrelatedRows = { expected: 0, pass: unrelatedRows.every(row => row.renders === 0) };
    await page.evaluate(() => (window as any).__forgeE2ERuntime.mountDetails([])); await page.waitForTimeout(300);
    report.raw.released = await metrics();
    report.budgets.detailSubscriptions.releasedPass = report.raw.released.every((value: any) => !value.subscriptions.some((subscription: any) => subscription.method === 'session.subscribe'));
    await save();
    const Constructor = await loadConfiguredSqliteDatabaseConstructor();
    const gapObservations = [];
    for (const gap of [0, 1, 8, 32, 128, 1, 8, 32, 128, 8]) {
      const shell = (await runtime(page)).find((value: any) => value.environmentId === sessions[1]!.environmentId);
      await page.evaluate(id => (window as any).__forgeE2ERuntime.setEnabled(id, false), sessions[1]!.environmentId);
      await expect.poll(browserSockets).toBe(7);
      if (gap) await operation(1, { operation: 'shell-burst', sessionId: refs[1]!.sessionId, count: gap });
      const db = new Constructor(getEnvironmentDbPath(manifest.environments[1]!.dataDir), { readonly: true });
      let eligibleBytes = 0; let eligibleEvents = 0;
      try { const rows = db.prepare("SELECT sequence,payload_json FROM events WHERE topic='shell' AND sequence>? ORDER BY sequence").all(shell.cursor.afterSequence) as { sequence: number; payload_json: string }[]; eligibleEvents = rows.length; eligibleBytes = rows.reduce((n, row) => n + Buffer.byteLength(JSON.stringify({ type: 'stream', subscriptionId: '00000000-0000-0000-0000-000000000000', item: { kind: 'event', streamEpoch: shell.cursor.streamEpoch, sequence: row.sequence, event: JSON.parse(row.payload_json) } })), 0); }
      finally { db.close(); }
      const start = await wireStart();
      await page.evaluate(id => (window as any).__forgeE2ERuntime.setEnabled(id, true), sessions[1]!.environmentId); await waitFresh(page, 500);
      const frames = (await readWire()).slice(start); const bytes = frames.reduce((n: number, frame: any) => n + frame.bytes, 0);
      gapObservations.push({ gap, eligibleEvents, eligibleBytes, bytes, frames, snapshots: frames.filter((frame: any) => frame.shellSnapshot).length, pass: !frames.some((frame: any) => frame.shellSnapshot) && bytes <= eligibleBytes + 8192 && bytes <= 1048576 });
    }
    report.raw.gaps = gapObservations; report.statistics.reconnectBytes = percentile(gapObservations.map(value => value.bytes)); report.budgets.reconnect = { pass: gapObservations.every(value => value.pass), highWaterPass: gapObservations[0]!.bytes <= 8192 };
    const initialShell = (await readWire()).filter((frame: any) => frame.shellSnapshot); report.raw.catalogBaselineFrames = initialShell;
    const rows = gapObservations.map(value => `<circle cx="${50 + value.gap * 4}" cy="${260 - value.bytes / 400}" r="4"/><text x="${52 + value.gap * 4}" y="${254 - value.bytes / 400}" font-size="9">${value.gap}:${value.bytes}</text>`).join('');
    await writeFile(join(manifest.artifactRoot, 'reconnect-bytes.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="650" height="300"><rect width="100%" height="100%" fill="white"/><text x="20" y="20">Eligible gap events vs total application reconnect bytes</text><path d="M40 40V270H620" fill="none" stroke="black"/><g fill="#2760a0">${rows}</g></svg>`);
    await page.evaluate(id => (window as any).__forgeE2ERuntime.setEnabled(id, false), sessions[1]!.environmentId); await operation(1, { operation: 'shell-burst', sessionId: refs[1]!.sessionId, count: 1100 });
    const overStart = await wireStart(); await page.evaluate(id => (window as any).__forgeE2ERuntime.setEnabled(id, true), sessions[1]!.environmentId); await waitFresh(page, 500); const overFrames = (await readWire()).slice(overStart);
    report.raw.overBudget = { frames: overFrames, freshCatalog: await runtime(page) }; report.budgets.overBudget = { pass: overFrames.some((frame: any) => frame.shellSnapshot) && overFrames.some((frame: any) => frame.kind === 'synchronized') && overFrames.every((frame: any) => frame.bytes <= 1048576), maxFrameBytes: Math.max(...overFrames.map((frame: any) => frame.bytes)) };
    const slow = await slowReader(manifest, sessions[1]!, refs[1]!.sessionId); report.raw.slowReader = slow;
    report.budgets.serverQueues = { pass: slow.resync && slow.queues.streamQueueFramesMax <= 256 && slow.queues.streamQueueBytesMax <= 2097152 && slow.queues.sendQueueFramesMax <= 256 && slow.queues.sendQueueBytesMax <= 2097152 && slow.rssGrowth <= 10485760, rssGrowth: slow.rssGrowth, ...slow.queues };
    const navigationBefore = await heap(cdp); const switches = [];
    for (let index = 0; index < 100; index++) {
      const target = { environmentId: seeds[1]!.environmentId, sessionId: seeds[1]!.sessionIds[index]! };
      await page.evaluate(target => (window as any).__forgeE2ERuntime.mountDetails([target]), target);
      await expect(page.locator('[data-e2e-detail][data-freshness="live"]')).toHaveCount(1);
      switches.push({ index, sessionId: target.sessionId });
    }
    await page.evaluate(() => (window as any).__forgeE2ERuntime.mountDetails([])); await page.waitForTimeout(300);
    report.raw.navigation = { before: navigationBefore, afterSwitches: await heap(cdp), switches, released: await metrics() }; await save();
    const expiryStart = Date.now();
    for (let index = 0; index < 11; index++) await page.waitForTimeout(30000);
    const expiredHeap = await heap(cdp); report.raw.navigation.expired = { waitedMs: Date.now() - expiryStart, heap: expiredHeap, fleet: await metrics() };
    report.budgets.retainedHeap = { limitBytes: 5242880, actualBytes: expiredHeap.usedSize - navigationBefore.usedSize, pass: expiredHeap.usedSize - navigationBefore.usedSize <= 5242880 };
    await snapshot(cdp, join(manifest.artifactRoot, 'heap-expired.heapsnapshot'), sessions.map(session => session.bearer));
    report.statistics.serverRss = percentile(steadySamples.flatMap(value => value.fleet.map((server: any) => server.memory.rss))); report.statistics.serverQueueFrames = percentile(steadySamples.flatMap(value => value.fleet.map((server: any) => server.sendQueueFramesMax))); report.statistics.serverQueueBytes = percentile(steadySamples.flatMap(value => value.fleet.map((server: any) => server.sendQueueBytesMax)));
    report.statistics.clientHeapBytes = percentile([report.raw.empty.heap.usedSize, shellHeap.usedSize, detailHeap.usedSize, navigationBefore.usedSize, expiredHeap.usedSize]);
    report.statistics.tcpIdleBytes = percentile(idleBytes.map(value => value.tcpBytes));
    report.statistics.sockets = percentile([report.raw.shell.browserSockets, report.raw.disabled.sockets]);
    report.statistics.detailSubscriptionCount = percentile([mountedSessions.length, ...report.raw.released.map((value: any) => value.subscriptions.filter((subscription: any) => subscription.method === 'session.subscribe').length)]);
    report.statistics.encodedFrameBytes = percentile((await readWire()).filter((frame: any) => frame.direction === 'received').map((frame: any) => frame.bytes));
    report.statistics.selectorEvaluations = percentile(Object.keys(perfAfter.selectors).map(key => perfAfter.selectors[key] - (perfBefore.selectors[key] ?? 0)));
    for (const key of ['catalogSerializations', 'transcriptHydrations', 'gitScans', 'hostResourceProbes']) report.statistics[`idle:${key}`] = percentile(idleBytes.map(value => value.counters[key]));
    report.statistics.injectedUpdatesPerView = percentile(report.raw.steady.injectionsPerView);
    report.status = Object.values(report.budgets).every((budget: any) => budget.pass !== false && budget.releasedPass !== false && budget.highWaterPass !== false) ? 'passed' : 'failed';
    await context.tracing.start({ screenshots: true, snapshots: false, sources: false }); tracing = true;
    await page.getByRole('complementary').first().click({ position: { x: 10, y: 20 } });
    await page.screenshot({ path: join(manifest.artifactRoot, 'ui/load-finished.png'), fullPage: true });
    await context.tracing.stop({ path: join(manifest.artifactRoot, 'load-trace.zip') }); tracing = false;
    await writeFile(join(manifest.artifactRoot, 'wire-metrics.json'), JSON.stringify({ idle: report.raw.idle.perEnvironment, reconnect: gapObservations, overBudget: report.raw.overBudget }, null, 2));
    await save();
    expect(Object.entries(report.budgets).filter(([, budget]) => (budget as any).pass === false || (budget as any).releasedPass === false || (budget as any).highWaterPass === false), 'Performance budgets; see raw performance.json').toEqual([]);
  } catch (error) { report.status = 'failed'; report.failure = error instanceof Error ? error.message : String(error); await save(); throw error; }
  finally { if (tracing) await context.tracing.stop().catch(() => undefined); await context.close(); await ui.stop(); }
});

async function slowReader(manifest: FleetManifest, session: BootstrapSession, sessionId: string) {
  const environment = manifest.environments[1]!;
  const metric = () => controlEnvironment<Observation>(manifest, environment.name, 'fixture', { operation: 'metrics', gc: true });
  const beforeConnect = await metric(); const rpc = await openFixtureRpc(environment.baseUrl, session);
  try {
    await rpc.call('session.subscribe', { sessionId }); await until(() => rpc.frames.some(frame => frame.item?.kind === 'synchronized'), Boolean);
    await new Promise(resolve => setTimeout(resolve, 1000)); const before = await metric();
    (rpc.socket as any)._socket.pause();
    await controlEnvironment(manifest, environment.name, 'fixture', { operation: 'burst', sessionId, count: 300, textBytes: 8192 });
    (rpc.socket as any)._socket.resume();
    const error = await until(() => rpc.frames.find(frame => frame.type === 'stream.error' && frame.error?.code === 'RESYNC_REQUIRED'), Boolean, 15000);
    rpc.close();
    // Spec 9.3: RSS must settle within 10 MiB after GC/idle; V8 returns freed pages on its idle memory reducer, not instantly.
    const settle: Array<{ elapsedMs: number; rss: number; heapUsed: number }> = []; const settleStart = Date.now(); let after = await metric();
    while (after.memory.rss - before.memory.rss > 10485760 && Date.now() - settleStart < 30000) {
      await new Promise(resolve => setTimeout(resolve, 2000)); after = await metric(); settle.push({ elapsedMs: Date.now() - settleStart, rss: after.memory.rss, heapUsed: after.memory.heapUsed });
    }
    return { beforeConnect, before, after, settle, resync: !!error, error: error!.error, rssGrowth: after.memory.rss - before.memory.rss, queues: Object.fromEntries(['streamQueueFramesMax', 'streamQueueBytesMax', 'sendQueueFramesMax', 'sendQueueBytesMax'].map(key => [key, after[key]])) };
  } finally { (rpc.socket as any)._socket?.resume(); rpc.close(); }
}
