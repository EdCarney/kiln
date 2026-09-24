/**
 * Models trained with built-in browsing tools (gpt-oss's `browser.*`, OpenAI-style `web.run`, …)
 * often call those names even when offered `web_search` / `web_fetch`. When the intent and argument
 * are unambiguous, route the call to the real tool instead of bouncing it back as unknown.
 */

export type WebToolCall = { tool: 'web_search'; query: string; maxResults?: number } | { tool: 'web_fetch'; url: string }

const SEARCH_NAMES = new Set(['browser.search', 'web.search', 'search', 'websearch', 'web_search_preview', 'google_search', 'search_web'])
const FETCH_NAMES = new Set(['browser.open', 'web.fetch', 'web.open', 'fetch', 'http.get', 'open_url', 'fetch_url', 'webfetch', 'browse'])

const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

function firstString(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = asString(item) ?? (item && typeof item === 'object' ? firstString(Object.values(item)) : null)
      if (s) return s
    }
    return null
  }
  return asString(v)
}

function queryFrom(args: Record<string, unknown>): string | null {
  return asString(args.query) ?? asString(args.q) ?? firstString(args.search_query) ?? asString(args.search)
}

function urlFrom(args: Record<string, unknown>): string | null {
  for (const candidate of [args.url, args.link, args.href, args.id, args.ref_id, args.uri]) {
    const s = asString(candidate)
    if (s && /^https?:\/\//i.test(s)) return s
  }
  const open = firstString(args.open)
  return open && /^https?:\/\//i.test(open) ? open : null
}

/** Map a call to web_search/web_fetch, or null if it isn't a recognisable web call. */
export function resolveWebCall(name: string, args: Record<string, unknown>): WebToolCall | null {
  const n = name.trim().toLowerCase()
  const max = typeof args.max_results === 'number' ? args.max_results : undefined
  if (n === 'web_search' || SEARCH_NAMES.has(n)) {
    const query = queryFrom(args)
    return query ? { tool: 'web_search', query, maxResults: max } : null
  }
  if (n === 'web_fetch' || FETCH_NAMES.has(n)) {
    const url = urlFrom(args)
    return url ? { tool: 'web_fetch', url } : null
  }
  // Catch-all browsing tools: decide by which argument they carry.
  if (n === 'web.run' || n === 'browser' || n === 'web') {
    const url = urlFrom(args)
    if (url) return { tool: 'web_fetch', url }
    const query = queryFrom(args)
    if (query) return { tool: 'web_search', query, maxResults: max }
  }
  return null
}
