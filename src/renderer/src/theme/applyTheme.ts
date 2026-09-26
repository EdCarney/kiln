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
  for (const key of PALETTE_KEYS) root.style.setProperty(`--o-${key}`, palette[key] ?? fallback[key])
  root.style.setProperty('--o-dangerFg', textOn(palette.danger ?? fallback.danger, palette, dark))
  root.style.setProperty('--o-font-ui', theme.fonts.ui)
  root.style.setProperty('--o-font-reading', theme.fonts.reading)
  root.style.setProperty('--o-font-mono', theme.fonts.mono)
  root.style.setProperty('--o-radius', `${theme.radius}px`)
  root.style.setProperty('--o-font-size', `${appearance.fontSize}px`)
  root.style.setProperty('--o-chat-width', `${appearance.chatWidth}px`)
  root.style.setProperty('--o-response-font', appearance.responseFont === 'reading' ? 'var(--o-font-reading)' : 'var(--o-font-ui)')
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
  return palette.canvas
}
