import { lookup } from 'node:dns/promises'
import type { LinkPreview } from '@shared/ipc'
import { isBlockedHostname, isPrivateAddress, parseHtmlPreview } from '@shared/links'
import { getSettings } from '../settings'


const PAGE_BYTES = 512 * 1024
const IMAGE_BYTES = 400 * 1024
const ICON_BYTES = 64 * 1024
const TIMEOUT_MS = 6000
const MAX_REDIRECTS = 5
const CACHE_TTL = 30 * 60 * 1000
const USER_AGENT = 'Mozilla/5.0 (Macintosh) KilnLinkPreview/1.0'

// Tests serve pages from 127.0.0.1; never set in normal use.
const allowPrivate = !!process.env.KILN_ALLOW_PRIVATE_PREVIEWS

/** Refuse URLs that would make this Mac talk to its own network (routers, local services). */
async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) links get previews')
  if (allowPrivate) return
  if (isBlockedHostname(url.hostname) || isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Local address')
  const addresses = await lookup(url.hostname, { all: true })
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) throw new Error('Resolves to a local address')
}

/** GET with manual redirects, re-checking every hop, and a byte cap. */
async function capturedGet(start: string, maxBytes: number, stopAtHead = false): Promise<{ url: string; type: string; body: Buffer }> {
  let url = new URL(start)
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url)
    const res = await fetch(url, { redirect: 'manual', signal, headers: { 'User-Agent': USER_AGENT, Accept: stopAtHead ? 'text/html' : '*/*' } })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url)
      continue
    }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const chunks: Buffer[] = []
    let size = 0
    const reader = res.body.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      size += value.length
      if (size > maxBytes) {
        if (!stopAtHead) throw new Error('Too large')
        break
      }
      // Metadata lives in <head>; stop reading once it's over.
      if (stopAtHead && /<\/head>/i.test(Buffer.from(value).toString('latin1'))) break
    }
    await reader.cancel().catch(() => {})
    return { url: url.toString(), type: res.headers.get('content-type') ?? '', body: Buffer.concat(chunks) }
  }
  throw new Error('Too many redirects')
}

async function asDataUrl(src: string | null, maxBytes: number): Promise<string | null> {
  if (!src) return null
  try {
    const { type, body } = await capturedGet(src, maxBytes)
    const mime = type.split(';')[0].trim().toLowerCase()
    if (!mime.startsWith('image/') || !body.length) return null
    return `data:${mime};base64,${body.toString('base64')}`
  } catch {
    return null
  }
}

async function load(href: string): Promise<LinkPreview | null> {
  try {
    const page = await capturedGet(href, PAGE_BYTES, true)
    if (!/text\/html|application\/xhtml/i.test(page.type)) return null
    const meta = parseHtmlPreview(page.body.toString('utf8'), page.url)
    const [image, icon] = await Promise.all([asDataUrl(meta.image, IMAGE_BYTES), asDataUrl(meta.icon, ICON_BYTES)])
    if (!meta.title && !meta.description && !image) return null
    return { ...meta, image, icon }
  } catch {
    return null
  }
}

const cache = new Map<string, { at: number; value: Promise<LinkPreview | null> }>()

/**
 * Page preview for a link, fetched from this Mac only when the user has turned previews on.
 * Cached (including failures) and de-duplicated, so hovering the same link again is instant.
 */
export function linkPreview(href: string): Promise<LinkPreview | null> {
  if (!getSettings().links.previews) return Promise.resolve(null)
  const hit = cache.get(href)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value
  const value = load(href)
  cache.set(href, { at: Date.now(), value })
  if (cache.size > 300) cache.delete(cache.keys().next().value!)
  return value
}
