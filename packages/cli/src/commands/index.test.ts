import type { Writable } from 'node:stream'

import type { AgentDescriptor, CliSessionCompactionResult, CliSessionTranscriptResponse, CliStatusResponse, ManagerProfile } from '@forge/protocol'
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as cliConfig from '../config.js'

import type { ForgeClientLike } from '../forge-client.js'
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

describe('runCli', () => {

  it('runs with stable JSON output and mapped success exit code', async () => {
    const io = makeIo()
    const client = mockClient()
    const exit = await runCli(['run', '--profile', 'profile-1', '--message', 'hello', '--timeout', '1s', '--json'], {
      io,
      createClient: async () => client,
    })
    expect(exit).toBe(EXIT_CODES.success)
    expect(JSON.parse(io.stdout.toString())).toMatchObject({
      status: 'success',
      sessionAgentId: 'session-1',
      finalMessage: 'done',
      timedOut: false,
    })
  })

  it('requires --yes for destructive session commands before creating a client', async () => {
    const io = makeIo()
    let createdClient = false
    const exit = await runCli(['sessions', 'delete', 'session-1'], {
      io,
      createClient: async () => {
        createdClient = true
        return mockClient()
      },
    })
    expect(exit).toBe(EXIT_CODES.usage)
    expect(createdClient).toBe(false)
    expect(io.stderr.toString()).toContain('--yes')
  })
})

function makeIo(): { stdout: MemoryWritable & Writable; stderr: MemoryWritable & Writable } {
  return {
    stdout: new MemoryWritable() as MemoryWritable & Writable,
    stderr: new MemoryWritable() as MemoryWritable & Writable,
  }
}

function mockClient(overrides: { status?: CliStatusResponse } = {}): ForgeClientLike {
  const profile = profileFixture()
  const session = agentFixture('session-1', 'manager')
  const worker = agentFixture('worker-1', 'worker')
  const status = overrides.status ?? statusResponse()
  return {
    getStatus: async () => status,
    listProfiles: async () => ({ profiles: [profile] }),
    showProfile: async () => ({ profile }),
    listSessions: async () => ({ sessions: [session] }),
    showSession: async () => ({ session }),
    getSessionTranscript: async () => transcriptResponse(),
    listAgents: async () => ({ agents: [session, worker] }),
    showAgent: async () => ({ agent: worker }),
    listProjectAgents: async () => ({ projectAgents: [{ profileId: 'profile-1', agentId: 'session-1', handle: 'docs', whenToUse: 'Docs', displayName: 'Docs' }] }),
    showProjectAgent: async () => ({ projectAgent: { profileId: 'profile-1', agentId: 'session-1', handle: 'docs', whenToUse: 'Docs', displayName: 'Docs' } }),
    listChoices: async () => ({ choices: [{ choiceId: 'choice-1', agentId: 'worker-1', sessionAgentId: 'session-1', profileId: 'profile-1', status: 'pending', questionSummary: 'Pick one' }] }),
    showChoice: async () => ({ choice: { choiceId: 'choice-1', agentId: 'worker-1', sessionAgentId: 'session-1', profileId: 'profile-1', status: 'pending', questionSummary: 'Pick one' } }),
    createSession: async () => ({ session, profile, cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'sessions create', startedAt: '2026-05-11T00:00:00.000Z' } }),
    sendSessionMessage: async () => ({ sessionAgentId: 'session-1', profileId: 'profile-1', messageId: 'message-1', acceptedAt: '2026-05-11T00:00:00.000Z' }),
    sendProjectAgentMessage: async () => ({ sessionAgentId: 'session-1', profileId: 'profile-1', messageId: 'message-1', acceptedAt: '2026-05-11T00:00:00.000Z' }),
    launch: async () => ({ sessionAgentId: 'session-1', profileId: 'profile-1', messageId: 'message-1', acceptedAt: '2026-05-11T00:00:00.000Z' }),
    run: async () => ({ status: 'success', sessionAgentId: 'session-1', profileId: 'profile-1', projectAgentHandle: null, finalMessage: 'done', blocked: null, timedOut: false, durationMs: 123 }),
    waitForSession: async () => ({ status: 'success', sessionAgentId: 'session-1', profileId: 'profile-1', projectAgentHandle: null, finalMessage: 'done', blocked: null, timedOut: false, durationMs: 123 }),
    stopSession: async () => ({ agentId: 'session-1' }),
    resumeSession: async () => ({ agentId: 'session-1' }),
    clearSession: async () => ({ agentId: 'session-1' }),
    deleteSession: async () => ({ agentId: 'session-1' }),
    renameSession: async () => ({ agentId: 'session-1' }),
    pinSession: async () => ({ agentId: 'session-1' }),
    forkSession: async () => ({ sourceAgentId: 'session-1', session }),
    switchSessionModel: async () => ({ agentId: 'session-1' }),
    mergeBackSession: async () => ({ agentId: 'session-1', targetAgentId: 'session-0' }),
    getSessionLineage: async () => ({ threadId: 'session-1', lineage: null, transfers: [], handoffs: [] }),
    continueWorker: async () => ({ workerId: 'worker-1', sourceSessionAgentId: 'session-1', sessionAgentId: 'session-2' }),
    compactSession: async () => compactionResult({ action: 'compact', outcome: 'compacted', compacted: true }),
    smartCompactSession: async () => compactionResult({ action: 'smart_compact', outcome: 'compacted', compacted: true }),
    answerChoice: async () => ({ choiceId: 'choice-1', sessionAgentId: 'session-1', status: 'answered' }),
    cancelChoice: async () => ({ choiceId: 'choice-1', sessionAgentId: 'session-1', status: 'cancelled' }),
  }
}

function transcriptResponse(options: { includeWorkerUpdates?: boolean; limit?: number; offset?: number } = {}): CliSessionTranscriptResponse {
  const includeWorkerUpdates = options.includeWorkerUpdates ?? false
  const messages: CliSessionTranscriptResponse['messages'] = [
    {
      ordinal: 0,
      id: 'user-1',
      timestamp: '2026-05-11T00:00:00.000Z',
      kind: 'user',
      role: 'user',
      source: 'user_input',
      text: 'Hello',
      agentId: 'session-1',
    },
    {
      ordinal: 1,
      id: 'assistant-1',
      timestamp: '2026-05-11T00:00:01.000Z',
      kind: 'assistant',
      role: 'assistant',
      source: 'speak_to_user',
      text: 'Hi there',
      agentId: 'session-1',
    },
  ]
  if (includeWorkerUpdates) {
    messages.push({
      ordinal: 2,
      timestamp: '2026-05-11T00:00:02.000Z',
      kind: 'worker_update',
      role: 'worker',
      source: 'worker_update',
      text: 'Done with backend checks.',
      agentId: 'session-1',
      fromAgentId: 'worker-1',
      fromDisplayName: 'Backend Specialist',
      toAgentId: 'session-1',
    })
  }

  return {
    session: { agentId: 'session-1', profileId: 'profile-1', displayName: 'Session One' },
    options: {
      includeWorkerUpdates,
      limit: options.limit ?? 200,
      offset: options.offset ?? 0,
    },
    page: {
      total: messages.length,
      returned: messages.length,
      offset: options.offset ?? 0,
      limit: options.limit ?? 200,
      hasMore: false,
    },
    messages,
  }
}

function compactionResult(overrides: Partial<CliSessionCompactionResult> = {}): CliSessionCompactionResult {
  return {
    action: 'compact',
    sessionAgentId: 'session-1',
    profileId: 'profile-1',
    outcome: 'compacted',
    compacted: true,
    customInstructionsProvided: false,
    completedAt: '2026-05-11T00:00:00.000Z',
    ...overrides,
  }
}

function statusResponse(): CliStatusResponse {
  return {
    status: 'ok',
    serverTime: '2026-05-11T00:00:00.000Z',
    serverVersion: '0.9.0',
    runtimeTarget: 'builder',
    capabilities: {
      protocolVersion: 1,
      minCliVersion: '0.9.0',
      available: true,
      runtimeTarget: 'builder',
      features: {
        bearerAuth: true,
        headlessWs: true,
        cliSourceContext: true,
        cliSessionMetadata: true,
        choiceOwnerLookup: true,
        activeToolSnapshot: true,
        projectAgentRunTarget: true,
        sessionTranscript: true,
        sessionCompaction: true,
        builderRuntimeOnly: true,
      },
    },
    summary: { profileCount: 1, sessionCount: 1, agentCount: 2 },
  }
}

function profileFixture(): ManagerProfile {
  return {
    profileId: 'profile-1',
    displayName: 'Profile One',
    defaultSessionAgentId: 'session-1',
    defaultModel: { provider: 'openai', modelId: 'gpt-5.3', thinkingLevel: 'medium' },
    createdAt: '2026-05-11T00:00:00.000Z',
    updatedAt: '2026-05-11T00:00:00.000Z',
  }
}

function agentFixture(agentId: string, role: 'manager' | 'worker'): AgentDescriptor {
  return {
    agentId,
    managerId: role === 'manager' ? agentId : 'session-1',
    displayName: role === 'manager' ? 'Session One' : 'Worker One',
    role,
    status: 'idle',
    createdAt: '2026-05-11T00:00:00.000Z',
    updatedAt: '2026-05-11T00:00:00.000Z',
    cwd: '/tmp/project',
    model: { provider: 'openai', modelId: 'gpt-5.3', thinkingLevel: 'medium' },
    sessionFile: '/tmp/session.jsonl',
    profileId: 'profile-1',
  }
}


it.each(['flag', 'env', 'config'] as const)('rejects a %s URL override on full paired credentials before any network request', async source => {
  const root = await mkdtemp(join(tmpdir(), 'forge-cli-url-review-'))
  const file = join(root, 'credential.json')
  const baseUrl = 'http://127.0.0.1:40000'
  await writeFile(file, JSON.stringify({ deviceSessionId: '00000000-0000-4000-8000-000000000002', environmentId: '00000000-0000-4000-8000-000000000001', baseUrl, bearerToken: 'A'.repeat(43), deviceSession: { deviceSessionId: '00000000-0000-4000-8000-000000000002', deviceName: 'Synthetic CLI', kind: 'cli', scopes: ['session:read'], createdAt: '2026-10-10T00:00:00.000Z', expiresAt: '2027-10-10T00:00:00.000Z' } }), { mode: 0o600 })
  const other = 'http://127.0.0.1:40001'
  const resolve = source === 'config' ? vi.spyOn(cliConfig, 'resolveCliConfig').mockResolvedValue({ url: other, configPath: join(root, 'config.json'), sources: { url: 'config' } }) : undefined
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network must never be reached'))
  const io = makeIo()
  try {
    const exit = await runCli(['sessions', 'show', 'synthetic', '--json', '--credential-file', file, ...(source === 'flag' ? ['--url', other] : [])], { cwd: root, env: source === 'env' ? { FORGE_URL: other } : {}, io })
    expect(exit).toBe(EXIT_CODES.usage)
    expect(JSON.parse(io.stderr.toString())).toMatchObject({ error: { code: 'credential_url_mismatch', message: expect.stringContaining('paired credential') } })
    expect(fetchSpy).not.toHaveBeenCalled()
  } finally { resolve?.mockRestore(); fetchSpy.mockRestore(); await rm(root, { recursive: true, force: true }) }
})
