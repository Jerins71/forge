import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

/** Bundle the actual last protocol-1 client from the integrated pre-cutover commit.
 * Only source is recovered; credentials, dependency trees and host data are never copied. */
export async function loadV1Client(repositoryRoot: string, artifactRoot: string): Promise<any> {
  const exec = promisify(execFile);
  const root = join(artifactRoot, 'v1-client'); await mkdir(root, { recursive: true });
  const archive = await exec('git', ['archive', '5d7129ba', 'packages/client-runtime/src', 'packages/protocol/src', 'apps/ui/src/components/settings/environments/environment-status.ts'], { cwd: repositoryRoot, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  const archivePath = join(root, 'source.tar'); await writeFile(archivePath, archive.stdout);
  await exec('tar', ['-xf', archivePath, '-C', root], { cwd: repositoryRoot });
  const require = createRequire(join(repositoryRoot, 'packages/cli/package.json'));
  const { build } = require('esbuild');
  const output = join(root, 'runtime.mjs');
  const entry = join(root, 'entry.ts');
  await writeFile(entry, "export * from './packages/client-runtime/src/index.js'; export { describeEnvironmentStatus as describeOldEnvironmentStatus } from './apps/ui/src/components/settings/environments/environment-status.js';\n");
  await build({ entryPoints: [entry], outfile: output, bundle: true, format: 'esm', platform: 'node', target: 'node26', nodePaths: [join(repositoryRoot, 'packages/cli/node_modules'), join(repositoryRoot, 'packages/protocol/node_modules')], alias: { '@forge/protocol/environment-v2': join(root, 'packages/protocol/src/environment-v2.ts'), '@forge/protocol': join(root, 'packages/protocol/src/index.ts') } });
  return import(pathToFileURL(output).href);
}
