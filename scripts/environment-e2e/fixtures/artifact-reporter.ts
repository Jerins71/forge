import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import type { FleetManifest } from '../launch.js';
export default class ArtifactReporter implements Reporter {
  private results: Array<{ title: string; status: string; durationMs: number }> = [];
  onTestEnd(test: TestCase, result: TestResult) {
    if (!process.env.FORGE_E2E_MANIFEST) return;
    // Playwright does not await onTestEnd promises. Small synchronous metadata
    // writes preserve the failure marker before teardown and cannot race skipped cases.
    const manifest = JSON.parse(readFileSync(process.env.FORGE_E2E_MANIFEST, 'utf8')) as FleetManifest;
    const path = join(manifest.artifactRoot, 'playwright-results.json');
    this.results.push({ title: test.title, status: result.status, durationMs: result.duration });
    writeFileSync(path, JSON.stringify(this.results, null, 2));
    // No error/prompt content in failure metadata.
    if (!['failed', 'timedOut', 'interrupted'].includes(result.status)) return;
    writeFileSync(join(manifest.artifactRoot, 'test-failure.json'), JSON.stringify({ status: result.status }));
  }
}
