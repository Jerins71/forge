/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ManagerProfile } from '@forge/protocol'
import { createBuilderSettingsApiClient } from './settings-api-client'
import { ProjectSecureSessionsSettings } from './ProjectSecureSessionsSettings'
const api = vi.hoisted(() => ({ fetch: vi.fn(), update: vi.fn() }))
vi.mock('@/lib/secure-secrets-api', () => ({
  fetchProjectSecureSessionsSettings: api.fetch, updateProjectSecureSessionsSettings: api.update,
}))
let root: Root
let container: HTMLDivElement
const profile = { profileId: 'project-a', displayName: 'Project A', secureSessionsEnabled: false } as ManagerProfile
const apiClient = createBuilderSettingsApiClient('ws://localhost:47187')
beforeEach(() => { vi.resetAllMocks(); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
async function render(value = profile) { await act(async () => root.render(createElement(ProjectSecureSessionsSettings, { profile: value, apiClient }))) }
function toggle() { return container.querySelector<HTMLButtonElement>('[role="switch"]')! }

it('shows the persisted choice, saves the toggle, and responds to live project updates', async () => {
  api.update.mockResolvedValue({ profileId: 'project-a', enabled: true })
  await render()
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  await act(async () => toggle().click())
  expect(api.update).toHaveBeenCalledWith(apiClient, 'project-a', true)
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  await render({ ...profile, secureSessionsEnabled: true })
  await render({ ...profile, secureSessionsEnabled: false })
  expect(toggle().getAttribute('aria-checked')).toBe('false')
})

it('reads back a persisted disable after cleanup fails and offers a retry', async () => {
  api.update.mockRejectedValue(new Error('cleanup failed'))
  api.fetch.mockResolvedValue({ profileId: 'project-a', enabled: false })
  await render({ ...profile, secureSessionsEnabled: true })
  await act(async () => toggle().click())
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('The change did not finish')
  api.update.mockResolvedValue({ profileId: 'project-a', enabled: false })
  const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!
  await act(async () => retry.click())
  expect(api.update).toHaveBeenLastCalledWith(apiClient, 'project-a', false)
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('prevents overlapping writes and does not claim a value after an unconfirmed failure', async () => {
  let reject!: (error: Error) => void
  api.update.mockImplementation(() => new Promise((_, fail) => { reject = fail }))
  api.fetch.mockRejectedValue(new Error('offline'))
  await render()
  await act(async () => toggle().click())
  expect(toggle().disabled).toBe(true)
  await act(async () => reject(new Error('offline')))
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Setting unavailable')
  expect(toggle().disabled).toBe(true)
})

it('keeps a newer live project change when an older save response arrives afterward', async () => {
  let resolve!: (value: { profileId: string; enabled: boolean }) => void
  api.update.mockImplementation(() => new Promise(done => { resolve = done }))
  await render()
  await act(async () => toggle().click())
  await render({ ...profile, secureSessionsEnabled: true })
  await render({ ...profile, secureSessionsEnabled: false })
  await act(async () => resolve({ profileId: 'project-a', enabled: true }))
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  expect(toggle().disabled).toBe(false)
})
