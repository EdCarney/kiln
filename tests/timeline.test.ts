import { describe, expect, it } from 'vitest'
import { parseMessage, parseMessageRanges } from '../src/shared/artifactParser'
import { interleave, type TimelineItem } from '../src/shared/timeline'
import type { ToolEvent } from '../src/shared/types'

const ev = (tool: string, at?: number): ToolEvent => ({ tool, args: {}, ok: true, summary: tool, ...(at === undefined ? {} : { at }) })

/** A compact picture of the timeline: text as-is, artifacts as [artifact id], tool groups as tools(a,b). */
function shape(content: string, events: ToolEvent[]): string[] {
  return interleave(parseMessageRanges(content), events).map((item: TimelineItem) =>
    item.kind === 'tools'
      ? `tools(${item.events.map((e) => `${e.event.tool}#${e.index}`).join(',')})`
      : item.segment.kind === 'text'
        ? item.segment.text
        : `[artifact ${item.segment.identifier}]`
  )
}

describe('parseMessageRanges', () => {
  it('gives each segment its range in the raw text, and parseMessage stays the same', () => {
    const raw = 'Intro.\n<artifact identifier="a" type="code" title="A">x = 1</artifact>\nOutro.'
    const ranged = parseMessageRanges(raw)
    expect(ranged.map((s) => raw.slice(s.start, s.end))).toEqual([
      'Intro.\n',
      '<artifact identifier="a" type="code" title="A">x = 1</artifact>',
      '\nOutro.'
    ])
    expect(parseMessage(raw)).toEqual(ranged.map(({ start: _s, end: _e, ...seg }) => seg))
  })
})

describe('interleave', () => {
  it('puts a call at the point in the text where it was made', () => {
    const content = 'Let me search.\n\nHere is what I found.'
    expect(shape(content, [ev('web_search', 14)])).toEqual(['Let me search.', 'tools(web_search#0)', '\n\nHere is what I found.'])
  })

  it('keeps calls made at the same point together, in call order', () => {
    const content = 'Checking.\n\nDone.'
    expect(shape(content, [ev('b', 9), ev('a', 9), ev('c', 17)])).toEqual(['Checking.', 'tools(b#0,a#1)', '\n\nDone.', 'tools(c#2)'])
  })

  it('shows calls from before positions were recorded first, as it used to', () => {
    expect(shape('Answer.', [ev('web_search'), ev('web_fetch')])).toEqual(['tools(web_search#0,web_fetch#1)', 'Answer.'])
  })

  it('shows a call still running at the end of the streamed text', () => {
    expect(shape('Let me look.', [ev('web_fetch', 12)])).toEqual(['Let me look.', 'tools(web_fetch#0)'])
    expect(shape('', [ev('web_fetch', 0)])).toEqual(['tools(web_fetch#0)'])
  })

  it('never splits an artifact: a call inside one goes after it', () => {
    const content = 'Here:\n<artifact identifier="page" type="html" title="Page"><p>hi</p></artifact>\nBye.'
    const inside = content.indexOf('<p>')
    expect(shape(content, [ev('tool', inside)])).toEqual(['Here:\n', '[artifact page]', 'tools(tool#0)', '\nBye.'])
  })

  it('never splits a fenced code block: a call inside one goes after its closing fence', () => {
    const content = 'Code:\n```js\nlet a = 1\nlet b = 2\n```\nAfter.'
    const inside = content.indexOf('let b')
    expect(shape(content, [ev('tool', inside)])).toEqual(['Code:\n```js\nlet a = 1\nlet b = 2\n```\n', 'tools(tool#0)', 'After.'])
  })

  it('places a call even when the text around an artifact was trimmed (a stray wrapping fence)', () => {
    const content = 'Look:\n```\n<artifact identifier="n" type="markdown" title="N">note</artifact>\n```\nEnd.'
    const items = shape(content, [ev('tool', content.indexOf('\n```\nEnd') + 2)])
    expect(items).toContain('tools(tool#0)')
    expect(items.filter((i) => i.startsWith('tools'))).toHaveLength(1)
  })

  it('drops whitespace-only text between calls', () => {
    expect(shape('A.\n\n\n\nB.', [ev('x', 2), ev('y', 4)])).toEqual(['A.', 'tools(x#0,y#1)', '\n\nB.'])
  })
})
