/** @vitest-environment jsdom */

/**
 * Package 5 write-isolation tests.
 *
 * Proves that builder writes stay local (credentials: same-origin, local
 * base URL).
 *
 * These complement Package 3's API-level migration tests by testing
 * additional write operations not previously covered.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

vi.mock('@/lib/api-endpoint', () => ({
  resolveApiEndpoint: (wsUrl: string, path: string) => {
    try {
      const parsed = new URL(wsUrl)
      parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
      return new URL(path, parsed.origin).toString()
    } catch {
      return path
    }
  },
}))

const {
  createBuilderSettingsApiClient,
} = await import('./settings-api-client')

/* ------------------------------------------------------------------ */
/*  Setup                                                             */
/* ------------------------------------------------------------------ */

const BUILDER_WS = 'ws://127.0.0.1:47187'

let fetchSpy: MockInstance

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function builderClient() {
  return createBuilderSettingsApiClient(BUILDER_WS)
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse({ ok: true }))
})

afterEach(() => {
  fetchSpy.mockRestore()
})

/* ================================================================== */
/*  Model override writes                                             */
/* ================================================================== */

describe('model override write isolation', () => {

  it('resetAllModelOverrides routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { resetAllModelOverrides } = await import('./models-api')

    await resetAllModelOverrides(builderClient())

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/model-overrides',
      expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' }),
    )
  })

  it('updateModelOverride routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { updateModelOverride } = await import('./models-api')

    await updateModelOverride(builderClient(), 'gpt-5', { enabled: true })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/model-overrides/gpt-5',
      expect.objectContaining({ method: 'PUT', credentials: 'same-origin' }),
    )
  })
})

/* ================================================================== */
/*  Slash command writes                                              */
/* ================================================================== */

describe('slash command write isolation', () => {

  it('updateSlashCommand routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({
      command: { id: '1', name: 'test', prompt: 'updated', createdAt: '', updatedAt: '' },
    }))
    const { updateSlashCommand } = await import('./slash-commands-api')

    await updateSlashCommand(builderClient(), '1', { prompt: 'updated' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/slash-commands/1',
      expect.objectContaining({ method: 'PUT', credentials: 'same-origin' }),
    )
  })

  it('createSlashCommand routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({
      command: { id: '2', name: 'new', prompt: 'hi', createdAt: '', updatedAt: '' },
    }))
    const { createSlashCommand } = await import('./slash-commands-api')

    await createSlashCommand(builderClient(), { name: 'new', prompt: 'hi' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/slash-commands',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    )
  })
})

/* ================================================================== */
/*  Env variable writes                                               */
/* ================================================================== */

describe('env variable write isolation', () => {

  it('updateSettingsEnvVariables routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { updateSettingsEnvVariables } = await import('./settings-api')

    await updateSettingsEnvVariables(builderClient(), { MY_KEY: 'secret' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/env',
      expect.objectContaining({ method: 'PUT', credentials: 'same-origin' }),
    )
  })

  it('deleteSettingsEnvVariable routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { deleteSettingsEnvVariable } = await import('./settings-api')

    await deleteSettingsEnvVariable(builderClient(), 'MY_KEY')

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/env/MY_KEY',
      expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' }),
    )
  })
})

/* ================================================================== */
/*  Specialist writes                                                 */
/* ================================================================== */

describe('specialist write isolation', () => {

  it('saveSpecialist routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { saveSpecialist } = await import('./specialists-api')

    await saveSpecialist(builderClient(), 'profile-1', 'backend', {
      displayName: 'Backend',
      color: '#2563eb',
      enabled: true,
      whenToUse: 'Backend work',
      modelId: 'gpt-5',
      provider: 'openai-codex',
      reasoningLevel: 'high',
      promptBody: 'You are a backend specialist.',
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/specialists/backend?profileId=profile-1&targetSpace=builder',
      expect.objectContaining({ method: 'PUT', credentials: 'same-origin' }),
    )
  })

  it('deleteSharedSpecialist routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { deleteSharedSpecialist } = await import('./specialists-api')

    await deleteSharedSpecialist(builderClient(), 'backend')

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/specialists/backend?targetSpace=builder',
      expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' }),
    )
  })

})

/* ================================================================== */
/*  Prompt writes                                                     */
/* ================================================================== */

describe('prompt write isolation', () => {

  it('savePromptOverride routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { savePromptOverride } = await import('./prompts/prompt-api')

    await savePromptOverride(builderClient(), 'archetype', 'default', 'new content', 'profile-1')

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('http://127.0.0.1:47187/api/prompts/archetype/default'),
      expect.objectContaining({ method: 'PUT', credentials: 'same-origin' }),
    )
  })

})

/* ================================================================== */
/*  Extensions fetch isolation                                        */
/* ================================================================== */

describe('extensions fetch isolation', () => {
  it('fetchSettingsExtensions routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ forgeExtensions: [], piExtensions: [] }))
    const { fetchSettingsExtensions } = await import('./settings-api')

    await fetchSettingsExtensions(builderClient())

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/extensions',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })
})

/* ================================================================== */
/*  Server version (About panel) fetch isolation                      */
/* ================================================================== */

describe('server version fetch isolation', () => {
  it('fetchServerVersion routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ system: { serverVersion: '2.0.0' } }))
    const { fetchServerVersion } = await import('./settings-api')

    const version = await fetchServerVersion(builderClient())

    expect(version).toBe('2.0.0')
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/stats?range=7d',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

})

/* ================================================================== */
/*  Model preset fetch isolation (Specialists)                        */
/* ================================================================== */

describe('model preset fetch isolation', () => {

  it('fetchModelPresets routes through builder with same-origin', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ models: [] }))
    const { fetchModelPresets } = await import('../../lib/model-preset')

    await fetchModelPresets(builderClient())

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/models',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('fetchModelPresets via a wsUrl-derived builder client hits the same-origin endpoint', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ models: [] }))
    const { fetchModelPresets } = await import('../../lib/model-preset')
    const { createBuilderSettingsApiClient } = await import('./settings-api-client')

    // Boundary adapter: a raw wsUrl becomes a target-aware builder client.
    await fetchModelPresets(createBuilderSettingsApiClient('ws://127.0.0.1:47187'))

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/models',
      expect.objectContaining({ cache: 'no-store' }),
    )
  })
})
