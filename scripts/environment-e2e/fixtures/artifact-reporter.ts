import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { readManifest } from '../launch.js';
export default class ArtifactReporter implements Reporter {
  async onTestEnd(test: TestCase, result: TestResult) {
    if (!process.env.FORGE_E2E_MANIFEST) return;
    const manifest = await readManifest(process.env.FORGE_E2E_MANIFEST);
    const path = join(manifest.artifactRoot, 'playwright-results.json');
    const results = JSON.parse(await readFile(path, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '[]'; throw error; }));
    results.push({ title: test.title, status: result.status, durationMs: result.duration });
    await writeFile(path, JSON.stringify(results, null, 2));
    // No error/prompt content in failure metadata.
    if (!['failed', 'timedOut', 'interrupted'].includes(result.status)) return;
    await writeFile(join(manifest.artifactRoot, 'test-failure.json'), JSON.stringify({ status: result.status }));
  }
}
