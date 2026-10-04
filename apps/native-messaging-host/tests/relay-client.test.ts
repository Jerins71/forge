import { describe, expect, it } from 'vitest'
import { authenticateRecord, createHandshakeProof, deriveRelaySessionKey, verifyHandshakeProof } from '../src/auth.js'
import {
  HOST_EXTENSION_ORIGIN,
  HOST_MAX_NEGOTIATED_MESSAGE_BYTES,
  HOST_PROTOCOL_MAX_VERSION,
  HOST_PROTOCOL_MIN_VERSION,
} from '../src/constants.js'
import type { JsonObject } from '../src/framing.js'
import { AuthenticatedRelayClient, type RelayClientDependencies } from '../src/relay-client.js'
import { type RelayRecordTransport, type RendezvousDocument } from '../src/transport.js'

const KEY = Buffer.alloc(32, 0x5a)
const EPOCH = 'epoch_1234567890abcdef'
const DESKTOP_INSTANCE_ID = 'desktop_1234567890abcdef'
const CLIENT_NONCE = 'c'.repeat(43)
const SERVER_NONCE = 's'.repeat(43)
const RENDEZVOUS: RendezvousDocument = {
  schemaVersion: 1,
  endpoint: '/tmp/forge-test.sock',
  epoch: EPOCH,
  expiresAt: '2030-01-01T00:00:00.000Z',
  keyId: 'test-key',
  userScope: 'test-user',
  desktopInstanceId: DESKTOP_INSTANCE_ID,
  desktopPid: 4242,
  protocolMin: HOST_PROTOCOL_MIN_VERSION,
  protocolMax: HOST_PROTOCOL_MAX_VERSION,
}

class FakeTransport implements RelayRecordTransport {
  readonly sent: JsonObject[] = []
  closed = false

  constructor(readonly incoming: Array<JsonObject | null>) {}

  async send(record: JsonObject): Promise<void> {
    this.sent.push(record)
  }

  async receive(): Promise<JsonObject | null> {
    return this.incoming.shift() ?? null
  }

  close(): void {
    this.closed = true
  }
}

interface SessionFixture {
  challenge: JsonObject
  ready: JsonObject
  relay(sequence: number, payload: JsonObject): JsonObject
  sessionKey: Buffer
}

function sessionFixture(options: {
  clientNonce?: string
  serverNonce?: string
  challengeOverrides?: JsonObject
  readyOverrides?: JsonObject
  rendezvous?: RendezvousDocument
} = {}): SessionFixture {
  const rendezvous = options.rendezvous ?? RENDEZVOUS
  const clientNonce = options.clientNonce ?? CLIENT_NONCE
  const serverNonce = options.serverNonce ?? SERVER_NONCE
  const challengeFields: JsonObject = {
    type: 'challenge',
    sequence: 0,
    epoch: rendezvous.epoch,
    desktopInstanceId: rendezvous.desktopInstanceId,
    extensionOrigin: HOST_EXTENSION_ORIGIN,
    clientNonce,
    serverNonce,
    clientProtocolMin: HOST_PROTOCOL_MIN_VERSION,
    clientProtocolMax: HOST_PROTOCOL_MAX_VERSION,
    desktopProtocolMin: rendezvous.protocolMin,
    desktopProtocolMax: rendezvous.protocolMax,
    protocolVersion: HOST_PROTOCOL_MIN_VERSION,
    maxMessageBytes: HOST_MAX_NEGOTIATED_MESSAGE_BYTES,
    ...options.challengeOverrides,
  }
  const challenge = {
    ...challengeFields,
    proof: createHandshakeProof('desktop-challenge', challengeFields, KEY),
  }
  const sessionKey = deriveRelaySessionKey(challengeFields, KEY)
  const ready = authenticateRecord({
    type: 'ready',
    epoch: String(challengeFields.epoch),
    desktopInstanceId: String(challengeFields.desktopInstanceId),
    extensionOrigin: String(challengeFields.extensionOrigin),
    sequence: 1,
    clientNonce: String(challengeFields.clientNonce),
    serverNonce: String(challengeFields.serverNonce),
    protocolVersion: Number(challengeFields.protocolVersion),
    maxMessageBytes: Number(challengeFields.maxMessageBytes),
    ...options.readyOverrides,
  }, sessionKey)
  return {
    challenge,
    ready,
    sessionKey,
    relay: (sequence, payload) => authenticateRecord({
      type: 'relay',
      direction: 'desktop-to-extension',
      epoch: String(challengeFields.epoch),
      desktopInstanceId: String(challengeFields.desktopInstanceId),
      extensionOrigin: String(challengeFields.extensionOrigin),
      sequence,
      clientNonce: String(challengeFields.clientNonce),
      serverNonce: String(challengeFields.serverNonce),
      protocolVersion: Number(challengeFields.protocolVersion),
      payload,
    }, sessionKey),
  }
}

function dependencies(
  transport: FakeTransport,
  overrides: Partial<RelayClientDependencies> = {},
): RelayClientDependencies {
  return {
    rendezvous: { read: async () => ({ ...RENDEZVOUS }) },
    secrets: { getSecret: async () => Buffer.from(KEY) },
    connector: { connect: async () => transport },
    expectedUserScope: 'test-user',
    expectedExtensionOrigin: HOST_EXTENSION_ORIGIN,
    platform: 'darwin',
    now: () => Date.parse('2029-01-01T00:00:00.000Z'),
    nonce: () => CLIENT_NONCE,
    maxAttempts: 1,
    ...overrides,
  }
}

function clientSessionKey(client: AuthenticatedRelayClient): Buffer {
  return (client as unknown as { sessionKey: Buffer }).sessionKey
}

describe('authenticated relay client', () => {
  it('uses the long-lived secret only for the bound challenge handshake and a derived key for ready/relay', async () => {
    const fixture = sessionFixture()
    const transport = new FakeTransport([fixture.challenge, fixture.ready, fixture.relay(2, { response: true })])
    const client = await AuthenticatedRelayClient.connect(dependencies(transport))
    await client.send({ request: true })
    await expect(client.receive()).resolves.toEqual({ response: true })

    expect(transport.sent.map((record) => record.type)).toEqual(['hello', 'authenticate', 'relay'])
    expect(transport.sent[0]).not.toHaveProperty('mac')
    expect(transport.sent[0]).not.toHaveProperty('proof')
    expect(transport.sent[1]).toHaveProperty('proof')
    expect(transport.sent[1]).not.toHaveProperty('mac')
    const { proof, ...authenticateFields } = transport.sent[1] ?? {}
    expect(() => verifyHandshakeProof('native-host-authenticate', authenticateFields, proof, KEY)).not.toThrow()
    expect(transport.sent[2]).toHaveProperty('mac')
    expect(clientSessionKey(client)).toEqual(fixture.sessionKey)
    expect(clientSessionKey(client)).not.toEqual(KEY)
    fixture.sessionKey.fill(0)
    client.close()
  })

  it('rejects a challenge proof mismatch and exact-field violations', async () => {
    const invalidProof = sessionFixture()
    invalidProof.challenge.proof = 'A'.repeat(43)
    await expect(AuthenticatedRelayClient.connect(dependencies(new FakeTransport([invalidProof.challenge])))).rejects.toMatchObject({
      code: 'hmac-mismatch',
    })
    invalidProof.sessionKey.fill(0)

    const extraField = sessionFixture()
    extraField.challenge.unexpected = true
    await expect(AuthenticatedRelayClient.connect(dependencies(new FakeTransport([extraField.challenge])))).rejects.toMatchObject({
      code: 'malformed-auth-record',
    })
    extraField.sessionKey.fill(0)
  })

  it('rejects inbound sequence replay and closes with a zeroed session key', async () => {
    const fixture = sessionFixture()
    const transport = new FakeTransport([fixture.challenge, fixture.ready, fixture.relay(1, { stale: true })])
    const client = await AuthenticatedRelayClient.connect(dependencies(transport))
    const ownedKey = clientSessionKey(client)
    await expect(client.receive()).rejects.toMatchObject({ code: 'sequence-replay' })
    expect(transport.closed).toBe(true)
    expect(ownedKey.every((byte) => byte === 0)).toBe(true)
    fixture.sessionKey.fill(0)
  })
})
