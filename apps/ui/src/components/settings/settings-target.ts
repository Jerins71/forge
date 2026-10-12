/**
 * Settings tabs. The environment a Settings view edits is chosen by its environment picker.
 */

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
  | 'presets'
  | 'project-resources'
  | 'slash-commands'
  | 'extensions'
  | 'external-chrome'
  | 'cli-access'
  | 'stream-deck'
  | 'observability'
  | 'about'

/* ------------------------------------------------------------------ */
/*  Tab lists                                                          */
/* ------------------------------------------------------------------ */

/** Tabs every environment's Settings view offers. */
export const SETTINGS_TABS: SettingsTab[] = [
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
  'presets',
  'project-resources',
  'slash-commands',
  'extensions',
  'external-chrome',
  'cli-access',
  'stream-deck',
  'observability',
  'about',
]
