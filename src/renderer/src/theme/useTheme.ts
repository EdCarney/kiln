import { useEffect, useState } from 'react'
import { BUILTIN_THEMES } from '@shared/themes'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { applyTheme, onSystemThemeChange } from './applyTheme'

/** Apply the saved (or previewed) theme to this window, following system light/dark changes. */
export function useTheme(): void {
  const settings = useApp((s) => s.settings)
  const themes = useApp((s) => s.themes)
  const preview = useApp((s) => s.previewTheme)
  const [systemTick, setSystemTick] = useState(0)

  useEffect(() => onSystemThemeChange(() => setSystemTick((n) => n + 1)), [])

  useEffect(() => {
    if (!settings) return
    const theme = preview ?? themes.find((t) => t.id === settings.appearance.themeId) ?? BUILTIN_THEMES[0]
    const background = applyTheme(theme, settings.appearance)
    void api.app.setNativeTheme(settings.appearance.mode, background)
  }, [settings, themes, preview, systemTick])
}
