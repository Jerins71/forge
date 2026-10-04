
import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { SECURE_VAULT_RENDERER_CHANNEL, createSecureVaultController, createSecureVaultRequestHandler, installSecureVaultRendererIpc } from '../secure-vault-ipc.js'

function createSafeStorage(options: {
  available?: boolean
  asyncAvailable?: boolean | (() => Promise<boolean>)
  backend?: string
  encrypt?: (value: string) => Buffer | Promise<Buffer>
  decrypt?: (
    value: Buffer,
  ) =>
    | { shouldReEncrypt: boolean; result: string }
    | Promise<{ shouldReEncrypt: boolean; result: string }>
} = {}) {
  return {
    isEncryptionAvailable: vi.fn(() => options.available ?? true),
    isAsyncEncryptionAvailable: vi.fn(
      typeof options.asyncAvailable === 'function'
        ? options.asyncAvailable
        : async () => options.asyncAvailable ?? true,
    ),
    getSelectedStorageBackend: vi.fn(() => options.backend ?? 'gnome_libsecret'),
    encryptStringAsync: vi.fn(
      options.encrypt
      ?? (async (value: string) => Buffer.from(`sealed:${value}`, 'utf8')),
    ),
    decryptStringAsync: vi.fn(
      options.decrypt
      ?? (async (value: Buffer) => ({
        shouldReEncrypt: false,
        result: value.toString('utf8').replace(/^sealed:/, ''),
      })),
    ),
  }
}

function createController(
  safeStorage = createSafeStorage(),
  platform: NodeJS.Platform = 'darwin',
) {
  return createSecureVaultController({ safeStorage, platform })
}

describe('secure vault controller', () => {

  it('round-trips arbitrary bytes and returns replacement ciphertext on key rotation', async () => {
    const safeStorage = createSafeStorage({
      decrypt: async (value) => ({
        shouldReEncrypt: true,
        result: value.toString('utf8').replace(/^sealed:/, ''),
      }),
      encrypt: async (value) => Buffer.from(`current:${value}`, 'utf8'),
    })
    const controller = createController(safeStorage)
    const plainPayload = Buffer.from([0, 1, 2, 127, 128, 254, 255]).toString('base64')
    const legacyCiphertext = Buffer.from(`sealed:${plainPayload}`).toString('base64')

    expect(await controller.unlock()).toEqual({ available: true })
    const decrypted = await controller.decryptPayload(legacyCiphertext)

    expect(decrypted).toEqual({
      ok: true,
      result: {
        payload: plainPayload,
        reEncryptedPayload:
          Buffer.from(`current:${plainPayload}`).toString('base64'),
      },
    })
  })

  it('binds remote entry challenges to one browser context', async () => {
    const safeStorage = createSafeStorage()
    const controller = createController(safeStorage)
    expect(await controller.unlock()).toEqual({ available: true })
    const context = 'secure-browser:device-1'
    const challenge = await controller.createRemoteEntryChallenge(
      Buffer.from(context).toString('base64'),
    )
    if (!challenge.ok) throw new Error('Expected remote entry challenge')
    const envelope = sealRemoteEntry('context-bound-secret', context, challenge.result)
    const wrongContext = {
      ...envelope,
      context: Buffer.from('secure-browser:device-2').toString('base64'),
    }

    await expect(controller.encryptRemoteEntry(
      Buffer.from(JSON.stringify(wrongContext)).toString('base64'),
    )).resolves.toEqual({
      ok: false,
      errorCode: 'SECURE_VAULT_INVALID_REQUEST',
    })
    await expect(controller.encryptRemoteEntry(
      Buffer.from(JSON.stringify(envelope)).toString('base64'),
    )).resolves.toMatchObject({ ok: true })
  })
})

function sealRemoteEntry(
  value: string,
  context: string,
  challenge: {
    challengeId: string
    keyId: string
    publicKey: string
  },
) {
  const ephemeral = createECDH('prime256v1')
  ephemeral.generateKeys()
  const sharedSecret = ephemeral.computeSecret(
    Buffer.from(challenge.publicKey, 'base64'),
  )
  const aad = Buffer.from(
    `forge-secure-browser-private-entry:v1:${challenge.keyId}:${challenge.challengeId}`,
  )
  const key = Buffer.from(hkdfSync(
    'sha256',
    sharedSecret,
    Buffer.alloc(32),
    aad,
    32,
  ))
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  sharedSecret.fill(0)
  key.fill(0)
  return {
    context: Buffer.from(context).toString('base64'),
    challengeId: challenge.challengeId,
    keyId: challenge.keyId,
    ephemeralPublicKey: ephemeral.getPublicKey().toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

describe('secure vault backend child IPC', () => {
  it('rejects Linux basic_text even when Electron reports encryption available', async () => {
    const safeStorage = createSafeStorage({ backend: 'basic_text' })
    const controller = createController(safeStorage, 'linux')
    const handler = createSecureVaultRequestHandler({
      controller,
    })

    expect(await controller.unlock()).toEqual({
      available: false,
      errorCode: 'SECURE_VAULT_INSECURE_STORAGE',
    })
    expect(await handler.handle({
      type: 'secure_vault_request',
      requestId: 'status-1',
      operation: 'status',
    })).toEqual({
      type: 'secure_vault_response',
      requestId: 'status-1',
      ok: false,
      errorCode: 'SECURE_VAULT_INSECURE_STORAGE',
    })

    expect(await handler.handle({
      type: 'secure_vault_request',
      requestId: 'encrypt-1',
      operation: 'encrypt',
      payload: Buffer.from('secret').toString('base64'),
    })).toEqual({
      type: 'secure_vault_response',
      requestId: 'encrypt-1',
      ok: false,
      errorCode: 'SECURE_VAULT_INSECURE_STORAGE',
    })
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled()
  })

  it('maps provider exceptions to fixed errors without reflecting values or messages', async () => {
    const canary = 'do-not-reflect-this-value'
    const safeStorage = createSafeStorage({
      encrypt: async () => {
        throw new Error(canary)
      },
    })
    const controller = createController(safeStorage)
    expect(await controller.unlock()).toEqual({ available: true })
    const handler = createSecureVaultRequestHandler({ controller })

    const response = await handler.handle({
      type: 'secure_vault_request',
      requestId: 'failure-1',
      operation: 'encrypt',
      payload: Buffer.from(canary).toString('base64'),
    })

    expect(response).toEqual({
      type: 'secure_vault_response',
      requestId: 'failure-1',
      ok: false,
      errorCode: 'SECURE_VAULT_ENCRYPT_FAILED',
    })
    expect(JSON.stringify(response)).not.toContain(canary)
  })
})

describe('secure vault renderer IPC', () => {
  it('exposes trusted passive status, explicit unlock, and encrypt operations', async () => {
    const handlers = new Map<
      string,
      (event: unknown, request: unknown) => unknown
    >()
    const ipcMain = {
      handle: vi.fn((
        channel: string,
        listener: (event: unknown, request: unknown) => unknown,
      ) => {
        handlers.set(channel, listener)
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    }
    const trustedEvent = { sender: 'trusted' }
    const safeStorage = createSafeStorage({ available: false })
    const controller = createController(safeStorage)
    const dispose = installSecureVaultRendererIpc({
      ipcMain,
      controller,
      isTrustedSender: (event) => event === trustedEvent,
    })
    const invoke = handlers.get(SECURE_VAULT_RENDERER_CHANNEL)
    if (!invoke) throw new Error('Expected secure vault renderer handler')

    expect(await invoke(trustedEvent, { operation: 'status' })).toEqual({
      ok: false,
      errorCode: 'SECURE_VAULT_STORAGE_UNAVAILABLE',
    })
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorage.isAsyncEncryptionAvailable).not.toHaveBeenCalled()
    expect(await invoke(trustedEvent, { operation: 'unlock' })).toEqual({
      ok: true,
      available: true,
    })
    expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(1)

    expect(await invoke(
      trustedEvent,
      { operation: 'encrypt', value: 'local secret' },
    )).toEqual({
      ok: true,
      encryptedPayloadBase64: Buffer.from(
        `sealed:${Buffer.from('local secret').toString('base64')}`,
      ).toString('base64'),
    })
    expect(await invoke(
      trustedEvent,
      { operation: 'decrypt', value: 'anything' },
    )).toEqual({
      ok: false,
      errorCode: 'SECURE_VAULT_INVALID_REQUEST',
    })
    expect(await invoke(
      { sender: 'other' },
      { operation: 'encrypt', value: 'local secret' },
    )).toEqual({
      ok: false,
      errorCode: 'SECURE_VAULT_INVALID_REQUEST',
    })

    dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(
      SECURE_VAULT_RENDERER_CHANNEL,
    )
  })
})
