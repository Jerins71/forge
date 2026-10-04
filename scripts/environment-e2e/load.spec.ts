import { test } from '@playwright/test';
// Release gates await the real event mirror/RPC and a production profiling UI.
// Never seed the browser store directly or start 4,000 provider runtimes.
const scenarios = [
  '9.3 eight real backends x 500 serialized manager summaries x 10 projects; 10s warmup/provenance',
  '9.3 exactly eight application sockets and seven immediately after disabling one',
  '9.3 60s idle bidirectional traffic <= 1 KiB/min/environment; report TCP/TLS separately',
  '9.3 60s three mounted detail views x 20 coalesced updates/sec; unrelated selectors/rows unchanged',
  '9.3 ten 1/8/32/128-event reconnect gaps: no catalog snapshot, encoded gap + 8 KiB and <= 1 MiB',
  '9.3 high-water resume <= 8 KiB and bytes-vs-gap plot with 500-row baseline',
  '9.3 over-budget/retention/epoch resume: paged <= 1 MiB frames and atomic synchronized barrier',
  '9.3 production Sidebar Profiler p95 < 16ms/max < 50ms and no stream long task > 100ms',
  '9.3 shell heap <= 64 MiB and three details/idle cache <= 64 MiB additional',
  '9.3 100 mount/unmount navigations, 5-minute cache expiry/GC: retained growth <= 5 MiB',
  '9.3 only three detail subscriptions, none for 3,997 unmounted summaries and zero after release',
  '9.3 slow reader queues <= 2 MiB/256 frames, offending stream resync and RSS settles within 10 MiB',
  '9.3 idle counters: no repeated catalog serialization/transcript hydration/Git/host probes',
  '9.3 save raw samples, p50/p95/max, heap milestones and per-environment freshness'
];
for (const name of scenarios) test.fixme(name, async () => {});
