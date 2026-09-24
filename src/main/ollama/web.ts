import { getApiKey } from '../settings'
import { OLLAMA_CLOUD, OllamaError } from './client'

// Tests point this at a mock server.
const WEB_BASE = process.env.KILN_WEB_URL ?? OLLAMA_CLOUD

export interface SearchResult {
  title: string
  url: string
  content: string
}

export interface FetchedPage {
  title: string
  content: string
  links: string[]
}

export function webAvailable(): boolean {
  return getApiKey() !== null
}

/**
 * Ollama's web search/fetch run on ollama.com (pages are fetched by Ollama, not this Mac) and are
 * authorised with the ollama.com API key, which stays in the main process.
 */
async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = getApiKey()
  if (!key) throw new OllamaError('Web tools need an ollama.com API key (Settings → Usage & cost).')
  let res: Response
  try {
    res = await fetch(`${WEB_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    })
  } catch (err) {
    throw new OllamaError(`Couldn't reach ollama.com: ${(err as Error).message}`)
  }
  if (res.status === 401 || res.status === 403) throw new OllamaError('ollama.com rejected the API key.', res.status)
  if (res.status === 429) throw new OllamaError('Web search limit reached on ollama.com. Try again later.', res.status)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let detail = text
    try {
      detail = (JSON.parse(text) as { error?: string }).error ?? text
    } catch {
      /* not JSON */
    }
    throw new OllamaError(detail || `ollama.com returned HTTP ${res.status}`, res.status)
  }
  return (await res.json()) as T
}

export async function webSearch(query: string, maxResults = 5): Promise<SearchResult[]> {
  const n = Math.min(10, Math.max(1, Math.round(maxResults) || 5))
  const data = await call<{ results?: SearchResult[] }>('/api/web_search', { query, max_results: n })
  return (data.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', content: r.content ?? '' }))
}

export async function webFetch(url: string): Promise<FetchedPage> {
  const data = await call<{ title?: string; content?: string; links?: string[] }>('/api/web_fetch', { url })
  return { title: data.title ?? '', content: data.content ?? '', links: Array.isArray(data.links) ? data.links : [] }
}
