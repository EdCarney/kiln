import { useEffect, useState } from 'react'
import { FONT_CHOICES } from '@shared/themes'
import type { Palette, PaletteKey, ThemeDef } from '@shared/types'
import { api } from '@/lib/api'
import { cn } from '@/lib/format'
import { reportError, useApp } from '@/stores/app'
import { isDark } from '@/theme/applyTheme'
import { Button, Field, Modal, TextField } from './ui'

const GROUPS: Array<{ label: string; keys: Array<[PaletteKey, string]> }> = [
  {
    label: 'Surfaces',
    keys: [
      ['canvas', 'Background'],
      ['sidebar', 'Sidebar'],
      ['panel', 'Cards & composer'],
      ['bubble', 'Your messages'],
      ['code', 'Code blocks'],
      ['hover', 'Hover']
    ]
  },
  {
    label: 'Text & lines',
    keys: [
      ['fg', 'Text'],
      ['muted', 'Secondary text'],
      ['subtle', 'Hints'],
      ['line', 'Borders'],
      ['lineStrong', 'Strong borders']
    ]
  },
  {
    label: 'Accent',
    keys: [
      ['accent', 'Accent'],
      ['accentFg', 'Text on accent'],
      ['accentSoft', 'Accent tint'],
      ['danger', 'Danger']
    ]
  },
  {
    label: 'Syntax',
    keys: [
      ['synKeyword', 'Keywords'],
      ['synString', 'Strings'],
      ['synFunction', 'Functions'],
      ['synConstant', 'Constants'],
      ['synComment', 'Comments'],
      ['synPunctuation', 'Punctuation']
    ]
  }
]

// Colour inputs only take #rrggbb; keep any alpha from rgba() values when the swatch changes.
function toHex(value: string): string {
  if (value.startsWith('#')) return value.length === 4 ? `#${[...value.slice(1)].map((c) => c + c).join('')}` : value.slice(0, 7)
  const m = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
  return m ? `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : '#000000'
}

function withHex(original: string, hex: string): string {
  const alpha = original.match(/rgba\([^)]*,\s*([\d.]+)\s*\)/)?.[1]
  if (!alpha) return hex
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2">
      <span className="relative size-7 shrink-0 overflow-hidden rounded-md border border-line-strong" style={{ background: value }}>
        <input type="color" value={toHex(value)} onChange={(e) => onChange(withHex(value, e.target.value))} className="absolute inset-0 cursor-pointer opacity-0" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-muted">{label}</span>
        <input value={value} onChange={(e) => onChange(e.target.value)} className="w-full bg-transparent font-mono text-[11px] text-subtle outline-none" spellCheck={false} />
      </span>
    </label>
  )
}

export function ThemeEditor({ base, open, onClose }: { base: ThemeDef; open: boolean; onClose: () => void }) {
  const { settings, setPreviewTheme, loadThemes, updateSettings } = useApp()
  const [draft, setDraft] = useState<ThemeDef>(base)
  const [variant, setVariant] = useState<'light' | 'dark'>(isDark(settings?.appearance.mode ?? 'system') ? 'dark' : 'light')

  useEffect(() => {
    if (!open) return
    setDraft(base.builtin ? { ...base, id: `custom-${Date.now().toString(36)}`, name: `${base.name} (custom)`, builtin: false } : base)
  }, [open, base])

  // Live preview while the editor is open.
  useEffect(() => {
    if (open) setPreviewTheme(draft)
    return () => setPreviewTheme(null)
  }, [open, draft, setPreviewTheme])

  const setColor = (key: PaletteKey, value: string) => setDraft((d) => ({ ...d, [variant]: { ...d[variant], [key]: value } as Palette }))

  const save = async () => {
    try {
      const saved = await api.themes.save(draft)
      await loadThemes()
      await updateSettings({ appearance: { themeId: saved.id } })
      onClose()
    } catch (err) {
      reportError(err)
    }
  }

  const mismatch = isDark(settings?.appearance.mode ?? 'system') !== (variant === 'dark')

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Customize theme"
      description="Changes preview live. Each theme has a light and a dark palette."
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!draft.name.trim()} onClick={save}>
            Save theme
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name">
            <TextField value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label={`Corner radius: ${draft.radius}px`}>
            <input type="range" min={0} max={20} value={draft.radius} onChange={(e) => setDraft({ ...draft, radius: Number(e.target.value) })} className="mt-2 w-full accent-[var(--k-accent)]" />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-4">
          {(['ui', 'reading', 'mono'] as const).map((slot) => (
            <Field key={slot} label={slot === 'ui' ? 'Interface font' : slot === 'reading' ? 'Reply font' : 'Code font'}>
              <select
                value={draft.fonts[slot]}
                onChange={(e) => setDraft({ ...draft, fonts: { ...draft.fonts, [slot]: e.target.value } })}
                className="h-9 w-full rounded-kiln border border-line bg-canvas px-2 text-sm outline-none"
              >
                {FONT_CHOICES[slot].map((f) => (
                  <option key={f.label} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
          ))}
        </div>

        <div>
          <div className="mb-3 flex items-center gap-3">
            <div className="flex rounded-lg bg-hover p-0.5 text-xs">
              {(['light', 'dark'] as const).map((v) => (
                <button key={v} onClick={() => setVariant(v)} className={cn('rounded-md px-3 py-1 capitalize', variant === v ? 'bg-panel text-fg shadow-sm' : 'text-muted')}>
                  {v} palette
                </button>
              ))}
            </div>
            {mismatch && <span className="text-xs text-subtle">The app is in {variant === 'dark' ? 'light' : 'dark'} mode, so this palette isn't shown live.</span>}
          </div>
          <div className="space-y-4">
            {GROUPS.map((g) => (
              <div key={g.label}>
                <div className="mb-2 text-xs font-medium text-subtle">{g.label}</div>
                <div className="grid grid-cols-3 gap-x-4 gap-y-3">
                  {g.keys.map(([key, label]) => (
                    <ColorField key={key} label={label} value={draft[variant][key]} onChange={(v) => setColor(key, v)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}
