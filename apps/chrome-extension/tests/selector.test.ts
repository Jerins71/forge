import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { loadVerifiedPayloadSelector, parsePayloadSelector } from '../src/shell/selector.js'

const hash = 'a'.repeat(64)
const payloadFiles = { 'content-script.js': hash, 'service-worker.js': hash }

describe('versioned local payload selector', () => {

  it.each([
    { schemaVersion: 1, shellAbi: 2, payloadVersion: 'm1', payloadSha256: hash, payloadDirectory: `m1-${hash}`, payloadFiles },
    { schemaVersion: 1, shellAbi: 1, payloadVersion: '../escape', payloadSha256: hash, payloadDirectory: `../escape-${hash}`, payloadFiles },
    { schemaVersion: 1, shellAbi: 1, payloadVersion: 'm1', payloadSha256: 'bad', payloadDirectory: 'm1-bad', payloadFiles },
    { schemaVersion: 1, shellAbi: 1, payloadVersion: 'm1', payloadSha256: hash, payloadDirectory: `other-${hash}`, payloadFiles },
    { schemaVersion: 1, shellAbi: 1, payloadVersion: 'm1', payloadSha256: hash, payloadDirectory: `m1-${hash}`, payloadFiles: { ...payloadFiles, 'unexpected.js': hash } },
  ])('rejects malformed or path-escaping selector %#', (selector) => {
    expect(() => parsePayloadSelector(selector)).toThrow()
  })

  it('returns only after every declared payload file hash verifies', async () => {
    const bytes = new TextEncoder().encode('verified payload')
    const goodHash = createHash('sha256').update(bytes).digest('hex')
    const selector = {
      schemaVersion: 1, shellAbi: 1, payloadVersion: 'm1', payloadSha256: hash, payloadDirectory: `m1-${hash}`,
      payloadFiles: { 'content-script.js': goodHash, 'service-worker.js': goodHash },
    }
    const fetched: string[] = []
    const fetchValue = async (url: string | URL | Request): Promise<Response> => {
      fetched.push(String(url))
      return String(url).endsWith('current.json') ? new Response(JSON.stringify(selector)) : new Response(bytes)
    }
    await expect(loadVerifiedPayloadSelector((path) => `chrome-extension://fixture/${path}`, 'service-worker.js', fetchValue as typeof fetch)).resolves.toEqual(selector)
    expect(fetched.filter((url) => url.includes('/payloads/'))).toHaveLength(2)
  })
})
