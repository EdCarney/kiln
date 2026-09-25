import { describe, expect, it } from 'vitest'
import { promptAnatomy, redactImages, stripImagePlaceholders, toCurl } from '@shared/debug'

const body = {
  model: 'gpt-oss:120b-cloud',
  messages: [
    {
      role: 'system',
      content: 'You are helpful.\n\n<artifacts>' + 'a'.repeat(400) + '</artifacts>\n\n<skills>' + 'b'.repeat(80) + '</skills>'
    },
    { role: 'user', content: 'x'.repeat(40) },
    { role: 'assistant', content: 'y'.repeat(80) },
    { role: 'user', content: 'what is this?', images: ['A'.repeat(4096)] }
  ],
  tools: [{ type: 'function', function: { name: 'web_search' } }]
}

describe('debug helpers', () => {
  it('replaces image bytes with a size placeholder and can strip them for replay', () => {
    const red = redactImages(body)
    expect(red.messages[3].images).toEqual(['<image 3 KB>'])
    expect(body.messages[3].images![0]).toHaveLength(4096) // original untouched
    const { body: clean, removed } = stripImagePlaceholders(red)
    expect(removed).toBe(1)
    expect(clean.messages[3]).not.toHaveProperty('images')
  })

  it('breaks a request into system sections, history, latest turn, tools and images', () => {
    const { segments, total } = promptAnatomy(body)
    const labels = segments.map((s) => s.label)
    expect(labels).toEqual([
      'Base instructions',
      'Artifact instructions',
      'Skill index',
      'Earlier user messages',
      'Earlier assistant messages',
      'Latest message',
      'Tool definitions (1)',
      'Images (1)'
    ])
    expect(segments.find((s) => s.label === 'Images (1)')?.tokens).toBe(1600)
    expect(total).toBe(segments.reduce((n, s) => n + s.tokens, 0))
  })

  it('builds a non-streaming curl command without embedding a key', () => {
    const curl = toCurl('https://ollama.com/api/chat', redactImages(body), true)
    expect(curl).toContain('Bearer $OLLAMA_API_KEY')
    expect(curl).toContain('"stream": false')
    expect(curl).toContain("1 image(s) weren't recorded")
    expect(toCurl('http://127.0.0.1:11434/api/chat', { model: 'm', messages: [] }, false)).not.toContain('Authorization')
  })
})
