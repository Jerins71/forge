// Failure cases: a source point or model flag is dropped or mistyped on its way to the RPC;
// human and JSON output disagree about the new conversation identity; merge-back runs on a
// session with no parent; an environment without contextTransfers looks like a success.
import type { Writable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { lineageSnapshotFixture, startFixtureServer } from '../../../client-runtime/src/__tests__/fixture-server.js'
import { ForgeClient, type ForgeClientLike } from '../forge-client.js'
import { CliError } from '../output.js'
import { EXIT_CODES } from '../version.js'
import { runCli } from './index.js'

class MemoryWritable implements Partial<Writable> {
  chunks: string[] = []
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk))
    return true
  }
  toString(): string {
    return this.chunks.join('')
  }
}
function makeIo() {
  return { stdout: new MemoryWritable() as MemoryWritable & Writable, stderr: new MemoryWritable() as MemoryWritable & Writable }
}
/** Only the named methods exist; any other client call fails the test. */
function clientWith(methods: Partial<ForgeClientLike>): { client: ForgeClientLike; calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const client = new Proxy({}, {
    // Not thenable: an async factory resolves to the client itself.
    get: (_target, method: string) => method === 'then' ? undefined : (...args: unknown[]) => {
      calls.push({ method, args })
      const implementation = (methods as Record<string, ((...a: unknown[]) => unknown) | undefined>)[method]
      if (!implementation) throw new Error(`Unexpected client call ${method}`)
      return implementation(...args)
    },
  }) as ForgeClientLike
  return { client, calls }
}
async function run(argv: string[], methods: Partial<ForgeClientLike>) {
  const io = makeIo()
  const { client, calls } = clientWith(methods)
  let created = 0
  const exit = await runCli(argv, { io, createClient: async () => { created += 1; return client } })
  return { exit, stdout: io.stdout.toString(), stderr: io.stderr.toString(), calls, created }
}
const model = { provider: 'claude-native', modelId: 'claude-opus-5-5' }

describe('forge sessions fork', () => {
  const forked = { sourceAgentId: 'session-1', session: { agentId: 'fork-1' } }
  it('passes the source point and model and reports the new session in JSON', async () => {
    const result = await run(['sessions', 'fork', 'session-1', '--label', 'Try Claude', '--source', 'message:entry-42', '--model', 'claude-native/claude-opus-5-5', '--reasoning', 'high', '--json'], { forkSession: async () => forked })
    expect(result.exit).toBe(EXIT_CODES.success)
    expect(result.calls).toEqual([{ method: 'forkSession', args: ['session-1', { label: 'Try Claude', fromMessageId: undefined, sourcePoint: { kind: 'message', entryId: 'entry-42' }, model: { ...model, thinkingLevel: 'high' } }] }])
    expect(JSON.parse(result.stdout)).toEqual({ status: 'ok', action: 'fork', agentId: 'session-1', label: 'Try Claude', sourcePoint: { kind: 'message', entryId: 'entry-42' }, model: { ...model, thinkingLevel: 'high' }, result: forked })
  })
  it.each([
    ['latest', { kind: 'latest_stable' }],
    ['run:run-7', { kind: 'run', runId: 'run-7' }],
    ['message:entry-42', { kind: 'message', entryId: 'entry-42' }],
  ])('parses --source %s', async (source, sourcePoint) => {
    const result = await run(['sessions', 'fork', 'session-1', '--source', source], { forkSession: async () => forked })
    expect(result.calls[0]!.args[1]).toMatchObject({ sourcePoint })
    expect(result.stdout).toBe(`status       ok\naction       fork\nagentId      session-1\nsourcePoint  ${JSON.stringify(sourcePoint)}\n`)
  })
  it('keeps the plain fork output unchanged', async () => {
    const result = await run(['sessions', 'fork', 'session-1', '--from-message-id', 'item-1'], { forkSession: async () => forked })
    expect(result.calls).toEqual([{ method: 'forkSession', args: ['session-1', { label: undefined, fromMessageId: 'item-1' }] }])
    expect(result.stdout).toBe('status         ok\naction         fork\nagentId        session-1\nfromMessageId  item-1\n')
  })
  it.each([
    [['--source', 'yesterday'], '--source'],
    [['--source', 'run:'], '--source'],
    [['--model', 'claude-opus-5-5'], '--model'],
    [['--reasoning', 'high'], '--reasoning'],
  ])('rejects %j before creating a client', async (flags, named) => {
    const result = await run(['sessions', 'fork', 'session-1', ...flags], {})
    expect(result.exit).toBe(EXIT_CODES.usage)
    expect(result.created).toBe(0)
    expect(result.stderr).toContain(named)
  })
})

describe('forge sessions switch', () => {
  it('hands the session off to the selected model', async () => {
    const result = await run(['sessions', 'switch', 'session-1', '--model', 'claude-native/claude-opus-5-5'], { switchSessionModel: async () => ({ agentId: 'session-1', model }) })
    expect(result.exit).toBe(EXIT_CODES.success)
    expect(result.calls).toEqual([{ method: 'switchSessionModel', args: ['session-1', model] }])
    expect(result.stdout).toBe(`status   ok\naction   switch\nagentId  session-1\nmodel    ${JSON.stringify(model)}\n`)
  })
  it('reports the receipt-derived result in JSON', async () => {
    const result = await run(['sessions', 'switch', 'session-1', '--model', 'claude-native/claude-opus-5-5', '--json'], { switchSessionModel: async () => ({ agentId: 'session-1', model }) })
    expect(JSON.parse(result.stdout)).toEqual({ status: 'ok', action: 'switch', agentId: 'session-1', model, result: { agentId: 'session-1', model } })
  })
  it('requires --model before creating a client', async () => {
    const result = await run(['sessions', 'switch', 'session-1'], {})
    expect(result).toMatchObject({ exit: EXIT_CODES.usage, created: 0 })
    expect(result.stderr).toContain('--model')
  })
  it('reports an environment without context transfers as unsupported, never as success', async () => {
    const result = await run(['sessions', 'switch', 'session-1', '--model', 'claude-native/claude-opus-5-5', '--json'], {
      switchSessionModel: async () => { throw new CliError('Update this environment to transfer context between conversations', { exitCode: EXIT_CODES.unsupported, code: 'PROTOCOL_MISMATCH' }) },
    })
    expect(result.exit).toBe(EXIT_CODES.unsupported)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'PROTOCOL_MISMATCH', message: 'Update this environment to transfer context between conversations' } })
  })
})

describe('forge sessions merge-back', () => {
  it('merges into the lineage parent and names it', async () => {
    const result = await run(['sessions', 'merge-back', 'fork-1', '--source', 'latest'], { mergeBackSession: async () => ({ agentId: 'fork-1', targetAgentId: 'session-1' }) })
    expect(result.calls).toEqual([{ method: 'mergeBackSession', args: ['fork-1', { sourcePoint: { kind: 'latest_stable' } }] }])
    expect(result.stdout).toBe('status         ok\naction         merge-back\nagentId        fork-1\ntargetAgentId  session-1\nsourcePoint    {"kind":"latest_stable"}\n')
  })
  it('emits the same identities in JSON', async () => {
    const result = await run(['sessions', 'merge-back', 'fork-1', '--json'], { mergeBackSession: async () => ({ agentId: 'fork-1', targetAgentId: 'session-1' }) })
    expect(result.calls).toEqual([{ method: 'mergeBackSession', args: ['fork-1', {}] }])
    expect(JSON.parse(result.stdout)).toEqual({ status: 'ok', action: 'merge-back', agentId: 'fork-1', targetAgentId: 'session-1', result: { agentId: 'fork-1', targetAgentId: 'session-1' } })
  })
})

describe('forge sessions lineage', () => {
  it('emits the lineage snapshot unchanged in JSON', async () => {
    const result = await run(['sessions', 'lineage', 'session-1', '--json'], { getSessionLineage: async () => lineageSnapshotFixture() })
    expect(result.exit).toBe(EXIT_CODES.success)
    expect(JSON.parse(result.stdout)).toEqual(lineageSnapshotFixture())
  })
  it('summarises parent, base point and handoff coverage for people', async () => {
    const result = await run(['sessions', 'lineage', 'session-1'], { getSessionLineage: async () => lineageSnapshotFixture() })
    expect(result.stdout).toBe([
      'session       session-1',
      'relationship  fork',
      'parent        parent-session',
      'root          parent-session',
      'basePoint     parent-session@42 (entry-42)',
      '',
      'TRANSFER         KIND             STRATEGY          STATE     PROVIDERS                      INCLUDED  OMITTED  TRUNCATED  BUDGET',
      '---------------  ---------------  ----------------  --------  -----------------------------  --------  -------  ---------  -----------------------------',
      'transfer-switch  provider_switch  portable_context  resolved  codex-native -> claude-native  2/4       1        1          120000/120000 chars truncated',
      'transfer-fork    fork             native_fork       consumed',
      '',
    ].join('\n'))
  })
  it('shows a typed transfer failure and a session with no lineage', async () => {
    const result = await run(['sessions', 'lineage', 'session-1'], { getSessionLineage: async () => ({
      threadId: 'session-1', lineage: null, handoffs: [],
      transfers: [{ transferId: 't1', kind: 'provider_switch' as const, source: { threadId: 'session-1', sequence: 3 }, targetThreadId: 'session-1', strategy: 'unresolved' as const, state: 'failed' as const, createdAt: 1, error: { code: 'UNSUPPORTED' as const, message: 'cursor does not accept portable context' } }],
    }) })
    expect(result.stdout).toContain('relationship  none')
    expect(result.stdout).toContain('failed: UNSUPPORTED cursor does not accept portable context')
  })
})

describe('forge workers continue', () => {
  it('continues a finished worker as a conversation and reports the new session', async () => {
    const continued = { workerId: 'worker-1', sourceSessionAgentId: 'session-1', sessionAgentId: 'continued-session' }
    const human = await run(['workers', 'continue', 'worker-1', '--label', 'Carry on'], { continueWorker: async () => continued })
    expect(human.calls).toEqual([{ method: 'continueWorker', args: ['worker-1', { sessionAgentId: undefined, label: 'Carry on' }] }])
    expect(human.stdout).toBe('status          ok\naction          continue\nworkerId        worker-1\nsessionAgentId  continued-session\nlabel           Carry on\n')
    const json = await run(['workers', 'continue', 'worker-1', '--session', 'session-1', '--json'], { continueWorker: async () => continued })
    expect(json.calls[0]!.args).toEqual(['worker-1', { sessionAgentId: 'session-1', label: undefined }])
    expect(JSON.parse(json.stdout)).toEqual({ status: 'ok', action: 'continue', workerId: 'worker-1', sessionAgentId: 'continued-session', result: continued })
  })
  it('requires a worker and a known action', async () => {
    expect(await run(['workers', 'continue'], {})).toMatchObject({ exit: EXIT_CODES.usage, created: 0 })
    const unknown = await run(['workers', 'pause', 'worker-1'], {})
    expect(unknown).toMatchObject({ exit: EXIT_CODES.usage, created: 0 })
    expect(unknown.stderr).toContain('forge workers continue')
  })
})

describe('ForgeClient context transfers over the paired transport', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
  async function paired(contextTransfers = true) {
    const server = await startFixtureServer(0)
    cleanups.push(() => server.close())
    Object.assign(server.seed.descriptor.capabilities, { cliTransport: true, contextTransfers })
    const agent = (agentId: string, managerId = agentId) => ({ agentId, managerId, profileId: 'forge', displayName: agentId })
    const client = new ForgeClient({
      credential: { environmentId: server.seed.entry.environmentId, baseUrl: server.seed.entry.baseUrl, bearerToken: 'B'.repeat(43), deviceSessionId: server.seed.entry.environmentId },
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname
        if (path.startsWith('/api/cli/sessions/')) return Response.json({ session: agent(decodeURIComponent(path.split('/').at(-1)!)) })
        if (path.startsWith('/api/cli/agents/')) return Response.json({ agent: agent(decodeURIComponent(path.split('/').at(-1)!), 'session-1') })
        if (path.startsWith('/api/cli/profiles/')) return Response.json({ profile: { profileId: 'forge' } })
        return fetch(url, init)
      },
    })
    const inputs = (method: string) => server.inputs.filter(entry => entry.method === method).map(entry => entry.input as Record<string, unknown>)
    return { server, client, inputs }
  }
  const uuid = expect.stringMatching(/^[0-9a-f-]{36}$/)

  it('sends each transfer as one typed receipt-backed command', async () => {
    const { server, client, inputs } = await paired()
    server.seed.details!['session-1'].lineage = lineageSnapshotFixture()

    await client.forkSession('session-1', { label: 'Fork', sourcePoint: { kind: 'run', runId: 'run-7' }, model })
    expect(inputs('session.fork')).toEqual([{ commandId: uuid, sessionId: 'session-1', title: 'Fork', sourcePoint: { kind: 'run', runId: 'run-7' }, model }])

    await expect(client.switchSessionModel('session-1', model)).resolves.toEqual({ agentId: 'session-1', model })
    expect(inputs('session.provider.switch')).toEqual([{ commandId: uuid, sessionId: 'session-1', model }])

    await expect(client.mergeBackSession('session-1', { sourcePoint: { kind: 'latest_stable' } })).resolves.toEqual({ agentId: 'session-1', targetAgentId: 'parent-session' })
    expect(inputs('session.mergeBack')).toEqual([{ commandId: uuid, sessionId: 'session-1', sourcePoint: { kind: 'latest_stable' } }])

    // The owning session is resolved from the worker; the new conversation comes from the receipt.
    await expect(client.continueWorker('worker-1', { label: 'Carry on' })).resolves.toEqual({ workerId: 'worker-1', sourceSessionAgentId: 'session-1', sessionAgentId: 'continued-session' })
    expect(inputs('worker.continue')).toEqual([{ commandId: uuid, sessionId: 'session-1', workerId: 'worker-1', title: 'Carry on' }])

    await expect(client.getSessionLineage('session-1')).resolves.toEqual(lineageSnapshotFixture())
  })

  it('refuses to merge back a session with no lineage parent without writing', async () => {
    const { client, inputs } = await paired()
    await expect(client.mergeBackSession('session-1')).rejects.toMatchObject({ code: 'no_lineage_parent', exitCode: EXIT_CODES.usage })
    expect(inputs('session.mergeBack')).toEqual([])
  })

  it('maps a missing contextTransfers capability to the unsupported exit code without writing', async () => {
    const { client, inputs } = await paired(false)
    await expect(client.switchSessionModel('session-1', model)).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH', exitCode: EXIT_CODES.unsupported, message: 'Update this environment to transfer context between conversations' })
    await expect(client.continueWorker('worker-1')).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH', exitCode: EXIT_CODES.unsupported })
    await expect(client.getSessionLineage('session-1')).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH', exitCode: EXIT_CODES.unsupported })
    expect(inputs('session.provider.switch')).toEqual([])
    expect(inputs('worker.continue')).toEqual([])
  })
})
