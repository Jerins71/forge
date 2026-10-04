import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { acquireRuntimeLock } from '../runtime-lock.js';
import { loadConfiguredSqliteDatabaseConstructor } from '../sqlite-database-loader.js';
import { getEnvironmentDbPath } from '../swarm/storage/data-paths.js';
import { recoverEnvironmentIdentity } from './identity.js';
import { migrateControlDatabase } from './control/migrations.js';
import { applyAccessMigrations } from './access/access-migrations.js';

export async function recoverLocalEnvironment(dataDir: string, action: string, previousDataDir?: string): Promise<void> {
  if (!['rekey', 'adopt', 'restore'].includes(action)) throw new Error('Invalid environment recovery action');
  const lock = acquireRuntimeLock(dataDir);
  try {
    const path = getEnvironmentDbPath(dataDir);
    await mkdir(dirname(path), { recursive: true });
    const Constructor = await loadConfiguredSqliteDatabaseConstructor();
    const database = new Constructor(path);
    try {
      database.pragma('journal_mode = WAL'); database.pragma('synchronous = FULL'); database.pragma('foreign_keys = ON');
      migrateControlDatabase(database, { environmentId: randomUUID(), streamEpoch: randomUUID() });
      applyAccessMigrations(database);
      await recoverEnvironmentIdentity({ dataDir, database, action: action as 'rekey' | 'adopt' | 'restore', previousDataDir });
    } finally { database.close(); }
  } finally { lock.release(); }
}
