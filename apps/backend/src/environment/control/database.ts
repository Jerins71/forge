import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { loadConfiguredSqliteDatabaseConstructor } from '../../sqlite-database-loader.js'
import { getEnvironmentDbPath } from '../../swarm/storage/data-paths.js'
import { migrateControlDatabase } from './migrations.js'
import type { EnvironmentControlService } from './command-service.js'
import type { EventSink } from './event-sink.js'
import type { EffectWorker } from './effect-worker.js'
import { createEventSink } from './event-sink.js'
import { createCommandService } from './command-service.js'
import { createEffectWorker } from './effect-worker.js'
import type { ControlCoreOptions } from './effect-types.js'

export interface ControlCore {
  database: Database
  controlService: EnvironmentControlService
  eventSink: EventSink
  effectWorker: EffectWorker
  reconcileOnBoot(): Promise<void>
  close(): Promise<void>
}
export async function createControlCore(options: ControlCoreOptions & { dataDir?: string }): Promise<ControlCore> {
  if (options.database && (options.databasePath || options.dataDir)) throw new Error('Supply a control database or its location, not both')
  let database: Database
  const owned = !options.database
  if (options.database) database = options.database
  else {
    const databasePath = options.databasePath ?? (options.dataDir ? getEnvironmentDbPath(options.dataDir) : undefined)
    if (!databasePath) throw new Error('Control databasePath, database, or dataDir is required')
    await mkdir(path.dirname(databasePath), { recursive: true })
    const Constructor = await loadConfiguredSqliteDatabaseConstructor()
    database = new Constructor(databasePath)
  }
  try {
    database.pragma('journal_mode = WAL')
    database.pragma('synchronous = FULL')
    database.pragma('foreign_keys = ON')
    database.pragma('busy_timeout = 5000')
    migrateControlDatabase(database, { environmentId: options.random(), streamEpoch: options.random() })
    const eventSink = createEventSink(database, options.clock, options.random)
    const controlService = createCommandService(eventSink, options)
    const effectWorker = createEffectWorker(eventSink, options)
    let closed = false
    return {
      database, controlService, eventSink, effectWorker,
      reconcileOnBoot: () => effectWorker.reconcileOnBoot(),
      async close() {
        if (closed) return
        closed = true
        controlService.close()
        await effectWorker.stop()
        eventSink.close()
        if (owned && database.open) database.close()
      },
    }
  } catch (error) {
    if (owned && database.open) database.close()
    throw error
  }
}
