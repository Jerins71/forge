import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuthStorage } from '@earendil-works/pi-coding-agent'
import { getManagedModelProviderCredentialSummaries, resolveCursorSdkApiKey, SecretsEnvService } from '../swarm/secrets-env-service.js'
import type { SwarmConfig } from '../swarm/types.js'

interface TestPaths {
  sharedDir: string
  sharedAuthDir: string
  sharedAuthFile: string
  sharedSecretsFile: string
  authFile: string
  secretsFile: string
}

function buildPaths(root: string): TestPaths {
  const sharedDir = join(root, 'shared')
  const sharedAuthDir = join(sharedDir, 'config', 'auth')
  return {
    sharedDir,
    sharedAuthDir,
    sharedAuthFile: join(sharedAuthDir, 'auth.json'),
    sharedSecretsFile: join(sharedDir, 'config', 'secrets.json'),
    authFile: join(root, 'auth', 'auth.json'),
    secretsFile: join(root, 'secrets.json'),
  }
}

function createConfig(paths: TestPaths): SwarmConfig {
  return {
    paths: {
      sharedDir: paths.sharedDir,
      sharedAuthDir: paths.sharedAuthDir,
      sharedAuthFile: paths.sharedAuthFile,
      sharedSecretsFile: paths.sharedSecretsFile,
      authFile: paths.authFile,
      secretsFile: paths.secretsFile,
    },
  } as unknown as SwarmConfig
}

function createService(paths: TestPaths): SecretsEnvService {
  return new SecretsEnvService({
    config: createConfig(paths),
    ensureSkillMetadataLoaded: async () => undefined,
    getSkillMetadata: () => [],
  })
}

function makeOAuthCredential(accessToken = 'anthropic-oauth-token') {
  return {
    type: 'oauth',
    access: accessToken,
    refresh: 'refresh-token',
    expires: new Date(Date.now() + 60_000).toISOString(),
  } as any
}

describe('SecretsEnvService path migration', () => {
  it('reads legacy flat-root secrets when canonical secrets are missing, then writes to the canonical path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'secrets-env-service-legacy-secrets-'))
    const paths = buildPaths(root)

    const previousBrave = process.env.BRAVE_API_KEY
    const previousGemini = process.env.GEMINI_API_KEY
    delete process.env.BRAVE_API_KEY
    delete process.env.GEMINI_API_KEY

    try {
      await writeFile(
        paths.secretsFile,
        JSON.stringify({ BRAVE_API_KEY: 'legacy-brave-value' }, null, 2),
        'utf8',
      )

      const service = createService(paths)
      await service.loadSecretsStore()
      expect(process.env.BRAVE_API_KEY).toBe('legacy-brave-value')

      await service.updateSettingsEnv({ GEMINI_API_KEY: 'new-gemini-value' })

      const storedCanonicalSecrets = JSON.parse(
        await readFile(paths.sharedSecretsFile, 'utf8'),
      ) as Record<string, string>

      expect(storedCanonicalSecrets).toEqual({
        BRAVE_API_KEY: 'legacy-brave-value',
        GEMINI_API_KEY: 'new-gemini-value',
      })
    } finally {
      if (previousBrave === undefined) {
        delete process.env.BRAVE_API_KEY
      } else {
        process.env.BRAVE_API_KEY = previousBrave
      }

      if (previousGemini === undefined) {
        delete process.env.GEMINI_API_KEY
      } else {
        process.env.GEMINI_API_KEY = previousGemini
      }
    }
  })

  it('rejects setting an Anthropic API key while pooled Anthropic OAuth accounts exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'secrets-env-service-pooled-anthropic-'))
    const paths = buildPaths(root)
    const service = createService(paths)

    await mkdir(join(root, 'shared', 'config', 'auth'), { recursive: true })
    await service.getCredentialPoolService().addCredential('anthropic', makeOAuthCredential(), {
      label: 'Anthropic OAuth Account',
    })

    await expect(service.updateSettingsAuth({ anthropic: 'sk-ant-api-key' })).rejects.toThrow(
      'Remove pooled accounts before setting an API key',
    )

    const authStorage = AuthStorage.create(paths.sharedAuthFile)
    expect((authStorage.get('anthropic') as any)?.access).toBe('anthropic-oauth-token')

    const pool = await service.getCredentialPoolService().listPool('anthropic')
    expect(pool.credentials).toHaveLength(1)
  })

  it('keeps xAI in one credential slot while API key and OAuth saves replace each other', async () => {
    const root = await mkdtemp(join(tmpdir(), 'secrets-env-service-xai-single-slot-'))
    const paths = buildPaths(root)
    const service = createService(paths)

    await service.updateSettingsAuthCredential('xai', {
      type: 'oauth',
      access: 'xai-oauth-access',
      refresh: 'xai-oauth-refresh',
      expires: Date.now() + 60_000,
    } as any)
    await service.updateSettingsAuth({ xai: 'xai-api-key' })

    const authStorage = AuthStorage.create(paths.sharedAuthFile)
    expect(authStorage.get('xai')).toMatchObject({ type: 'api_key', key: 'xai-api-key' })

    await service.updateSettingsAuthCredential('xai', {
      type: 'oauth',
      access: 'replacement-oauth-access',
      refresh: 'replacement-oauth-refresh',
      expires: Date.now() + 60_000,
    } as any)

    expect(AuthStorage.create(paths.sharedAuthFile).get('xai')).toMatchObject({
      type: 'oauth',
      access: 'replacement-oauth-access',
      refresh: 'replacement-oauth-refresh',
    })
    await expect(service.getCredentialPoolService().listPool('xai')).rejects.toThrow(
      "Credential pooling is only supported for 'openai-codex', 'anthropic'",
    )
  })

  it('resolves Cursor SDK API keys from auth, secrets, then env without leaking secret values in errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'secrets-env-service-cursor-sdk-auth-'))
    const paths = buildPaths(root)
    const config = createConfig(paths)
    const previousCursor = process.env.CURSOR_API_KEY
    delete process.env.CURSOR_API_KEY

    try {
      await expect(resolveCursorSdkApiKey(config)).rejects.toThrow(
        'Cursor SDK auth not configured. Add Cursor SDK auth in Settings → Authentication.',
      )

      const missingError = await resolveCursorSdkApiKey(config).catch((error: unknown) => error)
      expect(missingError).toBeInstanceOf(Error)
      expect((missingError as Error).message).not.toContain('cursor-secret')

      process.env.CURSOR_API_KEY = 'cursor-env-secret-value'
      await expect(resolveCursorSdkApiKey(config)).resolves.toEqual({
        apiKey: 'cursor-env-secret-value',
        source: 'env',
      })

      await mkdir(join(root, 'shared', 'config'), { recursive: true })
      await writeFile(paths.sharedSecretsFile, JSON.stringify({ CURSOR_API_KEY: 'cursor-stored-secret-value' }), 'utf8')
      await expect(resolveCursorSdkApiKey(config)).resolves.toEqual({
        apiKey: 'cursor-stored-secret-value',
        source: 'secrets',
      })

      await mkdir(join(root, 'shared', 'config', 'auth'), { recursive: true })
      const sharedAuthStorage = AuthStorage.create(paths.sharedAuthFile)
      sharedAuthStorage.set('cursor-sdk', {
        type: 'api_key',
        key: 'cursor-auth-secret-value',
        access: 'cursor-auth-secret-value',
        refresh: '',
        expires: '',
      } as any)

      await expect(resolveCursorSdkApiKey(config)).resolves.toEqual({
        apiKey: 'cursor-auth-secret-value',
        source: 'auth_file',
      })

      const summaries = await getManagedModelProviderCredentialSummaries(config)
      expect(summaries.get('cursor-sdk')).toEqual({
        configured: true,
        authTypes: ['api_key'],
        sources: ['auth_file', 'secrets'],
      })
      expect(JSON.stringify([...summaries])).not.toContain('cursor-auth-secret-value')
      expect(JSON.stringify([...summaries])).not.toContain('cursor-stored-secret-value')
      expect(JSON.stringify([...summaries])).not.toContain('cursor-env-secret-value')
    } finally {
      if (previousCursor === undefined) {
        delete process.env.CURSOR_API_KEY
      } else {
        process.env.CURSOR_API_KEY = previousCursor
      }
    }
  })
})
