import { useEffect, useState } from 'react'

/* ------------------------------------------------------------------ */
/*  Theme configuration for react-diff-viewer-continued               */
/*  Colors harmonize with Forge's CSS custom properties               */
/* ------------------------------------------------------------------ */

const SUCCESS = 'var(--status-success)'
const DANGER = 'var(--status-danger)'
const MONO = 'var(--font-mono, "Geist Mono", ui-monospace, monospace)'

/** Token-derived so light, dark, and custom palettes all follow the app theme. */
const mix = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`

const palette = {
  diffViewerBackground: 'transparent',
  diffViewerColor: 'var(--foreground)',
  addedBackground: mix(SUCCESS, 9),
  removedBackground: mix(DANGER, 9),
  wordAddedBackground: mix(SUCCESS, 22),
  wordRemovedBackground: mix(DANGER, 22),
  addedGutterBackground: mix(SUCCESS, 9),
  removedGutterBackground: mix(DANGER, 9),
  addedGutterColor: 'var(--subtle-foreground)',
  removedGutterColor: 'var(--subtle-foreground)',
  gutterBackground: 'transparent',
  gutterBackgroundDark: 'transparent',
  gutterColor: 'var(--subtle-foreground)',
  codeFoldBackground: 'color-mix(in srgb, var(--foreground) 3%, transparent)',
  codeFoldGutterBackground: 'color-mix(in srgb, var(--foreground) 3%, transparent)',
  codeFoldContentColor: 'var(--subtle-foreground)',
  addedColor: 'var(--foreground)',
  removedColor: 'var(--foreground)',
  emptyLineBackground: 'transparent',
}

const sharedStyles = {
  codeFold: {
    fontSize: '11.5px',
    fontWeight: 400,
    fontFamily: MONO,
  },
  codeFoldContent: {
    fontFamily: MONO,
    fontSize: '11.5px',
  },
  line: {
    fontSize: '12.5px',
    fontFamily: MONO,
  },
  gutter: {
    fontSize: '11.5px',
    fontFamily: MONO,
    minWidth: '44px',
    padding: '0 10px',
  },
  marker: {
    '&[class*="diff-added"] pre': { color: SUCCESS },
    '&[class*="diff-removed"] pre': { color: DANGER },
  },
  contentText: {
    fontFamily: MONO,
    fontSize: '12.5px',
    lineHeight: '1.75',
  },
  content: {
    width: 'auto',
  },
  diffContainer: {
    borderRadius: '0',
    pre: { lineHeight: '1.75' },
  },
}

export const forgeDiffDarkStyles = {
  variables: { dark: palette },
  ...sharedStyles,
}

export const forgeDiffLightStyles = {
  variables: { light: palette },
  ...sharedStyles,
}

/**
 * Hook that returns the correct diff theme based on Forge's current light/dark mode.
 * Listens for class changes on <html> so it reacts to runtime theme switches.
 */
export function useDiffTheme() {
  const [isDark, setIsDark] = useState(() => {
    if (typeof document === 'undefined') return true
    return document.documentElement.classList.contains('dark')
  })

  useEffect(() => {
    const el = document.documentElement
    const observer = new MutationObserver(() => {
      setIsDark(el.classList.contains('dark'))
    })
    observer.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return {
    styles: isDark ? forgeDiffDarkStyles : forgeDiffLightStyles,
    useDarkTheme: isDark,
  }
}
