import { Brain, Check } from 'lucide-react'
import { normalizeThinkSetting } from '@shared/thinking'
import type { ThinkProfile, ThinkSetting } from '@shared/types'
import { cn } from '@/lib/format'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tooltip } from './ui'

const LEVELS: Array<{ value: ThinkSetting; label: string; hint: string }> = [
  { value: 'low', label: 'Low', hint: 'Quick, light reasoning' },
  { value: 'medium', label: 'Medium', hint: 'Balanced' },
  { value: 'high', label: 'High', hint: 'Deepest reasoning, slowest' }
]

const pill = 'flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] transition-colors'

/** Renders differently per model: hidden, an on/off toggle, an effort menu, or a fixed badge. */
export function ThinkingControl({
  profile,
  value,
  onChange
}: {
  profile: ThinkProfile
  value: ThinkSetting | null
  onChange: (v: ThinkSetting) => void
}) {
  const setting = normalizeThinkSetting(profile, value)

  if (profile.kind === 'none') return null

  if (profile.kind === 'always')
    return (
      <Tooltip content={profile.note ?? 'This model always thinks before answering.'}>
        <span className={cn(pill, 'text-subtle')}>
          <Brain className="size-4" /> Thinking
        </span>
      </Tooltip>
    )

  if (profile.kind === 'toggle') {
    const on = setting === 'on'
    return (
      <Tooltip content={on ? 'Thinking is on: the model reasons before answering' : 'Turn on thinking'}>
        <button
          onClick={() => onChange(on ? 'off' : 'on')}
          aria-pressed={on}
          className={cn(pill, on ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-fg')}
        >
          <Brain className="size-4" /> {on ? 'Thinking' : 'Think'}
        </button>
      </Tooltip>
    )
  }

  const options = profile.canDisable ? [{ value: 'off' as ThinkSetting, label: 'Off', hint: 'Answer directly' }, ...LEVELS] : LEVELS
  const current = options.find((o) => o.value === setting)
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className={cn(pill, setting !== 'off' ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-fg')}>
          <Brain className="size-4" /> {current && current.value !== 'off' ? `${current.label} effort` : 'Think'}
        </button>
      </MenuTrigger>
      <MenuContent side="top">
        <MenuLabel>Reasoning effort</MenuLabel>
        {options.map((o) => (
          <MenuItem
            key={o.value}
            onSelect={() => onChange(o.value)}
            icon={o.value === setting ? <Check className="size-4 text-accent" /> : null}
          >
            <span className="flex-1">
              <span className="block">{o.label}</span>
              <span className="block text-xs text-subtle">{o.hint}</span>
            </span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}
