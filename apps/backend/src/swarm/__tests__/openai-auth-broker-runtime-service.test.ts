import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempConfig, type TempConfigHandle } from '../../test-support/temp-config.js';
import type { AgentDescriptor } from '../types.js';
import { OpenAIAuthBrokerRuntimeService } from '../openai-auth/openai-auth-broker-runtime-service.js';

const handles: TempConfigHandle[] = []
const originalEnv = { ...process.env }

afterEach(async () => {
  process.env = { ...originalEnv }
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(handles.splice(0).map((handle) => handle.cleanup()))
})

describe('OpenAIAuthBrokerRuntimeService', () => {
  it('acquires a broker lease for openai-codex runtimes without persisting tokens to auth.json', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        leaseId: 'lease-runtime-1',
        credential: {
          type: 'oauth',
          access: 'leased-access-token',
          expires: 1_700_000_000_000,
          accountId: 'broker-account-1',
        },
      })))

    const handle = await makeHandle()
    await writeFile(
      join(handle.config.paths.sharedConfigDir, 'telemetry.json'),
      `${JSON.stringify({ installId: 'forge-telemetry-install-1', lastSuccessfulSendAt: null, lastFailedAttemptAt: null }, null, 2)}\n`,
      'utf8',
    )
    const service = new OpenAIAuthBrokerRuntimeService({ config: handle.config })
    const settingsService = new (await import('../openai-auth/openai-auth-settings-service.js')).OpenAIAuthSettingsService({
      config: handle.config,
    })
    await settingsService.updateSettings({
      mode: 'central_broker',
      broker: { url: 'https://broker.example.test', token: 'broker-token' },
    })

    const descriptor = makeDescriptor(handle.config.paths.dataDir)
    const prepared = await service.acquireForRuntime(descriptor)
    expect(prepared.handle.leaseId).toBe('lease-runtime-1')
    expect(prepared.authStorage.get('openai-codex')).toMatchObject({
      type: 'oauth',
      access: 'leased-access-token',
      accountId: 'broker-account-1',
    })
    const leaseBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    expect(leaseBody.client).toMatchObject({
      clientId: 'forge',
      forgeTelemetryInstallId: 'forge-telemetry-install-1',
    })
  })

  it('redacts broker usage detail strings before returning them for cache persistence', async () => {
    const brokerBearer = 'broker-secret-sentinel'
    const leakedOpenAIToken = 'sk-proj-' + 'a'.repeat(24)
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        accounts: [{
          available: false,
          error: `capacity exhausted for ${brokerBearer} and ${leakedOpenAIToken}`,
        }],
      })))

    const handle = await makeHandle()
    const service = new OpenAIAuthBrokerRuntimeService({ config: handle.config })
    const settingsService = new (await import('../openai-auth/openai-auth-settings-service.js')).OpenAIAuthSettingsService({
      config: handle.config,
    })
    await settingsService.updateSettings({
      mode: 'central_broker',
      broker: { url: 'https://broker.example.test', token: brokerBearer },
    })

    const snapshot = await service.fetchUsageSnapshot()
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain(brokerBearer)
    expect(serialized).not.toContain(leakedOpenAIToken)
    expect(snapshot).toEqual([{
      provider: 'openai',
      available: false,
      error: 'capacity exhausted for [redacted] and [redacted]',
    }])
  })
})

async function makeHandle(): Promise<TempConfigHandle> {
  const handle = await createTempConfig({ prefix: 'forge-openai-broker-runtime-' })
  handles.push(handle)
  return handle
}

function makeDescriptor(_dataDir: string): AgentDescriptor {
  return {
    agentId: 'agent-test-1',
    profileId: 'profile-test',
    managerId: 'manager-test',
    role: 'worker',
    status: 'idle',
    model: { provider: 'openai-codex', modelId: 'gpt-5.1-codex' },
    cwd: process.cwd(),
    sessionFile: '/tmp/session.jsonl',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}
