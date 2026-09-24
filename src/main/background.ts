import { nativeTheme } from 'electron'
import { BUILTIN_THEMES } from '@shared/themes'
import { listCustomThemes } from './db/kv'
import { getSettings } from './settings'

/** The current theme's canvas colour, so new windows don't flash white before the page paints. */
export function currentBackground(): string {
  const { themeId, mode } = getSettings().appearance
  const theme = [...BUILTIN_THEMES, ...listCustomThemes()].find((t) => t.id === themeId) ?? BUILTIN_THEMES[0]
  const dark = mode === 'dark' || (mode === 'system' && nativeTheme.shouldUseDarkColors)
  return (dark ? theme.dark : theme.light).canvas
}
