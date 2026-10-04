/**
 * Settings backend target: the backend whose settings a Settings view edits.
 */

import { resolveApiEndpoint } from '@/lib/api-endpoint'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type SettingsTab =
  | 'project-settings'
  | 'general'
  | 'environments'
  | 'git-monitoring'
  | 'history'
  | 'appearance'
  | 'notifications'
  | 'auth'
  | 'secrets'
  | 'models'
  | 'skills'
  | 'prompts'
  | 'specialists'
  | 'project-resources'
  | 'slash-commands'
  | 'extensions'
  | 'external-chrome'
  | 'cli-access'
  | 'stream-deck'
  | 'observability'
  | 'about'

export interface SettingsBackendTarget {
  label: string
  description: string
  wsUrl: string
  apiBaseUrl: string
  fetchCredentials: RequestCredentials
  availableTabs: SettingsTab[]
}

/* ------------------------------------------------------------------ */
/*  Tab lists                                                          */
/* ------------------------------------------------------------------ */

const BUILDER_TABS: SettingsTab[] = [
  'general',
  'environments',
  'git-monitoring',
  'history',
  'appearance',
  'notifications',
  'auth',
  'secrets',
  'models',
  'skills',
  'prompts',
  'specialists',
  'project-resources',
  'slash-commands',
  'extensions',
  'external-chrome',
  'cli-access',
  'stream-deck',
  'observability',
  'about',
]

/* ------------------------------------------------------------------ */
/*  Factory functions                                                  */
/* ------------------------------------------------------------------ */

export function createBuilderSettingsTarget(localWsUrl: string): SettingsBackendTarget {
  return {
    label: 'Builder backend',
    description: 'Local Forge Builder backend on this machine.',
    wsUrl: localWsUrl,
    apiBaseUrl: resolveApiEndpoint(localWsUrl, '/'),
    fetchCredentials: 'same-origin',
    availableTabs: BUILDER_TABS,
  }
}
