import { describe, expect, it } from 'vitest'
import { checkMixedContent, formatPairingCode, isLoopbackBaseUrl, normalizeHostUrl, normalizePairingCode, parsePairingLink } from '../pairing-input.js'

const ENV = '0b5c7a7e-1d2f-4c3b-9a8e-112233445566'
const GRANT = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SECRET = 'A'.repeat(42) + 'b'

// Failure cases guarded: a credential in the query string (logged, sent as Referer) must never be
// accepted; a malformed link must not reach exchange; codes accept what humans type; HTTPS pages
// must report the HTTPS requirement instead of attempting mixed content.
describe('parsePairingLink', () => {
  it('reads the credential from the fragment only', () => {
    const parsed = parsePairingLink(`https://dev1.example/pair#v=1&environmentId=${ENV}&grantId=${GRANT}&secret=${SECRET}`)
    expect(parsed).toEqual({ ok: true, baseUrl: 'https://dev1.example', environmentId: ENV, credential: { kind: 'link', grantId: GRANT, secret: SECRET } })
  })

  it('keeps a path prefix in front of /pair', () => {
    const parsed = parsePairingLink(`https://proxy.example/forge/pair#v=1&environmentId=${ENV}&grantId=${GRANT}&secret=${SECRET}`)
    expect(parsed.ok && parsed.baseUrl).toBe('https://proxy.example/forge')
  })

  it('rejects a secret in the query string', () => {
    const parsed = parsePairingLink(`https://dev1.example/pair?secret=${SECRET}#v=1&environmentId=${ENV}&grantId=${GRANT}&secret=${SECRET}`)
    expect(parsed.ok).toBe(false)
  })

  it('rejects unknown versions and truncated secrets', () => {
    expect(parsePairingLink(`https://dev1.example/pair#v=2&environmentId=${ENV}&grantId=${GRANT}&secret=${SECRET}`).ok).toBe(false)
    expect(parsePairingLink(`https://dev1.example/pair#v=1&environmentId=${ENV}&grantId=${GRANT}&secret=abc`).ok).toBe(false)
    expect(parsePairingLink('not a url').ok).toBe(false)
  })
})

describe('pairing codes', () => {
  it('normalizes case, hyphens, spaces and Crockford look-alikes', () => {
    expect(normalizePairingCode('abcd-efgh-jk01')).toBe('ABCDEFGHJK01')
    expect(normalizePairingCode(' oiL1 2345 6789 ')).toBe('011123456789')
  })

  it('rejects wrong length and characters outside the alphabet', () => {
    expect(normalizePairingCode('ABCD-EFGH-JK0')).toBeNull()
    expect(normalizePairingCode('ABCD-EFGH-JKU1')).toBeNull()
  })

  it('formats as XXXX-XXXX-XXXX', () => {
    expect(formatPairingCode('ABCDEFGHJK01')).toBe('ABCD-EFGH-JK01')
  })
})

describe('host URLs and HTTPS requirement', () => {
  it('defaults a bare host to HTTPS and strips trailing slashes', () => {
    expect(normalizeHostUrl('dev1.tailnet.ts.net/')).toBe('https://dev1.tailnet.ts.net')
    expect(normalizeHostUrl('http://127.0.0.1:47187')).toBe('http://127.0.0.1:47187')
    expect(normalizeHostUrl('ftp://x')).toBeNull()
  })

  it('blocks plain HTTP remotes from an HTTPS page but allows loopback', () => {
    expect(checkMixedContent('https:', 'http://192.168.1.20:47187')).toMatch(/HTTPS/)
    expect(checkMixedContent('https:', 'http://localhost:47187')).toBeNull()
    expect(checkMixedContent('http:', 'http://192.168.1.20:47187')).toBeNull()
    expect(checkMixedContent(null, 'http://192.168.1.20:47187')).toBeNull()
  })
})

describe('isLoopbackBaseUrl', () => {
  it('flags addresses that only work on the machine itself', () => {
    for (const url of ['http://127.0.0.1:47187', 'http://localhost:47187', 'http://[::1]:47187', 'http://127.1.2.3']) expect(isLoopbackBaseUrl(url)).toBe(true)
    for (const url of ['https://dev1.tailnet.ts.net', 'https://192.168.1.20', 'not a url']) expect(isLoopbackBaseUrl(url)).toBe(false)
  })
})
