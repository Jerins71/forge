import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, realpath, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { FleetManifest } from './launch.js';
import type { LegacySmokeEvidence } from './fixtures/legacy-smoke.js';

export type ArtifactKind = 'trace' | 'screenshot' | 'assertions' | 'wire-metrics' | 'performance';
export interface ArtifactIndex {
  formatVersion: 1; runId: string; suite: 'infrastructure' | 'slice' | 'load';
  status: 'passed' | 'failed' | 'incomplete'; manifestPath: string;
  commit: string; runtime: { node: string; playwright: string; platform: string; arch: string };
  rerunCommand: string;
  artifacts: Array<{ kind: ArtifactKind; path: string; sha256: string; sizeBytes: number }>;
  deferred: string[];
}
/** Reports contain counts/provenance, never raw DB, auth, upload or transcript. */
export async function validateArtifactIndex(path: string): Promise<ArtifactIndex> {
  const root = await realpath(resolve(path, '..'));
  const value = JSON.parse(await readFile(path, 'utf8')) as ArtifactIndex;
  assert.equal(value.formatVersion, 1, 'artifact index format');
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.runId), 'run UUID');
  assert(['infrastructure', 'slice', 'load'].includes(value.suite), 'suite');
  assert(['passed', 'failed', 'incomplete'].includes(value.status), 'status');
  assert(isAbsolute(value.manifestPath), 'absolute manifest path');
  assert(/^[0-9a-f]{40}$/.test(value.commit), 'tested commit');
  for (const key of ['node', 'playwright', 'platform', 'arch'] as const) assert(typeof value.runtime[key] === 'string' && value.runtime[key].length > 0, `runtime ${key}`);
  assert(typeof value.rerunCommand === 'string' && value.rerunCommand.length > 0, 'exact rerun command');
  assert(Array.isArray(value.deferred) && value.deferred.every(item => typeof item === 'string'), 'deferred cases');
  assert(Array.isArray(value.artifacts), 'artifacts');
  const paths = new Set<string>();
  const kinds = new Set<ArtifactKind>();
  for (const artifact of value.artifacts) {
    assert(['trace', 'screenshot', 'assertions', 'wire-metrics', 'performance'].includes(artifact.kind), 'artifact kind');
    assert(typeof artifact.path === 'string' && artifact.path.length > 0 && !isAbsolute(artifact.path), 'relative artifact path');
    assert(!paths.has(artifact.path), 'duplicate artifact path'); paths.add(artifact.path);
    const file = await realpath(resolve(root, artifact.path));
    const local = relative(root, file);
    assert(local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local), 'artifact path escapes root');
    const bytes = await readFile(file);
    assert.equal(bytes.length, artifact.sizeBytes, 'artifact byte count');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256, 'artifact checksum');
    kinds.add(artifact.kind);
  }
  const required: ArtifactKind[] = value.suite === 'infrastructure' ? ['assertions'] : ['trace', 'screenshot', 'assertions', 'wire-metrics', 'performance'];
  for (const kind of required) assert(kinds.has(kind), `missing ${kind}`);
  if (value.suite !== 'infrastructure' && value.status === 'passed') assert.equal(value.deferred.length, 0, 'complete acceptance cannot defer scenarios');
  return value;
}
export async function writeInfrastructureArtifacts(manifest: FleetManifest, manifestPath: string, smoke?: LegacySmokeEvidence): Promise<string> {
  const root = manifest.artifactRoot;
  const assertions = {
    formatVersion: 1, fleetHealthy: true, environments: manifest.environments.length,
    distinctPids: new Set(manifest.environments.map(env => env.pid)).size,
    distinctPorts: new Set(manifest.environments.map(env => env.port)).size,
    cleanTeardown: manifest.teardown?.ownedChildrenExited === manifest.environments.length,
    markedRootRemoved: manifest.teardown?.rootRemoved ?? false,
    failureRootPreserved: manifest.status === 'failed',
    nativeLegacySmoke: smoke ?? null,
    deferred: ['Full slice and load acceptance are separate from infrastructure health; see available per-test assertions'],
  };
  const bytes = Buffer.from(`${JSON.stringify(assertions, null, 2)}\n`);
  await writeFile(join(root, 'assertions.json'), bytes);
  const { stdout: commit } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: manifest.repositoryRoot });
  const playwright = JSON.parse(await readFile(join(manifest.repositoryRoot, 'node_modules/@playwright/test/package.json'), 'utf8')) as { version: string };
  // The launcher's latest manifest is reused by subsequent runs. Keep this run's
  // public descriptor/lifecycle metadata alongside its immutable evidence.
  const archivedManifestPath = join(root, 'manifest.json');
  await writeFile(archivedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const index: ArtifactIndex = {
    formatVersion: 1, runId: manifest.runId, suite: 'infrastructure', status: manifest.status === 'failed' ? 'failed' : 'passed', manifestPath: archivedManifestPath,
    commit: manifest.testedCommit ?? commit.trim(), runtime: { node: process.version, playwright: playwright.version, platform: process.platform, arch: process.arch },
    rerunCommand: `pnpm e2e:env --environments ${manifest.environments.length} --provider fixture ${smoke ? '--legacy-smoke' : '--smoke'} --out ${JSON.stringify(manifestPath)}`,
    artifacts: [{ kind: 'assertions', path: 'assertions.json', sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length }],
    deferred: assertions.deferred,
  };
  for (const [report, kind] of [
    ['slice-assertions.json', 'assertions'], ['ui/ui-assertions.json', 'assertions'],
    ['playwright-results.json', 'assertions'], ['wire-metrics.json', 'wire-metrics'],
    ['performance.json', 'performance'], ['browser-performance-trace.json', 'performance'], ['reconnect-bytes.svg', 'performance'],
    ['heap-shell.heapsnapshot', 'performance'], ['heap-details.heapsnapshot', 'performance'], ['heap-expired.heapsnapshot', 'performance'],
    ['load-trace.zip', 'trace'], ['ui/ui-trace.zip', 'trace'], ['electron-smoke.json', 'assertions'],
  ] as const) {
    const content = await readFile(join(root, report)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (!content) continue;
    index.artifacts.push({ kind, path: report, sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: content.length });
    if ((report === 'slice-assertions.json' || report === 'ui/ui-assertions.json') && index.status !== 'failed') index.status = 'incomplete';
  }
  for (const file of await readdir(join(root, 'ui')).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; })) {
    if (!/^[a-z-]+\.png$/.test(file)) continue;
    const content = await readFile(join(root, 'ui', file));
    index.artifacts.push({ kind: 'screenshot', path: `ui/${file}`, sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: content.length });
  }
  if (index.artifacts.some(artifact => artifact.path === 'slice-assertions.json' || artifact.path === 'ui/ui-assertions.json')) {
    const files = ['slice-assertions.json', 'ui/ui-assertions.json'].filter(path => index.artifacts.some(artifact => artifact.path === path)).map(path => path.startsWith('ui/') ? 'scripts/environment-e2e/ui.spec.ts' : 'scripts/environment-e2e/slice.spec.ts');
    // Each suite owns a fresh fleet: slice revokes and re-keys devices that the UI suite pairs.
    index.rerunCommand = `VITE_FORGE_E2E_PLATFORM=1 VITE_FORGE_E2E_PROFILE=1 pnpm --filter @forge/ui build && ${files.map(file => `pnpm exec playwright test ${file} --config scripts/environment-e2e/playwright.config.ts --project=chromium`).join(' && ')}`;
  }
  if (index.artifacts.some(artifact => artifact.path === 'performance.json')) {
    const performance = JSON.parse(await readFile(join(root, 'performance.json'), 'utf8')) as { status: string; budgets?: Record<string, { pass?: boolean; releasedPass?: boolean; highWaterPass?: boolean }> };
    index.rerunCommand = 'VITE_FORGE_E2E_PLATFORM=1 VITE_FORGE_E2E_PROFILE=1 pnpm --filter @forge/ui build && pnpm exec playwright test scripts/environment-e2e/load.spec.ts --config scripts/environment-e2e/playwright.config.ts --project=chromium';
    const failedBudgets = Object.entries(performance.budgets ?? {}).filter(([, budget]) => budget.pass === false || budget.releasedPass === false || budget.highWaterPass === false).map(([name]) => name);
    index.deferred = performance.status === 'passed' && !failedBudgets.length ? [] : [`Load gate ${performance.status}; failed budgets: ${failedBudgets.join(', ') || 'measurement interrupted; inspect performance.json'}`];
    if (['trace', 'screenshot', 'assertions', 'wire-metrics', 'performance'].every(kind => index.artifacts.some(artifact => artifact.kind === kind))) {
      index.suite = 'load'; index.status = manifest.status === 'failed' || performance.status === 'failed' ? 'failed' : performance.status === 'passed' ? 'passed' : 'incomplete';
    }
  }
  const path = join(root, 'artifact-index.json');
  await writeFile(path, `${JSON.stringify(index, null, 2)}\n`);
  await validateArtifactIndex(path);
  return path;
}
async function main() {
  const args = process.argv.slice(2);
  const manifestArg = args.indexOf('--manifest');
  let path: string;
  if (manifestArg >= 0) {
    const manifest = JSON.parse(await readFile(resolve(args[manifestArg + 1]!), 'utf8')) as FleetManifest;
    path = join(manifest.artifactRoot, 'artifact-index.json');
  } else {
    const index = args.indexOf('--index');
    if (index < 0 || !args[index + 1]) throw new Error('Use --manifest <path> or --index <path>');
    path = resolve(args[index + 1]!);
  }
  const index = await validateArtifactIndex(path);
  console.log(`Artifact index valid: ${index.suite} (${index.status}); ${index.artifacts.length} checked artifacts, ${index.deferred.length} deferred gates`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
