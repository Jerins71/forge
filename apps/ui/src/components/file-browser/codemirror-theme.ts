import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { Facet, type Extension } from '@codemirror/state'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'

export const codeMirrorDarkThemeFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? false,
})

export function isForgeDarkModeActive(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

// Colors come from --syn-* variables in styles/syntax-highlight.css so CodeMirror,
// highlight.js (markdown/diffs) and both themes share one palette. The tag->role grouping is
// reused from One Dark's highlight style (@lezer/highlight is not a direct dependency) and
// only its colors are remapped onto the Forge palette.
const PALETTE_BY_ONE_DARK_COLOR: Record<string, string> = {
  '#c678dd': 'var(--syn-keyword)',
  '#e06c75': 'var(--foreground)',
  '#61afef': 'var(--syn-function)',
  '#d19a66': 'var(--syn-number)',
  '#abb2bf': 'var(--foreground)',
  '#e5c07b': 'var(--syn-type)',
  '#56b6c2': 'var(--syn-punct)',
  '#7d8799': 'var(--syn-comment)',
  '#98c379': 'var(--syn-string)',
  '#ffffff': 'var(--status-danger)',
}

const forgeHighlightStyle = HighlightStyle.define(
  oneDarkHighlightStyle.specs.map((spec) => {
    const color = typeof spec.color === 'string' ? PALETTE_BY_ONE_DARK_COLOR[spec.color.toLowerCase()] : undefined
    return color ? { ...spec, color } : spec
  }),
)

const darkBase = EditorView.theme({}, { dark: true })

export function codeMirrorThemeExtensions(isDark: boolean): Extension {
  return isDark
    ? [codeMirrorDarkThemeFacet.of(true), darkBase, syntaxHighlighting(forgeHighlightStyle)]
    : [codeMirrorDarkThemeFacet.of(false), syntaxHighlighting(forgeHighlightStyle)]
}
