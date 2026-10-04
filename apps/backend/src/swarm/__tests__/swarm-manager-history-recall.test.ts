import { SessionManager } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { getHistoryRecallIndexPath } from '../storage/data-paths.js'
import { makeTempConfig, TestSwarmManager, bootWithDefaultManager } from '../../test-support/index.js'
import { buildSwarmTools } from '../swarm-tools.js'

describe('manager history recall integration', () => {
  it('indexes new-session native appends without a search clock and exposes session discovery after boot/restart', async () => {
    const config = await makeTempConfig({ prefix: 'history-autonomous-', omitSharedAuthFile: true, omitSharedSecretsFile: true })
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    let restarted: TestSwarmManager | undefined
    try {
      const { sessionAgent } = await manager.createSession('manager', { name: 'Autonomous recall' })
      const native = SessionManager.open(sessionAgent.sessionFile)
      native.appendMessage({ role: 'user', content: 'autonomouschartreuse evidence', timestamp: Date.now() })
      native.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Persisted.' }], timestamp: Date.now() } as any)
      // Read only the derived database: neither search nor sessions may drive catch-up.
      await expect.poll(() => {
        const db = new Database(getHistoryRecallIndexPath(config.paths.dataDir), { readonly: true })
        try { return (db.prepare("SELECT count(*) AS n FROM entry_payload WHERE text LIKE '%autonomouschartreuse%'").get() as { n: number }).n }
        finally { db.close() }
      }, { timeout: 5000 }).toBeGreaterThan(0)
      const tool = buildSwarmTools(manager, sessionAgent).find(entry => entry.name === 'history')!
      const found = await tool.execute('discover', { op: 'sessions', query: 'Autonomous' })
      expect(JSON.stringify(found)).toContain(sessionAgent.agentId)
      await manager.disposeHistoryRecall()
      restarted = new TestSwarmManager(config)
      await restarted.boot()
      const response = await restarted.searchHistory(sessionAgent.agentId, { query: 'autonomouschartreuse' })
      expect(response.coverage?.catalogHydration).toBe('complete')
      expect(response.results).toHaveLength(1)
    } finally {
      await manager.disposeHistoryRecall()
      await restarted?.disposeHistoryRecall()
    }
  })
})
