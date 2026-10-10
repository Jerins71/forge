import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import type { FleetManifest } from '../launch.js';
export default class ArtifactReporter implements Reporter {
  private results: Array<{ title: string; status: string; durationMs: number; suite: string }> = [];
  onTestEnd(test: TestCase, result: TestResult) {
    const suite = basename(test.location.file, '.spec.ts');
    const manifestPath = process.env.FORGE_E2E_MANIFEST ?? join(process.cwd(), `.internal/forge-v2-remote/e2e-manifest-${process.env.FORGE_E2E_RUN_ID}-${result.workerIndex}-${suite}.json`);
    if (!existsSync(manifestPath)) return;
    // Playwright does not await onTestEnd promises. Small synchronous metadata
    // writes preserve the failure marker before teardown and cannot race skipped cases.
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FleetManifest;
    const path = join(manifest.artifactRoot, 'playwright-results.json');
    this.results.push({ title: test.title, status: result.status, durationMs: result.duration, suite });
    writeFileSync(path, JSON.stringify(this.results.filter(item => item.suite === suite), null, 2));
    // No error/prompt content in failure metadata.
    if (!['failed', 'timedOut', 'interrupted'].includes(result.status)) return;
    writeFileSync(join(manifest.artifactRoot, 'test-failure.json'), JSON.stringify({ status: result.status }));
  }
}
