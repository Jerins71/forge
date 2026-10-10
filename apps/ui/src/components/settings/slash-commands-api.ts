import type { SettingsApiClient } from './settings-api-client'
import { resolveSettingsApiClient } from './settings-api-client'

export interface SlashCommand {
  id: string
  name: string
  prompt: string
  /** Menu description for built-in commands; saved commands show their prompt. */
  description?: string
  createdAt: string
  updatedAt: string
}

export async function fetchSlashCommands(settingsClient: SettingsApiClient): Promise<SlashCommand[]> {
  const client = resolveSettingsApiClient(settingsClient)
  const response = await client.fetch('/api/slash-commands')
  if (!response.ok) throw new Error('Failed to fetch slash commands')
  const data = await response.json() as { commands: SlashCommand[] }
  return data.commands ?? []
}

export async function createSlashCommand(settingsClient: SettingsApiClient, command: { name: string; prompt: string }): Promise<SlashCommand> {
  const client = resolveSettingsApiClient(settingsClient)
  const response = await client.fetch('/api/slash-commands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
  if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error((err as Record<string, unknown>).error as string ?? 'Failed to create') }
  const data = await response.json() as { command: SlashCommand }
  return data.command
}

export async function updateSlashCommand(settingsClient: SettingsApiClient, id: string, patch: { name?: string; prompt?: string }): Promise<SlashCommand> {
  const client = resolveSettingsApiClient(settingsClient)
  const response = await client.fetch(`/api/slash-commands/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
  if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error((err as Record<string, unknown>).error as string ?? 'Failed to update') }
  const data = await response.json() as { command: SlashCommand }
  return data.command
}

export async function deleteSlashCommand(settingsClient: SettingsApiClient, id: string): Promise<void> {
  const client = resolveSettingsApiClient(settingsClient)
  const response = await client.fetch(`/api/slash-commands/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) throw new Error('Failed to delete slash command')
}
