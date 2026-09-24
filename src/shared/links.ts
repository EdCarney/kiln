// Pure helpers for link hover cards: page metadata, address safety and display.

export interface PagePreview {
  url: string
  title: string | null
  description: string | null
  siteName: string | null
  /** Image and icon URLs as found in the page (resolved); the main process turns them into data URLs. */
  image: string | null
  icon: string | null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  return out
}

function resolve(href: string | undefined, base: string): string | null {
  if (!href) return null
  try {
    const u = new URL(decodeEntities(href.trim()), base)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

const clean = (s: string | undefined | null, max: number): string | null => {
  const t = s ? decodeEntities(s).replace(/\s+/g, ' ').trim() : ''
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : null
}

/** OpenGraph / Twitter / plain-HTML metadata from a page's <head>. */
export function parseHtmlPreview(html: string, pageUrl: string): PagePreview {
  const head = html.slice(0, (html.search(/<\/head>/i) + 1 || html.length + 1) - 1 || html.length)
  const meta: Record<string, string> = {}
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0])
    const key = (a.property ?? a.name ?? '').toLowerCase()
    if (key && a.content && !(key in meta)) meta[key] = a.content
  }
  let icon: string | null = null
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0])
    const rel = (a.rel ?? '').toLowerCase()
    if (/\b(icon|shortcut icon|apple-touch-icon)\b/.test(rel) && a.href) {
      icon = resolve(a.href, pageUrl)
      if (icon && !/apple-touch/.test(rel)) break
    }
  }
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  return {
    url: pageUrl,
    title: clean(meta['og:title'] ?? meta['twitter:title'] ?? titleTag, 160),
    description: clean(meta['og:description'] ?? meta['twitter:description'] ?? meta.description, 300),
    siteName: clean(meta['og:site_name'], 80),
    image: resolve(meta['og:image'] ?? meta['og:image:url'] ?? meta['twitter:image'], pageUrl),
    icon: icon ?? resolve('/favicon.ico', pageUrl)
  }
}

/**
 * Loopback, private, link-local and similar addresses. Hover previews must never make this Mac send
 * requests into the local network (a link in a reply could point at a router or local service).
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  const parts = v4.split('.').map(Number)
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    )
  }
  const v6 = ip.toLowerCase()
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)
}

export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')
}

/** "https://www.example.com/a/very/long/path" → "https://www.example.com/a/…/path" within `max` chars. */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text
  const keep = max - 1
  const head = Math.ceil(keep * 0.6)
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
}

export function hostnameOf(href: string): string | null {
  try {
    return new URL(href).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/**
 * When a link's visible text is itself a domain or URL, return that domain if it differs from where
 * the link actually goes (the classic "text says bank.com, link goes elsewhere" trick).
 */
export function mismatchedLinkText(text: string, href: string): string | null {
  const shown = text.trim().match(/^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]\S*)?$/i)?.[1]?.toLowerCase().replace(/^www\./, '')
  const actual = hostnameOf(href)
  if (!shown || !actual) return null
  return actual === shown || actual.endsWith(`.${shown}`) ? null : shown
}
