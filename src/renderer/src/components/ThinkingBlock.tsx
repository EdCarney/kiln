import { Brain, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { cn, formatDuration } from '@/lib/format'

export function ThinkingBlock({ thinking, active, durationMs }: { thinking: string; active: boolean; durationMs: number | null }) {
  const [open, setOpen] = useState(false)
  if (!thinking && !active) return null
  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="group flex items-center gap-1.5 rounded-md py-1 text-[13px] text-muted hover:text-fg"
        aria-expanded={open}
      >
        <Brain className="size-4" />
        <span className={cn(active && 'shimmer-text')}>
          {active ? 'Thinking…' : durationMs ? `Thought for ${formatDuration(durationMs)}` : 'Thought process'}
        </span>
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="selectable mt-1.5 max-h-96 overflow-y-auto whitespace-pre-wrap border-l-2 border-line pl-3.5 font-ui text-[13px] leading-relaxed text-muted">
          {thinking || '…'}
        </div>
      )}
    </div>
  )
}
