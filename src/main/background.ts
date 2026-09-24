import { nativeTheme } from 'electron'
import { BUILTIN_THEMES, usesDark } from '@shared/themes'
import type { ThemeDef } from '@shared/types'
import { listCustomThemes } from './db/kv'
import { getSettings } from './settings'

function currentTheme(): ThemeDef {
  const { themeId } = getSettings().appearance
  return [...BUILTIN_THEMES, ...listCustomThemes()].find((t) => t.id === themeId) ?? BUILTIN_THEMES[0]
}

/** The mode for native UI: the user's choice, unless the theme has only one palette. */
export function currentThemeSource(): 'system' | 'light' | 'dark' {
  return currentTheme().only ?? getSettings().appearance.mode
}

/** The current theme's canvas colour, so new windows don't flash white before the page paints. */
export function currentBackground(): string {
  const theme = currentTheme()
  const dark = usesDark(theme, getSettings().appearance.mode, nativeTheme.shouldUseDarkColors)
  return (dark ? theme.dark : theme.light).canvas
}
