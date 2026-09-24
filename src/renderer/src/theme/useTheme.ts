import { useEffect, useSyncExternalStore } from 'react'
import { BUILTIN_THEMES, usesDark } from '@shared/themes'
import type { Palette, ThemeDef } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { applyTheme, onSystemThemeChange, systemIsDark } from './applyTheme'

/** The OS light/dark setting, re-rendering when it changes. */
export function useSystemDark(): boolean {
  return useSyncExternalStore(onSystemThemeChange, systemIsDark)
}

/** The theme on screen (the editor's live preview wins), whether it's showing dark, and that palette. */
export function useActiveTheme(): { theme: ThemeDef; dark: boolean; palette: Palette } {
  const themeId = useApp((s) => s.settings?.appearance.themeId)
  const mode = useApp((s) => s.settings?.appearance.mode ?? 'system')
  const themes = useApp((s) => s.themes)
  const preview = useApp((s) => s.previewTheme)
  const systemDark = useSystemDark()
  const theme = preview ?? themes.find((t) => t.id === themeId) ?? BUILTIN_THEMES[0]
  const dark = usesDark(theme, mode, systemDark)
  return { theme, dark, palette: dark ? theme.dark : theme.light }
}

/** Apply the saved (or previewed) theme to this window, following system light/dark changes. */
export function useTheme(): void {
  const settings = useApp((s) => s.settings)
  const { theme, dark } = useActiveTheme()

  useEffect(() => {
    if (!settings) return
    const background = applyTheme(theme, settings.appearance)
    // A single-palette theme sets the native side too (menus, scrollbars, form controls).
    void api.app.setNativeTheme(theme.only ?? settings.appearance.mode, background)
  }, [settings, theme, dark])
}
