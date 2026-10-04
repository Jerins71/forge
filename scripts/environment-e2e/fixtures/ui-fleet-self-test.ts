import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchFleet, verifyFleetHealth, repositoryRoot, controlEnvironment, type BootstrapSession } from '../launch.js';
import { legacySmoke } from './legacy-smoke.js';
import { openUiFleet } from './ui-fleet.js';
import { writeInfrastructureArtifacts, validateArtifactIndex } from '../assert-artifacts.js';

const fleet = await launchFleet({ environments: 3, out: join(repositoryRoot, '.internal/forge-v2-remote/harness-ui-infrastructure.json') });
let failed = true;
try {
  const environment = fleet.manifest.environments[0]!;
  const session = await controlEnvironment<BootstrapSession>(fleet.manifest, environment.name, 'bootstrap');
  const smoke = await legacySmoke(environment, session);
  const ui = await openUiFleet(fleet.manifestPath);
  try {
    assert.equal((await fetch(ui.uiUrl)).status, 200, 'real built UI shell');
    assert((await (await fetch(ui.uiUrl)).text()).includes('/__forge_e2e_platform.js'));
    const platformCode = await (await fetch(`${ui.uiUrl}/__forge_e2e_platform.js`)).text();
    assert(platformCode.includes('__forgeE2EPlatform'));
    assert(!platformCode.includes(session.bearer), 'platform script contains no credential');
    const evidence = await ui.launchEvidence(ui.a, smoke.sessionId);
    assert.equal(evidence.commands, 0, 'legacy fixture created no V2 launch command');
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
    await writeFile(join(fleet.manifest.artifactRoot, 'ui-infrastructure.json'), JSON.stringify({ builtUiServed: true, restartedSameUrl: true, othersHealthy: true, evidence, realPrivatePairing: true, credentialFreePlatformScript: true }, null, 2));
  } finally { await ui.dispose(); }
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
