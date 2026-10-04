import { describe, expect, expectTypeOf, it } from 'vitest'

import { SecureSessionsContractError, parseSetSecureSessionAccessRequest, parseGrantSecureSecretLeaseRequest, parseSecureSecretBinding, parseSecureSecretLeaseSpec, type SecureAccessRequestSummary, type SecureSecretBinding, type SecureSecretProviderSummary, type SecureSecretSummary, type SecureSshTrustedHostSummary, type SecureSshTrustRequestSummary, type SecureSessionLeaseSummary } from '../index.js'

describe('Secure Sessions protocol', () => {
  it('validates exactly one bounded access subject and explicit user intent', () => {
    for (const subject of [{ kind: 'task' }, { kind: 'agent', agentId: 'worker' }, { kind: 'secret', secretId: 'secret' }]) {
      expect(parseSetSecureSessionAccessRequest({ baseRevision: 3, subject, blocked: true }))
        .toEqual({ baseRevision: 3, subject, blocked: true })
    }
    for (const subject of [{ kind: 'task', agentId: 'worker' }, { kind: 'agent' },
      { kind: 'agent', agentId: 'x'.repeat(257) }, { kind: 'secret', secretId: '' }, { kind: 'project' }]) {
      expect(() => parseSetSecureSessionAccessRequest({ baseRevision: 3, subject, blocked: true })).toThrow()
    }
    expect(() => parseSetSecureSessionAccessRequest({ baseRevision: -1, subject: { kind: 'task' }, blocked: true })).toThrow()
    expect(() => parseSetSecureSessionAccessRequest({ baseRevision: 1, subject: { kind: 'task' }, blocked: 'false' })).toThrow()
  })

  it('rejects unknown fields at every secret-bearing input boundary', () => {
    const safeExposure = { deliveryKind: 'stdin' }
    const rawMaterialFields = [
      'value',
      'ciphertext',
      'sourceLocator',
      'keychainRef',
    ] as const

    for (const field of rawMaterialFields) {
      expect(() => parseSecureSecretBinding({
        ...safeExposure,
        [field]: true,
      })).toThrow(SecureSessionsContractError)

      expect(() => parseGrantSecureSecretLeaseRequest({
        baseRevision: 0,
        secretId: 'secret-api',
        exposures: [safeExposure],
        leaseKind: 'one_use',
        [field]: true,
      })).toThrow(SecureSessionsContractError)
    }

    expect(() => parseSecureSecretLeaseSpec({
      leaseKind: 'task',
      durationSeconds: 60,
    })).toThrow(SecureSessionsContractError)
  })

  it('has no public representation for secret material or source locators', () => {
    type ForbiddenMaterialField =
      | 'value'
      | 'secretValue'
      | 'ciphertext'
      | 'sourceLocator'
      | 'keychainRef'
      | 'hostKeyBase64'
    type ExposedMaterialField = Extract<
      | keyof SecureSecretProviderSummary
      | keyof SecureSecretSummary
      | keyof SecureSecretBinding
      | keyof SecureSessionLeaseSummary
      | keyof SecureAccessRequestSummary
      | keyof SecureSshTrustedHostSummary
      | keyof SecureSshTrustRequestSummary,
      ForbiddenMaterialField
    >

    expectTypeOf<ExposedMaterialField>().toEqualTypeOf<never>()
  })
})
