import { Value } from '@sinclair/typebox/value'
import {
  EnvironmentDescriptorSchema,
  PairingChallengeSchema,
  PairingExchangeResultSchema,
  ENVIRONMENT_PROTOCOL_VERSION,
  type PairingExchange,
  type PairingExchangeResult,
  type EnvironmentDescriptor,
} from '@forge/protocol/environment-v2'
import type { PairingInput } from './types.js'
import type { RuntimePorts } from './ports.js'
import { normalizeBaseUrl } from './connection/authenticated-http.js'
import { EnvironmentRuntimeError } from './errors.js'
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`
  return JSON.stringify(value)
}
function base64url(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}
export async function pairEnvironment(
  ports: RuntimePorts,
  input: PairingInput,
): Promise<PairingExchangeResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  if (ports.clientOrigin?.startsWith('https:') && baseUrl.startsWith('http:'))
    throw new EnvironmentRuntimeError(
      'UNAVAILABLE',
      'HTTPS is required',
      false,
      undefined,
      'https-required',
    )
  const descriptorResponse = await ports.fetch(
    `${baseUrl}/api/v2/environment`,
    { redirect: 'error', credentials: 'omit', cache: 'no-store' },
  )
  const descriptor = (await descriptorResponse.json()) as EnvironmentDescriptor
  if (
    !descriptorResponse.ok ||
    !Value.Check(EnvironmentDescriptorSchema, descriptor)
  )
    throw new EnvironmentRuntimeError(
      'UNAVAILABLE',
      'Environment is unavailable',
      true,
    )
  if (descriptor.protocolVersion !== ENVIRONMENT_PROTOCOL_VERSION)
    throw new EnvironmentRuntimeError(
      'PROTOCOL_MISMATCH',
      'Environment protocol differs',
    )
  if (
    input.expectedEnvironmentId &&
    input.expectedEnvironmentId !== descriptor.environmentId
  )
    throw new EnvironmentRuntimeError(
      'IDENTITY_MISMATCH',
      'Environment identity changed',
    )
  if (ports.platform) {
    const result = await ports.platform.pair({
      ...input,
      baseUrl,
      expectedEnvironmentId: descriptor.environmentId,
    })
    if (
      !Value.Check(PairingExchangeResultSchema, result) ||
      result.environment.environmentId !== descriptor.environmentId ||
      result.environment.protocolVersion !== ENVIRONMENT_PROTOCOL_VERSION
    )
      throw new EnvironmentRuntimeError(
        'IDENTITY_MISMATCH',
        'Pairing identity differs',
      )
    return result
  }
  if (
    input.deviceKind === 'browser' &&
    ports.clientOrigin !== baseUrl &&
    input.delivery !== 'bearer'
  )
    throw new Error(
      'Cross-origin browser pairing requires memory-only bearer delivery',
    )
  const c = ports.crypto
  if (!c) throw new Error('Proof crypto port is required')
  const challengeResponse = await ports.fetch(
    `${baseUrl}/api/v2/access/challenge`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      redirect: 'error',
      credentials: 'omit',
    },
  )
  const challenge = await challengeResponse.json()
  if (!challengeResponse.ok || !Value.Check(PairingChallengeSchema, challenge))
    throw new EnvironmentRuntimeError('UNAUTHENTICATED', 'Pairing failed')
  const key = await c.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const publicKey = await c.subtle.exportKey('jwk', key.publicKey)
  const fields: Omit<PairingExchange, 'proof'> = {
    credential: input.credential,
    environmentId: descriptor.environmentId,
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    deviceName: input.deviceName,
    deviceKind: input.deviceKind,
    delivery: input.delivery,
    requestedScopes: input.requestedScopes,
    proofKey: { kty: 'EC', crv: 'P-256', x: publicKey.x!, y: publicKey.y! },
  }
  const digest = new Uint8Array(
    await c.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(canonical(fields)),
    ),
  )
  const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
  const transcript = `forge-pair-v1\n${descriptor.environmentId}\n${challenge.challengeId}\n${challenge.nonce}\n${hex}`
  const proof = base64url(
    await c.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key.privateKey,
      new TextEncoder().encode(transcript),
    ),
  )
  const exchange = await ports.fetch(`${baseUrl}/api/v2/access/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...fields, proof }),
    redirect: 'error',
    credentials: input.delivery === 'cookie' ? 'include' : 'omit',
  })
  if (!exchange.ok)
    throw new EnvironmentRuntimeError(
      'UNAUTHENTICATED',
      'Pairing credential is invalid, expired or already used',
      true,
    )
  const result = await exchange.json()
  if (
    !Value.Check(PairingExchangeResultSchema, result) ||
    result.environment.environmentId !== descriptor.environmentId
  )
    throw new EnvironmentRuntimeError(
      'IDENTITY_MISMATCH',
      'Pairing identity differs',
    )
  await ports.credentials.store(descriptor.environmentId, {
    deviceSessionId: result.deviceSession.deviceSessionId,
    expiresAt: result.deviceSession.expiresAt,
    ...(result.bearerToken ? { bearerToken: result.bearerToken } : {}),
    ...(result.csrfToken ? { csrfToken: result.csrfToken } : {}),
  })
  return result
}
