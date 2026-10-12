import type { SelectableModel } from '@/lib/model-preset'

export const PROVIDER_LABELS: Record<string, string> = {
  'codex-native': 'Codex native',
  'claude-native': 'Claude native',
  'openai-codex': 'OpenAI Codex',
  'anthropic': 'Anthropic',
  'cursor-sdk': 'Cursor SDK',
  xai: 'xAI',
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider
}

export function encodeSelectableModelKey(provider: string, modelId: string): string {
  return `${provider}::${modelId}`
}

export function decodeSelectableModelKey(value: string): { provider: string; modelId: string } | null {
  const separatorIndex = value.indexOf('::')
  if (separatorIndex <= 0 || separatorIndex >= value.length - 2) {
    return null
  }
  return {
    provider: value.slice(0, separatorIndex),
    modelId: value.slice(separatorIndex + 2),
  }
}

export function groupModelsByProvider(
  models: SelectableModel[],
): Array<{ provider: string; label: string; models: SelectableModel[] }> {
  const groups = new Map<string, SelectableModel[]>()
  for (const m of models) {
    let group = groups.get(m.provider)
    if (!group) {
      group = []
      groups.set(m.provider, group)
    }
    group.push(m)
  }
  return Array.from(groups.entries()).map(([provider, items]) => ({
    provider,
    label: providerLabel(provider),
    models: items,
  }))
}
