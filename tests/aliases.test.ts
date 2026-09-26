import { describe, expect, it } from 'vitest'
import { resolveWebCall } from '../src/main/chat/aliases'

describe('resolveWebCall', () => {
  it('passes the real tool names through', () => {
    expect(resolveWebCall('web_search', { query: 'ollmost news', max_results: 3 })).toEqual({
      tool: 'web_search',
      query: 'ollmost news',
      maxResults: 3
    })
    expect(resolveWebCall('web_fetch', { url: 'https://example.com' })).toEqual({ tool: 'web_fetch', url: 'https://example.com' })
  })

  it('maps the names gpt-oss reached for in practice', () => {
    expect(resolveWebCall('browser.search', { query: 'top stories' })).toMatchObject({ tool: 'web_search', query: 'top stories' })
    expect(resolveWebCall('browser.open', { id: 'https://news.google.com/topstories' })).toEqual({
      tool: 'web_fetch',
      url: 'https://news.google.com/topstories'
    })
    expect(resolveWebCall('http.get', { url: 'https://a.io' })).toEqual({ tool: 'web_fetch', url: 'https://a.io' })
    expect(resolveWebCall('fetch', { link: 'https://b.io' })).toEqual({ tool: 'web_fetch', url: 'https://b.io' })
    expect(resolveWebCall('web.fetch', { url: 'https://c.io' })).toEqual({ tool: 'web_fetch', url: 'https://c.io' })
  })

  it('decides catch-all tools like web.run by their arguments', () => {
    expect(resolveWebCall('web.run', { open: [{ ref_id: 'https://d.io' }] })).toEqual({ tool: 'web_fetch', url: 'https://d.io' })
    expect(resolveWebCall('web.run', { search_query: [{ q: 'ai news' }] })).toMatchObject({ tool: 'web_search', query: 'ai news' })
  })

  it('refuses anything ambiguous or non-web', () => {
    expect(resolveWebCall('browser.open', { id: 3 })).toBeNull() // gpt-oss result-index form: no URL
    expect(resolveWebCall('fetch', { url: 'file:///etc/passwd' })).toBeNull()
    expect(resolveWebCall('python', { code: 'print(1)' })).toBeNull()
    expect(resolveWebCall('web_search', {})).toBeNull()
  })
})
