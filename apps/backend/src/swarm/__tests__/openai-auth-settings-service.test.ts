import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempConfig, type TempConfigHandle } from '../../test-support/temp-config.js';
import { LEGACY_OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY, OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY, OpenAIAuthSettingsService } from '../openai-auth/openai-auth-settings-service.js';

const handles: TempConfigHandle[] = []
const originalEnv = { ...process.env }

afterEach(async () => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
  await Promise.all(handles.splice(0).map((handle) => handle.cleanup()))
})

describe('OpenAIAuthSettingsService', () => {
  it('stores non-secret broker config separately from the broker token and never echoes the token', async () => {
    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })

    const response = await service.updateSettings({
      mode: 'local',
      broker: {
        url: 'https://broker.example.test',
        token: 'broker-bearer-secret',
        clientId: 'forge-test',
        userLabel: 'Adam',
      },
    })

    expect(JSON.stringify(response)).not.toContain('broker-bearer-secret')
    expect(response.settings).toMatchObject({
      mode: 'local',
      effectiveMode: 'local',
      broker: {
        configured: true,
        url: 'https://broker.example.test/',
        hasToken: true,
        tokenMasked: '********cret',
        clientId: 'forge-test',
        userLabel: 'Adam',
      },
    })

    const configRaw = await readFile(join(handle.config.paths.sharedAuthDir, 'openai-codex-auth-source.json'), 'utf8')
    const secretsRaw = await readFile(handle.config.paths.sharedSecretsFile, 'utf8')
    expect(configRaw).toContain('https://broker.example.test/')
    expect(configRaw).not.toContain('broker-bearer-secret')
    const storedSecrets = JSON.parse(secretsRaw)
    expect(storedSecrets).toMatchObject({ [OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY]: 'broker-bearer-secret' })
    expect(storedSecrets).not.toHaveProperty(LEGACY_OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY)
  })

  it('does not fall back to saved broker URL or token when env central mode omits them', async () => {
    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })
    await service.updateSettings({
      mode: 'local',
      broker: { url: 'https://saved-broker.example.test', token: 'saved-broker-token' },
    })

    process.env.FORGE_OPENAI_CODEX_AUTH_MODE = 'central_broker'
    delete process.env.FORGE_OPENAI_AUTH_BROKER_URL
    delete process.env.FORGE_OPENAI_AUTH_BROKER_TOKEN

    const state = await service.getSettingsState()
    expect(state).toMatchObject({
      mode: 'local',
      effectiveMode: 'central_broker',
      source: 'env',
      envOverride: true,
      broker: {
        configured: false,
        hasToken: false,
        clientId: 'forge',
        timeoutMs: 10000,
      },
    })
    expect(state.broker.url).toBeUndefined()
    expect(state.broker.tokenMasked).toBeUndefined()
    await expect(service.testSettings()).resolves.toMatchObject({
      ok: false,
      error: 'Forge Auth broker URL and token are required before testing OpenAI/Codex auth.',
    })
  })

  it('redacts exact broker bearer tokens and OpenAI-looking tokens from status responses, cached status, and enable errors', async () => {
    const brokerBearer = 'broker-secret-sentinel'
    const openAILookingToken = 'sk-proj-abcdefghijklmnopqrstuvwxyz'
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      ok: false,
      degraded: 'invalid_bearer',
      message: `broker echoed ${brokerBearer} and ${openAILookingToken}`,
    })))

    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })
    await service.updateSettings({
      mode: 'local',
      broker: { url: 'https://broker.example.test', token: brokerBearer },
    })

    const testResult = await service.testSettings()
    expect(testResult.ok).toBe(false)
    expect(JSON.stringify(testResult)).not.toContain(brokerBearer)
    expect(JSON.stringify(testResult)).not.toContain(openAILookingToken)

    const cachedState = await service.getSettingsState()
    expect(JSON.stringify(cachedState)).not.toContain(brokerBearer)
    expect(JSON.stringify(cachedState)).not.toContain(openAILookingToken)
    const configRaw = await readFile(join(handle.config.paths.sharedAuthDir, 'openai-codex-auth-source.json'), 'utf8')
    expect(configRaw).not.toContain(brokerBearer)
    expect(configRaw).not.toContain(openAILookingToken)

    let enableError: unknown
    try {
      await service.updateSettings({ mode: 'central_broker' })
    } catch (error) {
      enableError = error
    }
    expect(enableError).toBeInstanceOf(Error)
    const enableErrorMessage = enableError instanceof Error ? enableError.message : String(enableError)
    expect(enableErrorMessage).toContain('[redacted]')
    expect(enableErrorMessage).not.toContain(brokerBearer)
    expect(enableErrorMessage).not.toContain(openAILookingToken)
    await expect(service.getSettingsState()).resolves.toMatchObject({ mode: 'local', effectiveMode: 'local' })
  })
})

async function makeHandle(): Promise<TempConfigHandle> {
  const handle = await createTempConfig({ prefix: 'forge-openai-broker-settings-' })
  handles.push(handle)
  return handle
}
