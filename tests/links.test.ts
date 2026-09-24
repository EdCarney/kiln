import { describe, expect, it } from 'vitest'
import { isBlockedHostname, isPrivateAddress, middleTruncate, mismatchedLinkText, parseHtmlPreview } from '@shared/links'

describe('parseHtmlPreview', () => {
  it('prefers OpenGraph, decodes entities and resolves relative URLs', () => {
    const html = `<html><head><title>Fallback</title>
      <meta property="og:title" content="Rust &amp; WASM in 2026">
      <meta name="description" content="Plain description">
      <meta property="og:description" content='OG &quot;description&quot;'>
      <meta property="og:site_name" content="Example News">
      <meta property="og:image" content="/img/cover.png">
      <link rel="icon" href="/favicon-32.png">
      </head><body><meta property="og:title" content="ignored, in body"></body></html>`
    expect(parseHtmlPreview(html, 'https://news.example.com/story/1')).toEqual({
      url: 'https://news.example.com/story/1',
      title: 'Rust & WASM in 2026',
      description: 'OG "description"',
      siteName: 'Example News',
      image: 'https://news.example.com/img/cover.png',
      icon: 'https://news.example.com/favicon-32.png'
    })
  })

  it('falls back to <title>, meta description and /favicon.ico', () => {
    const p = parseHtmlPreview('<head><title> Just a  page </title><meta name="description" content="Hi"></head>', 'https://a.io/x')
    expect(p).toMatchObject({ title: 'Just a page', description: 'Hi', image: null, icon: 'https://a.io/favicon.ico' })
  })

  it('ignores non-http image URLs', () => {
    expect(parseHtmlPreview('<meta property="og:image" content="javascript:alert(1)">', 'https://a.io').image).toBeNull()
  })
})

describe('address safety', () => {
  it('flags private, loopback and link-local addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.2'])
      expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false)
  })

  it('flags local hostnames', () => {
    for (const h of ['localhost', 'router.local', 'printer', 'api.localhost']) expect(isBlockedHostname(h), h).toBe(true)
    expect(isBlockedHostname('news.example.com')).toBe(false)
  })
})

describe('display helpers', () => {
  it('truncates long URLs in the middle', () => {
    const t = middleTruncate('https://www.example.com/a/very/long/path/to/the/article/page', 30)
    expect(t).toHaveLength(30)
    expect(t.startsWith('https://www.exam')).toBe(true)
    expect(t).toContain('…')
    expect(t.endsWith('ticle/page')).toBe(true)
  })

  it('spots link text that names a different domain than the link', () => {
    expect(mismatchedLinkText('paypal.com', 'https://evil.example/login')).toBe('paypal.com')
    expect(mismatchedLinkText('https://www.reuters.com/world', 'https://reuters.com/world/x')).toBeNull()
    expect(mismatchedLinkText('example.com', 'https://news.example.com')).toBeNull()
    expect(mismatchedLinkText('Read more', 'https://anything.io')).toBeNull()
  })
})
