import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchFleet, verifyFleetHealth, repositoryRoot } from '../launch.js';
import { legacySmoke } from './legacy-smoke.js';
import { openUiFleet } from './ui-fleet.js';
import { writeInfrastructureArtifacts, validateArtifactIndex } from '../assert-artifacts.js';

const fleet = await launchFleet({ environments: 3, out: join(repositoryRoot, '.internal/forge-v2-remote/harness-ui-infrastructure.json') });
let failed = true;
try {
  const smoke = await legacySmoke(fleet.manifest.environments[0]!);
  // Exercise infrastructure without claiming A/D auth or platform acceptance.
  const ui = await openUiFleet(fleet.manifestPath, { integration: {
    bootstrap: async environment => ({ environmentId: `00000000-0000-4000-8000-00000000000${fleet.manifest.environments.findIndex(value => value.name === environment.name) + 1}`, bearer: 'synthetic-inert-ui-test-identity' }),
    seed: async (environment, session) => ({ environmentId: session.environmentId, label: environment.name, baseUrl: environment.baseUrl,
      projectTitle: 'Synthetic UI infrastructure', sessionId: smoke.sessionId }),
    platformScript: async () => 'globalThis.__fixtureInfrastructure = true;',
  } });
  try {
    assert.equal((await fetch(ui.uiUrl)).status, 200, 'real built UI shell');
    assert((await (await fetch(ui.uiUrl)).text()).includes('/__forge_e2e_platform.js'));
    assert.equal(await (await fetch(`${ui.uiUrl}/__forge_e2e_platform.js`)).text(), 'globalThis.__fixtureInfrastructure = true;');
    const evidence = await ui.launchEvidence(ui.a, smoke.sessionId);
    assert.equal(evidence.commands, 0, 'current backend has no V2 command DB');
    assert.equal(evidence.worktrees, 0);
    assert(evidence.dispatches >= 3);
    assert.equal(evidence.markerChanged, true);
    const b = fleet.manifest.environments[1]!;
    const originalPid = b.pid;
    const marker = await readFile(join(b.checkout, 'environment-marker.txt'), 'utf8');
    await ui.stop(ui.b);
    await assert.rejects(fetch(`${ui.b.baseUrl}/api/health`));
    assert.equal((await fetch(`${ui.a.baseUrl}/api/health`)).status, 200);
    assert.equal((await fetch(`${ui.c.baseUrl}/api/health`)).status, 200);
    await ui.start(ui.b);
    assert.notEqual(b.pid, originalPid);
    assert.equal(await readFile(join(b.checkout, 'environment-marker.txt'), 'utf8'), marker);
    await verifyFleetHealth(fleet.manifest);
    await writeFile(join(fleet.manifest.artifactRoot, 'ui-infrastructure.json'), JSON.stringify({ builtUiServed: true, restartedSameUrl: true, othersHealthy: true, evidence, v2AuthPlatformDeferred: true }, null, 2));
  } finally { await ui.dispose(); }
  await assert.rejects(openUiFleet(fleet.manifestPath), /bootstrap/);
  failed = false;
  await fleet.stop();
  const indexPath = await writeInfrastructureArtifacts(fleet.manifest, fleet.manifestPath, smoke);
  const index = await validateArtifactIndex(indexPath);
  const invalidPath = join(fleet.manifest.artifactRoot, 'invalid-index.json');
  await writeFile(invalidPath, JSON.stringify({ ...index, suite: 'slice', status: 'passed', deferred: [] }));
  await assert.rejects(validateArtifactIndex(invalidPath), /missing trace/);
  await writeFile(invalidPath, JSON.stringify({ ...index, artifacts: [{ ...index.artifacts[0], path: '../outside.json' }] }));
  await assert.rejects(validateArtifactIndex(invalidPath));
  console.log(`UI infrastructure, restart, read-only evidence and artifact rejection passed; artifacts ${fleet.manifest.artifactRoot}`);
} finally { await fleet.stop(failed); }
