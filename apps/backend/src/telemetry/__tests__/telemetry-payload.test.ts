import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuthStorage } from '@earendil-works/pi-coding-agent'
import { extractAuthMethodsConfigured } from '../telemetry-payload.js'
import type { SwarmConfig } from '../../swarm/types.js'

describe('telemetry payload helpers', () => {

  it('extracts configured auth providers from auth storage and env-backed credentials without exposing secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telemetry-auth-providers-test-'))
    const sharedAuthFile = join(root, 'shared', 'config', 'auth', 'auth.json')
    const legacyAuthFile = join(root, 'auth', 'auth.json')
    const sharedSecretsFile = join(root, 'shared', 'config', 'secrets.json')
    const legacySecretsFile = join(root, 'secrets.json')

    await mkdir(join(root, 'shared', 'config', 'auth'), { recursive: true })

    const authStorage = AuthStorage.create(sharedAuthFile)
    authStorage.set('anthropic', {
      type: 'api_key',
      key: 'sk-ant-secret',
      access: 'sk-ant-secret',
      refresh: '',
      expires: '',
    } as any)
    authStorage.set('xai', {
      type: 'api_key',
      key: '',
      access: '',
      refresh: '',
      expires: '',
    } as any)

    const originalOpenAiApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-openai-secret'

    try {
      const config = {
        paths: {
          sharedDir: join(root, 'shared'),
          sharedAuthFile,
          authFile: legacyAuthFile,
          sharedSecretsFile,
          secretsFile: legacySecretsFile,
        },
      } as unknown as SwarmConfig

      expect(await extractAuthMethodsConfigured(config)).toEqual(['anthropic', 'openai-codex'])
    } finally {
      if (originalOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiApiKey
      }
    }
  })
})
