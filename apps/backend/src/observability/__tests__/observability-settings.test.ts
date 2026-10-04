import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getPhoenixObservabilitySettingsPath } from '../../swarm/data-paths.js'
import { PhoenixObservabilitySettingsService, validatePhoenixEndpoint } from '../observability-settings.js'

describe('PhoenixObservabilitySettingsService', () => {

  it('sanitizes invalid persisted endpoints without echoing token-bearing URLs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-phoenix-settings-'))
    const settingsPath = getPhoenixObservabilitySettingsPath(dataDir)
    await mkdir(dirname(settingsPath), { recursive: true })
    await writeFile(settingsPath, JSON.stringify({
      enabled: true,
      endpoint: 'http://127.0.0.1:6006/v1/traces?token=secret',
      projectName: 'persisted-project',
    }), 'utf8')
    const service = new PhoenixObservabilitySettingsService(dataDir)

    const settings = await service.getSettings()

    expect(settings.enabled).toBe(false)
    expect(settings.endpoint).toBe('http://127.0.0.1:6006/v1/traces')
    expect(JSON.stringify(settings)).not.toContain('token=secret')
    expect(settings.projectName).toBe('persisted-project')
  })

  it('persists normalized non-secret settings', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-phoenix-settings-'))
    const service = new PhoenixObservabilitySettingsService(dataDir)

    const updated = await service.updateSettings({
      enabled: true,
      endpoint: 'http://localhost:16006/v1/traces',
      projectName: 'my-local-project',
      privacy: { extraRedactionPatterns: ['secret-[0-9]+'] },
    })

    expect(updated.enabled).toBe(true)
    expect(updated.projectName).toBe('my-local-project')
    const raw = await readFile(getPhoenixObservabilitySettingsPath(dataDir), 'utf8')
    expect(raw).toContain('my-local-project')
    expect(raw).not.toMatch(/apiKey|authorization|headers/i)
  })
})

describe('validatePhoenixEndpoint', () => {

  it('rejects remote, private/LAN, https, credentialed, and wrong-path endpoints', () => {
    for (const endpoint of [
      'https://127.0.0.1:6006/v1/traces',
      'http://192.168.1.5:6006/v1/traces',
      'http://10.0.0.1:6006/v1/traces',
      'http://example.com:6006/v1/traces',
      'http://user:pass@127.0.0.1:6006/v1/traces',
      'http://127.0.0.1:6006/v1/traces?token=secret',
      'http://127.0.0.1:6006/v1/traces#token',
      'http://127.0.0.1:6006/',
    ]) {
      expect(() => validatePhoenixEndpoint(endpoint), endpoint).toThrow()
    }
  })
})
