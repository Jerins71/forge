import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, RotateCcw, Shuffle } from 'lucide-react'
import type { CSSProperties } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  APPEARANCE_CODE_FONTS,
  APPEARANCE_TEMPLATES,
  APPEARANCE_UI_FONTS,
  applyAppearanceConfig,
  applyThemePreference,
  getContrastRatio,
  getDefaultAppearanceConfig,
  mixColor,
  readStoredAppearanceConfig,
  resolveAppearanceCssVariables,
  resolveAppearanceIsDark,
  type AppearanceCodeFont,
  type AppearanceConfig,
  type AppearanceFont,
  type AppearanceTemplate,
  type ThemePreference,
} from '@/lib/theme'
import { SettingsSection, SettingsWithCTA } from './settings-row'

const MODE_OPTIONS: Array<{ value: ThemePreference; label: string; hint: string }> = [
  { value: 'auto', label: 'System', hint: 'Match OS' },
  { value: 'dark', label: 'Dark', hint: 'Default' },
  { value: 'light', label: 'Light', hint: '' },
]

const MODE_PREVIEW_PALETTES = {
  dark: { bg: '#08080a', side: '#121216', line: 'rgba(255,255,255,0.18)', card: '#1c1c22' },
  light: { bg: '#f5f5f7', side: '#e9e9ee', line: 'rgba(18,18,22,0.2)', card: '#ffffff' },
} as const

const ACCENT_SWATCHES: Array<{ name: string; value: string }> = [
  { name: 'Periwinkle', value: '#8e9bff' },
  { name: 'Mint', value: '#14b8a6' },
  { name: 'Cobalt', value: '#3b82f6' },
  { name: 'Lime', value: '#84cc16' },
  { name: 'Rose', value: '#e879a8' },
  { name: 'Copper', value: '#d97757' },
]

function ModePreview({ palette, accent }: { palette: (typeof MODE_PREVIEW_PALETTES)[keyof typeof MODE_PREVIEW_PALETTES]; accent: string }) {
  return (
    <span className="flex size-full" style={{ backgroundColor: palette.bg }} aria-hidden="true">
      <span className="flex w-[30%] flex-col gap-[5px] px-[7px] py-2.5" style={{ backgroundColor: palette.side }}>
        <span className="h-1 w-4/5 rounded-sm" style={{ backgroundColor: palette.line }} />
        <span className="h-1 w-3/5 rounded-sm" style={{ backgroundColor: palette.line }} />
        <span className="h-1 w-[70%] rounded-sm" style={{ backgroundColor: palette.line }} />
      </span>
      <span className="flex flex-1 flex-col justify-end p-2">
        <span className="flex h-[18px] items-center justify-end rounded-md px-1" style={{ backgroundColor: palette.card }}>
          <span className="size-[9px] rounded-[3px]" style={{ backgroundColor: accent }} />
        </span>
      </span>
    </span>
  )
}

export function SettingsAppearance() {
  const [appliedAppearance, setAppliedAppearance] = useState<AppearanceConfig>(() => readStoredAppearanceConfig())
  const [draftAppearance, setDraftAppearance] = useState<AppearanceConfig>(() => readStoredAppearanceConfig())

  const draftIsDirty = !areAppearanceConfigsEqual(draftAppearance, appliedAppearance)

  const previewIsDark = useMemo(() => resolveAppearanceIsDark(draftAppearance.mode), [draftAppearance.mode])

  const previewVariables = useMemo(
    () => resolveAppearanceCssVariables({ ...draftAppearance, customApplied: true }, previewIsDark),
    [draftAppearance, previewIsDark],
  )

  const patchDraft = useCallback((patch: Partial<AppearanceConfig>) => {
    setDraftAppearance((current) => ({ ...current, ...patch, version: 1 }))
  }, [])

  const handleTemplateSelect = useCallback((template: AppearanceTemplate) => {
    setDraftAppearance((current) => ({
      ...current,
      mode: template.preferredMode ?? current.mode,
      accentColor: template.accentColor,
      backgroundColor: template.backgroundColor,
      foregroundColor: template.foregroundColor,
      uiFont: template.uiFont ?? current.uiFont,
      codeFont: template.codeFont ?? current.codeFont,
      templateId: template.id,
      customApplied: false,
    }))
  }, [])

  const handleRandomize = useCallback(() => {
    setDraftAppearance((current) => ({
      ...current,
      ...generateRandomAppearance(),
      customApplied: false,
    }))
  }, [])

  const handleApply = useCallback(() => {
    if (isDefaultForgeStyleDraft(draftAppearance)) {
      const next = { ...getDefaultAppearanceConfig(), mode: draftAppearance.mode }
      setDraftAppearance(next)
      setAppliedAppearance(next)
      if (next.mode === getDefaultAppearanceConfig().mode) {
        applyAppearanceConfig(next, { applyModeWhenCustomDisabled: true })
      } else {
        applyThemePreference(next.mode)
      }
      return
    }

    const next = { ...draftAppearance, version: 1, customApplied: true } satisfies AppearanceConfig
    setDraftAppearance(next)
    setAppliedAppearance(next)
    applyAppearanceConfig(next)
  }, [draftAppearance])

  const handleReset = useCallback(() => {
    const defaults = getDefaultAppearanceConfig()
    setDraftAppearance(defaults)
    setAppliedAppearance(defaults)
    applyAppearanceConfig(defaults, { applyModeWhenCustomDisabled: true })
  }, [])

  return (
    <div className="flex min-w-0 flex-col">
      <SettingsSection
        label="Theme"
        description="Draft light, dark, or system mode. The app changes only after Apply."
      >
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
          {MODE_OPTIONS.map((option) => {
            const active = draftAppearance.mode === option.value
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => patchDraft({ mode: option.value })}
                className={cn(
                  'flex flex-col gap-2.5 rounded-[14px] border bg-foreground/[0.02] p-2 pb-2.5 text-left transition-colors duration-150 hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  active ? 'border-primary ring-2 ring-primary/40' : 'border-hairline',
                )}
                aria-pressed={active}
              >
                <span className="relative block h-[92px] overflow-hidden rounded-[9px] border border-hairline">
                  {option.value === 'auto' ? (
                    <>
                      <ModePreview palette={MODE_PREVIEW_PALETTES.dark} accent={draftAppearance.accentColor} />
                      <span className="absolute inset-0" style={{ clipPath: 'polygon(50% 0, 100% 0, 100% 100%, 50% 100%)' }}>
                        <ModePreview palette={MODE_PREVIEW_PALETTES.light} accent={draftAppearance.accentColor} />
                      </span>
                    </>
                  ) : (
                    <ModePreview palette={MODE_PREVIEW_PALETTES[option.value]} accent={draftAppearance.accentColor} />
                  )}
                </span>
                <span className="flex items-center justify-between px-1 text-[13px] text-foreground">
                  {option.label}
                  {active ? <Check className="size-3.5 text-primary" strokeWidth={1.75} /> : null}
                </span>
              </button>
            )
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        label="Colors"
        description="Pick an accent, or set exact values. Contrast is checked when you apply."
      >
        <SettingsWithCTA label="Accent" description="Used for live activity, focus and primary actions.">
          <div role="radiogroup" aria-label="Accent swatches" className="flex flex-wrap items-center gap-2">
            {ACCENT_SWATCHES.map((swatch) => {
              const active = draftAppearance.accentColor.toLowerCase() === swatch.value
              return (
                <button
                  key={swatch.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={`${swatch.name} accent`}
                  title={swatch.name}
                  onClick={() => patchDraft({ accentColor: swatch.value })}
                  className={cn(
                    'size-7 rounded-full border border-hairline transition-shadow duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    active && 'ring-2 ring-foreground/80 ring-offset-2 ring-offset-background',
                  )}
                  style={{ backgroundColor: swatch.value }}
                />
              )
            })}
          </div>
        </SettingsWithCTA>
        <div className="grid gap-3 sm:grid-cols-3">
          <ColorControl
            label="Accent"
            value={draftAppearance.accentColor}
            onChange={(accentColor) => patchDraft({ accentColor })}
          />
          <ColorControl
            label="Background"
            value={draftAppearance.backgroundColor}
            onChange={(backgroundColor) => patchDraft({ backgroundColor })}
          />
          <ColorControl
            label="Foreground"
            value={draftAppearance.foregroundColor}
            onChange={(foregroundColor) => patchDraft({ foregroundColor })}
          />
        </div>
      </SettingsSection>

      <SettingsSection label="Typography">
        <SettingsWithCTA
          label="UI font"
          description="Choose from safe local font stacks. Forge does not load remote fonts for this setting."
        >
          <Select
            value={draftAppearance.uiFont}
            onValueChange={(value) => patchDraft({ uiFont: value as AppearanceFont })}
          >
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue placeholder="Select UI font" />
            </SelectTrigger>
            <SelectContent>
              {(Object.entries(APPEARANCE_UI_FONTS) as [AppearanceFont, string][]).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsWithCTA>

        <SettingsWithCTA
          label="Code font"
          description="Choose a local monospace stack for code, terminals, and technical text."
        >
          <Select
            value={draftAppearance.codeFont}
            onValueChange={(value) => patchDraft({ codeFont: value as AppearanceCodeFont })}
          >
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue placeholder="Select code font" />
            </SelectTrigger>
            <SelectContent>
              {(Object.entries(APPEARANCE_CODE_FONTS) as [AppearanceCodeFont, string][]).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsWithCTA>
      </SettingsSection>

      <SettingsSection
        label="Template themes"
        description="Forge-native presets. Selecting one updates the draft and preview only."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {APPEARANCE_TEMPLATES.map((template) => {
            const active = isTemplateDraftActive(draftAppearance, template)
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => handleTemplateSelect(template)}
                className={cn(
                  'rounded-[14px] border bg-foreground/[0.02] p-2 pb-3 text-left transition-colors duration-150 hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  active ? 'border-primary ring-2 ring-primary/40' : 'border-hairline',
                )}
                aria-pressed={active}
              >
                <div
                  className="mb-2.5 h-16 rounded-[9px] border p-2"
                  style={{
                    backgroundColor: template.backgroundColor,
                    borderColor: template.accentColor,
                    color: template.foregroundColor,
                  }}
                  aria-hidden="true"
                >
                  <div className="mb-2 h-2 w-16 rounded-full" style={{ backgroundColor: template.accentColor }} />
                  <div className="h-2 w-full rounded-full opacity-35" style={{ backgroundColor: template.foregroundColor }} />
                  <div className="mt-1 h-2 w-2/3 rounded-full opacity-25" style={{ backgroundColor: template.foregroundColor }} />
                </div>
                <div className="flex items-center justify-between gap-2 px-1">
                  <div className="flex items-center gap-1.5">
                    <span className="size-3 rounded-full border border-hairline" style={{ backgroundColor: template.accentColor }} />
                    <span className="text-[13px] font-medium text-foreground">{template.name}</span>
                    {template.id === getDefaultAppearanceConfig().templateId ? (
                      <span className="font-mono text-[11px] text-subtle-foreground">default</span>
                    ) : null}
                  </div>
                  {active ? <Check className="size-3.5 text-primary" strokeWidth={1.75} /> : null}
                </div>
                <p className="mt-1 px-1 text-[12.5px] leading-snug text-muted-foreground">{template.description}</p>
              </button>
            )
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        label="Draft preview"
        description="This card previews the draft only. The rest of Forge will not change until you click Apply."
        cta={
          <Button type="button" variant="outline" size="sm" onClick={handleRandomize}>
            <Shuffle className="mr-1.5 size-3.5" strokeWidth={1.75} />
            Randomize draft
          </Button>
        }
      >
        <div>
          <div
            className="rounded-xl border p-4"
            style={previewShellStyle(previewVariables)}
          >
            <div className="mb-3 flex flex-col items-start justify-between gap-3 rounded-lg border p-3 sm:flex-row sm:items-center" style={previewCardStyle(previewVariables)}>
              <div>
                <div className="text-sm font-semibold" style={{ color: previewVariables['--foreground'] }}>Forge workspace</div>
                <div className="text-xs" style={{ color: previewVariables['--muted-foreground'] }}>Draft-only appearance preview</div>
              </div>
              <div
                className="rounded-md px-3 py-1.5 text-xs font-medium"
                style={{ backgroundColor: previewVariables['--primary'], color: previewVariables['--primary-foreground'] }}
              >
                Primary
              </div>
            </div>
            <div className="grid gap-3">
              <div className="rounded-lg p-3 text-sm" style={{ backgroundColor: previewVariables['--muted'], color: previewVariables['--foreground'] }}>
                Draft changes stay inside this preview until you apply them.
              </div>
              <code
                className="min-w-0 rounded-lg border p-3 text-xs"
                style={{
                  backgroundColor: previewVariables['--card'],
                  borderColor: previewVariables['--border'],
                  color: previewVariables['--foreground'],
                  fontFamily: previewVariables['--app-font-mono'],
                }}
              >
                --accent: {draftAppearance.accentColor}
              </code>
            </div>
          </div>
        </div>
      </SettingsSection>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[12.5px] text-muted-foreground">
          {draftIsDirty ? 'You have unapplied draft changes.' : appliedAppearance.customApplied ? 'Custom appearance is applied.' : getDefaultStatusLabel(appliedAppearance.mode)}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handleReset}>
            <RotateCcw className="mr-1.5 size-3.5" strokeWidth={1.75} />
            Reset defaults
          </Button>
          <Button type="button" size="sm" onClick={handleApply} disabled={!draftIsDirty}>
            Apply appearance
          </Button>
        </div>
      </div>
    </div>
  )
}

function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [textValue, setTextValue] = useState(value.toUpperCase())
  const inputId = `appearance-${label.toLowerCase()}-hex`
  const normalizedTextValue = normalizeHexInput(textValue)
  const isValid = normalizedTextValue !== null

  useEffect(() => {
    setTextValue(value.toUpperCase())
  }, [value])

  const handleTextChange = (nextValue: string) => {
    setTextValue(nextValue)
    const normalized = normalizeHexInput(nextValue)
    if (normalized) {
      onChange(normalized)
    }
  }

  return (
    <div className="glass-inset rounded-xl p-3">
      <Label className="mb-2 block text-xs font-medium text-muted-foreground" htmlFor={inputId}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 w-12 shrink-0 cursor-pointer p-1"
          aria-label={`${label} color`}
        />
        <Input
          id={inputId}
          value={textValue}
          onChange={(event) => handleTextChange(event.target.value)}
          onBlur={() => {
            if (!isValid) setTextValue(value.toUpperCase())
          }}
          className="font-mono text-xs uppercase"
          aria-label={`${label} hex value`}
          aria-invalid={!isValid}
          inputMode="text"
          maxLength={7}
          pattern="^#?[0-9a-fA-F]{6}$"
          spellCheck={false}
        />
      </div>
      {!isValid ? (
        <p className="mt-1 text-xs text-danger" role="status">Enter a 6-digit hex color.</p>
      ) : null}
    </div>
  )
}

function normalizeHexInput(value: string): string | null {
  const trimmed = value.trim()
  const candidate = trimmed.startsWith('#') ? trimmed : `#${trimmed}`
  return /^#[0-9a-fA-F]{6}$/.test(candidate) ? candidate.toLowerCase() : null
}

function getDefaultStatusLabel(mode: ThemePreference): string {
  if (mode === 'dark') return 'Forge default colors; dark mode is active.'
  if (mode === 'light') return 'Forge default colors; light mode is active.'
  return 'Forge default appearance is active.'
}

function areAppearanceConfigsEqual(a: AppearanceConfig, b: AppearanceConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function isTemplateDraftActive(draft: AppearanceConfig, template: AppearanceTemplate): boolean {
  return draft.templateId === template.id &&
    draft.accentColor === template.accentColor &&
    draft.backgroundColor === template.backgroundColor &&
    draft.foregroundColor === template.foregroundColor
}

function isDefaultForgeStyleDraft(draft: AppearanceConfig): boolean {
  const defaults = getDefaultAppearanceConfig()
  return draft.templateId === defaults.templateId &&
    draft.accentColor === defaults.accentColor &&
    draft.backgroundColor === defaults.backgroundColor &&
    draft.foregroundColor === defaults.foregroundColor &&
    draft.uiFont === defaults.uiFont &&
    draft.codeFont === defaults.codeFont
}

function previewShellStyle(vars: Record<string, string>): CSSProperties {
  return {
    backgroundColor: vars['--background'],
    borderColor: vars['--border'],
    color: vars['--foreground'],
    fontFamily: vars['--app-font-sans'],
  }
}

function previewCardStyle(vars: Record<string, string>): CSSProperties {
  return {
    backgroundColor: vars['--card'],
    borderColor: vars['--border'],
    color: vars['--foreground'],
  }
}

function generateRandomAppearance(): Pick<AppearanceConfig, 'mode' | 'accentColor' | 'backgroundColor' | 'foregroundColor' | 'uiFont' | 'codeFont' | 'templateId'> {
  const mode: ThemePreference = Math.random() > 0.45 ? 'light' : 'dark'
  const hue = randomInt(0, 359)
  const accentHue = (hue + randomInt(35, 180)) % 360
  const backgroundColor = hslToHex(hue, randomInt(20, 58), mode === 'dark' ? randomInt(12, 24) : randomInt(88, 97))
  const preferredForeground = mode === 'dark'
    ? hslToHex((hue + randomInt(160, 220)) % 360, randomInt(35, 72), randomInt(82, 94))
    : hslToHex((hue + randomInt(160, 220)) % 360, randomInt(35, 72), randomInt(8, 22))
  const foregroundColor = getContrastRatio(preferredForeground, backgroundColor) >= 7
    ? preferredForeground
    : mode === 'dark' ? '#f8fafc' : '#0f172a'
  const accentColor = hslToHex(accentHue, randomInt(58, 88), mode === 'dark' ? randomInt(48, 70) : randomInt(34, 52))
  const uiFonts: AppearanceFont[] = ['geist', 'system', 'inter', 'serif']
  const codeFonts: AppearanceCodeFont[] = ['geist-mono', 'system-mono', 'jetbrains', 'sf-mono']

  return {
    mode,
    accentColor: ensureAccentSeparation(accentColor, backgroundColor, mode),
    backgroundColor,
    foregroundColor,
    uiFont: uiFonts[randomInt(0, uiFonts.length - 1)],
    codeFont: codeFonts[randomInt(0, codeFonts.length - 1)],
    templateId: 'forge',
  }
}

function ensureAccentSeparation(accent: string, background: string, mode: ThemePreference): string {
  if (getContrastRatio(accent, background) >= 3) return accent
  return mode === 'dark' ? mixColor(accent, '#ffffff', 0.35) : mixColor(accent, '#000000', 0.25)
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function hslToHex(h: number, s: number, l: number): string {
  const saturation = s / 100
  const lightness = l / 100
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = lightness - chroma / 2
  let r = 0
  let g = 0
  let b = 0

  if (h < 60) { r = chroma; g = x }
  else if (h < 120) { r = x; g = chroma }
  else if (h < 180) { g = chroma; b = x }
  else if (h < 240) { g = x; b = chroma }
  else if (h < 300) { r = x; b = chroma }
  else { r = chroma; b = x }

  const toHex = (value: number): string => Math.round((value + m) * 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}
