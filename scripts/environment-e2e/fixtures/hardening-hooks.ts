import { readFileSync, writeFileSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { loadConfiguredSqliteDatabaseConstructor } from '../../../apps/backend/src/sqlite-database-loader.js';
import { getEnvironmentDbPath, getSessionMetaPath } from '../../../apps/backend/src/swarm/storage/data-paths.js';
import { AgentDescriptorStore } from '../../../apps/backend/src/swarm/agents/agent-descriptor-store.js';
import { SwarmManager } from '../../../apps/backend/src/swarm/swarm-manager.js';

export const crashBoundaries = ['pre-commit', 'post-commit', 'post-Git', 'post-meta', 'post-JSONL', 'post-dispatch-marker', 'post-provider-accept'] as const;
export type CrashBoundary = typeof crashBoundaries[number];
/** Instrument the real owners only inside the dedicated fixture child. No production endpoint or environment flag activates this code. */
export async function installHardeningHooks(dataDir: string, checkout: string) {
  const Constructor = await loadConfiguredSqliteDatabaseConstructor();
  const prototype = Constructor.prototype as Database;
  const databasePath = getEnvironmentDbPath(dataDir);
  const markerPath = join(checkout, '.fixture-crash.json');
  let armed: { commandId: string; boundary: CrashBoundary } | null = null;
  const hit = (boundary: CrashBoundary, commandId: string) => {
    if (!armed || armed.commandId !== commandId || armed.boundary !== boundary) return;
    writeFileSync(markerPath, JSON.stringify({ ...armed, pid: process.pid, reachedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
    const fd = openSync(markerPath, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    process.kill(process.pid, 'SIGKILL');
    throw new Error('Crash hook returned unexpectedly');
  };
  const originalTransaction = prototype.transaction;
  prototype.transaction = function (this: Database, fn: (...args: any[]) => any) {
    const database = this;
    const transaction = originalTransaction.call(database, (...args: any[]) => {
      const result = fn(...args);
      if (armed && database.name === databasePath && database.prepare('SELECT command_id FROM command_receipts WHERE command_id=? AND state=\'accepted\'').get(armed.commandId)) hit('pre-commit', armed.commandId);
      return result;
    });
    const wrap = (operation: (...args: any[]) => any) => (...args: any[]) => {
      const result = operation(...args);
      if (armed && database.name === databasePath && database.prepare('SELECT command_id FROM command_receipts WHERE command_id=? AND state=\'accepted\'').get(armed.commandId)) hit('post-commit', armed.commandId);
      return result;
    };
    return Object.assign(wrap(transaction), { deferred: wrap(transaction.deferred), immediate: wrap(transaction.immediate), exclusive: wrap(transaction.exclusive) });
  } as Database['transaction'];
  const originalPrepare = prototype.prepare;
  prototype.prepare = function (this: Database, sql: string) {
    const statement = originalPrepare.call(this, sql);
    if (this.name === databasePath && sql === "UPDATE workspace_reservations SET state='ready' WHERE command_id=?") {
      const run = statement.run.bind(statement) as (...args: any[]) => ReturnType<typeof statement.run>;
      statement.run = (...args: any[]) => { hit('post-Git', args[0]); return run(...args); };
    }
    return statement;
  } as Database['prepare'];
  const originalSave = AgentDescriptorStore.prototype.save;
  AgentDescriptorStore.prototype.save = async function () {
    if (armed?.boundary === 'post-meta') {
      const descriptor = this.snapshotForPersistence().agents.find(agent => agent.controlCommandId === armed!.commandId);
      if (descriptor) {
        const path = getSessionMetaPath(dataDir, descriptor.profileId!, descriptor.agentId);
        if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).controlCommandId === armed.commandId) hit('post-meta', armed.commandId);
      }
    }
    await originalSave.call(this);
  };
  const originalApply = SwarmManager.prototype.applyControlledInput;
  SwarmManager.prototype.applyControlledInput = function (text, input) {
    const control = input.controlledInput;
    return originalApply.call(this, text, { ...input, controlledInput: {
      ...control,
      onLocator(locator) { hit('post-JSONL', control.commandId); control.onLocator?.(locator); },
      async beforeDispatch() { const result = await control.beforeDispatch(); if (result === 'dispatch') hit('post-dispatch-marker', control.commandId); return result; },
      async onDispatchAccepted() { hit('post-provider-accept', control.commandId); await control.onDispatchAccepted(); },
    } });
  };
  return {
    arm(input: { commandId: string; boundary: CrashBoundary }) {
      if (!/^[0-9a-f-]{36}$/.test(input.commandId) || !crashBoundaries.includes(input.boundary)) throw new Error('Invalid controlled crash request');
      armed = input; return { armed: true, pid: process.pid };
    },
  };
}
