import { serveBackend } from './serve.js';
import type { CommandContext } from './types.js';
/** Recovery uses the ordinary backend's runtime-lock owner, not a second SQLite implementation in the CLI. */
export async function handleEnvironmentCommand(context: CommandContext): Promise<number> {
  const action = context.args.positionals[1];
  if (!['rekey', 'adopt', 'restore'].includes(action ?? '') || !context.args.options.dataDir) throw new Error('Usage: forge environment rekey|adopt|restore --data-dir <absolute-directory> [--backend-entry <absolute-file>]');
  if (action === 'adopt' && !context.args.options.fromDataDir) throw new Error('Adopt requires --from-data-dir <previous-absolute-directory>');
  return serveBackend({ backendEntry: context.args.options.backendEntry, dataDir: context.args.options.dataDir, recovery: action as 'rekey' | 'adopt' | 'restore', previousDataDir: context.args.options.fromDataDir, env: context.env });
}
/** One-time Forge 1 import, run by the backend under its runtime lock against a stopped data directory. */
export async function handleImportV1Command(context: CommandContext): Promise<number> {
  if (!context.args.options.dataDir) throw new Error('Usage: forge import-v1 --data-dir <absolute-directory> [--backend-entry <absolute-file>]');
  return serveBackend({ backendEntry: context.args.options.backendEntry, dataDir: context.args.options.dataDir, importV1: true, env: context.env });
}
