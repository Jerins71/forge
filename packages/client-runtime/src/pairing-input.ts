import type { PairingExchange } from '@forge/protocol/environment-v2'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SECRET = /^[A-Za-z0-9_-]{43}$/
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{12}$/

export type ParsedPairingLink =
  | { ok: true; baseUrl: string; environmentId: string; credential: Extract<PairingExchange['credential'], { kind: 'link' }> }
  | { ok: false; error: string }

const INVALID_LINK = 'This is not a valid Forge pairing link.'

/** Pairing links carry the credential only in the fragment, which never reaches a server. */
export function parsePairingLink(value: string): ParsedPairingLink {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return { ok: false, error: INVALID_LINK }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: INVALID_LINK }
  if (url.search) return { ok: false, error: 'Pairing links never carry credentials in the query string. Create a new link.' }
  const path = url.pathname.replace(/\/+$/, '')
  if (!path.endsWith('/pair')) return { ok: false, error: INVALID_LINK }

  const params = new URLSearchParams(url.hash.slice(1))
  const environmentId = params.get('environmentId') ?? ''
  const grantId = params.get('grantId') ?? ''
  const secret = params.get('secret') ?? ''
  if (params.get('v') !== '1' || !UUID.test(environmentId) || !UUID.test(grantId) || !SECRET.test(secret)) {
    return { ok: false, error: INVALID_LINK }
  }
  return {
    ok: true,
    baseUrl: `${url.origin}${path.slice(0, -'/pair'.length)}`,
    environmentId,
    credential: { kind: 'link', grantId, secret },
  }
}

/** Case-insensitive; hyphens/spaces ignored; Crockford look-alikes I/L→1 and O→0. */
export function normalizePairingCode(value: string): string | null {
  const code = value.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
  return CROCKFORD.test(code) ? code : null
}

export function formatPairingCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code
}

export function normalizeHostUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** An address that only works on the machine itself, so a link naming it cannot pair another device. */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname
    return LOOPBACK_HOSTS.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host)
  } catch {
    return false
  }
}

/**
 * A browser page served over HTTPS cannot reach a plain-HTTP remote (loopback is exempt). Desktop
 * passes `null` because its main-process transport is not subject to mixed-content rules.
 */
export function checkMixedContent(pageProtocol: string | null, baseUrl: string): string | null {
  if (pageProtocol !== 'https:') return null
  const url = new URL(baseUrl)
  if (url.protocol === 'https:' || LOOPBACK_HOSTS.has(url.hostname)) return null
  return 'This page is served over HTTPS, so the environment must also use HTTPS (LAN with TLS or Tailscale Serve).'
}
