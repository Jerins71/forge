import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { readManifest } from '../launch.js';
export default class ArtifactReporter implements Reporter {
  async onTestEnd(_test: TestCase, result: TestResult) {
    if (!['failed', 'timedOut', 'interrupted'].includes(result.status) || !process.env.FORGE_E2E_MANIFEST) return;
    const manifest = await readManifest(process.env.FORGE_E2E_MANIFEST);
    // No error/prompt content in failure metadata.
    await writeFile(join(manifest.artifactRoot, 'test-failure.json'), JSON.stringify({ status: result.status }));
  }
}
