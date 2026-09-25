import type { RangedSegment, Segment } from './artifactParser'
import type { ToolEvent } from './types'

/** A tool event with its position in the message's `toolEvents` (the stream updates events by index). */
export interface IndexedToolEvent {
  event: ToolEvent
  index: number
}

export type TimelineItem = { kind: 'segment'; segment: Segment } | { kind: 'tools'; events: IndexedToolEvent[] }

const FENCE_LINE = /^[ \t]*(```|~~~)/gm

/**
 * Where to split a text segment so a tool group can sit at `local`: never inside a fenced code block, which
 * would break the Markdown on both sides. A split inside one moves to just after the closing fence.
 */
function safeSplit(text: string, local: number): number {
  const fences = [...text.matchAll(FENCE_LINE)].map((m) => m.index)
  const before = fences.filter((i) => i < local).length
  if (before % 2 === 0) return local
  const close = fences.find((i) => i >= local)
  if (close === undefined) return text.length
  const lineEnd = text.indexOf('\n', close)
  return lineEnd === -1 ? text.length : lineEnd + 1
}

/**
 * Put a reply's tool calls where they happened. Each event's `at` is how long the reply's text was when the
 * call was made. Calls from before `at` was recorded have none and go first, as they always used to.
 * A call made inside an artifact goes after it.
 */
export function interleave(segments: RangedSegment[], events: ToolEvent[]): TimelineItem[] {
  const items: TimelineItem[] = []
  const addTools = (group: IndexedToolEvent[]) => {
    if (!group.length) return
    const last = items[items.length - 1]
    if (last?.kind === 'tools') last.events.push(...group)
    else items.push({ kind: 'tools', events: group })
  }
  const addText = (text: string) => {
    if (text.trim()) items.push({ kind: 'segment', segment: { kind: 'text', text } })
  }

  const indexed = events.map((event, index) => ({ event, index }))
  addTools(indexed.filter((e) => e.event.at === undefined))
  const queue = indexed.filter((e) => e.event.at !== undefined).sort((a, b) => a.event.at! - b.event.at! || a.index - b.index)
  const takeUntil = (limit: number) => {
    let n = 0
    while (n < queue.length && queue[n].event.at! <= limit) n++
    return queue.splice(0, n)
  }

  for (const seg of segments) {
    addTools(takeUntil(seg.start))
    const { start: _start, end: _end, ...segment } = seg
    if (seg.kind === 'artifact') {
      items.push({ kind: 'segment', segment: segment as Segment })
      addTools(takeUntil(seg.end))
      continue
    }
    // Split the text at each call made inside it (grouping calls that land on the same safe point).
    let from = 0
    while (queue.length && queue[0].event.at! < seg.end) {
      const at = safeSplit(seg.text, Math.min(Math.max(queue[0].event.at! - seg.start, from), seg.text.length))
      addText(seg.text.slice(from, at))
      // At the end of the text, take every call inside the segment: its text may have been trimmed shorter
      // than its range (a stray fence), and a call past the trimmed end must not be left behind.
      addTools(takeUntil(at >= seg.text.length ? seg.end - 1 : seg.start + at))
      from = at
    }
    addText(seg.text.slice(from))
  }
  addTools(queue.splice(0))
  return items
}
