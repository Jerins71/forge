/** @vitest-environment jsdom */

import {
  fireEvent,
  getByLabelText,
  getByRole,
} from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecureAccessRequestView } from '../secure-session/types'
import { SecureSecretRequestCard } from './SecureSecretRequestCard'

let container: HTMLDivElement
let root: Root

const request: SecureAccessRequestView = {
  requestId: 'request-1',
  sessionAgentId: 'manager-1',
  requestedByAgentId: 'worker-1',
  requestedByLabel: 'Deploy worker',
  secretId: 'secret-1',
  secretAlias: 'deploy-token',
  purpose: 'Publish the verified release',
  requestedBindings: [{ kind: 'env', variable: 'DEPLOY_TOKEN' }],
  requestedPolicy: { kind: 'one_use' },
  status: 'pending',
}

const secrets = [{
  secretId: 'secret-1',
  displayAlias: 'deploy-token',
  displayName: 'Deploy token',
  available: true,
  bindings: [{ kind: 'env' as const, variable: 'DEPLOY_TOKEN' }],
}]

function renderCard(overrides: Record<string, unknown> = {}) {
  const props = {
    request,
    availability: { state: 'available' as const },
    secrets,
    project: { profileId: 'profile-1', displayName: 'Release project' },
    onGrant: vi.fn(),
    onDeny: vi.fn(),
    onPrivateFulfill: vi.fn(),
    ...overrides,
  }
  flushSync(() => {
    root.render(createElement(SecureSecretRequestCard, props))
  })
  return props
}

function privateValueInputs(): HTMLTextAreaElement[] {
  return Array.from(document.body.querySelectorAll<HTMLTextAreaElement>(
    'textarea[data-slot="private-value-textarea"]',
  ))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('SecureSecretRequestCard', () => {
  it('clears and unmounts a private value immediately on cancel', () => {
    const onPrivateFulfill = vi.fn()
    renderCard({
      request: { ...request, secretId: undefined },
      secrets: [],
      onPrivateFulfill,
    })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Add secret and approve' }))
    })
    const input = getByLabelText(document.body, 'Value for deploy-token') as HTMLInputElement
    flushSync(() => {
      fireEvent.change(input, { target: { value: 'cancelled-private-value' } })
      fireEvent.click(getByRole(document.body, 'button', { name: 'Cancel' }))
    })

    expect(onPrivateFulfill).not.toHaveBeenCalled()
    expect(privateValueInputs()).toHaveLength(0)
    expect(document.body.textContent).not.toContain('cancelled-private-value')
    expect(Array.from(document.body.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement
    >('input, textarea')).some(
      (candidate) => candidate.value === 'cancelled-private-value',
    )).toBe(false)
  })

  it('removes a private value when the active task surface unmounts', () => {
    renderCard({
      request: { ...request, secretId: undefined },
      secrets: [],
    })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Add secret and approve' }))
    })
    const input = getByLabelText(document.body, 'Value for deploy-token') as HTMLInputElement
    flushSync(() => {
      fireEvent.change(input, { target: { value: 'unmounted-private-value' } })
      root.render(createElement('div'))
    })

    expect(privateValueInputs()).toHaveLength(0)
    expect(input.value).toBe('')
    expect(document.body.textContent).not.toContain('unmounted-private-value')
  })

})
