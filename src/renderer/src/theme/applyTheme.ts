import { BUILTIN_THEMES, textOn, usesDark } from '@shared/themes'
import { PALETTE_KEYS, type Settings, type ThemeDef } from '@shared/types'

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

export function systemIsDark(): boolean {
  return darkQuery.matches
}

export function onSystemThemeChange(cb: () => void): () => void {
  darkQuery.addEventListener('change', cb)
  return () => darkQuery.removeEventListener('change', cb)
}

/** Write a theme's tokens onto <html>; returns the canvas colour for the native window. */
export function applyTheme(theme: ThemeDef, appearance: Settings['appearance']): string {
  const dark = usesDark(theme, appearance.mode, systemIsDark())
  const palette = dark ? theme.dark : theme.light
  // Themes saved before a token existed fall back to the default theme's value for it.
  const fallback = dark ? BUILTIN_THEMES[0].dark : BUILTIN_THEMES[0].light
  const root = document.documentElement
  for (const key of PALETTE_KEYS) root.style.setProperty(`--k-${key}`, palette[key] ?? fallback[key])
  root.style.setProperty('--k-dangerFg', textOn(palette.danger ?? fallback.danger, palette, dark))
  root.style.setProperty('--k-font-ui', theme.fonts.ui)
  root.style.setProperty('--k-font-reading', theme.fonts.reading)
  root.style.setProperty('--k-font-mono', theme.fonts.mono)
  root.style.setProperty('--k-radius', `${theme.radius}px`)
  root.style.setProperty('--k-font-size', `${appearance.fontSize}px`)
  root.style.setProperty('--k-chat-width', `${appearance.chatWidth}px`)
  root.style.setProperty(
    '--k-response-font',
    appearance.responseFont === 'reading' ? 'var(--k-font-reading)' : 'var(--k-font-ui)'
  )
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
  return palette.canvas
}
