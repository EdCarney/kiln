import { getApiKey, getSettings } from '../settings'

export const OLLAMA_CLOUD = 'https://ollama.com'

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> | string }
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  images?: string[]
  tool_calls?: ToolCall[]
  tool_name?: string
}

export interface OllamaTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ChatBody {
  model: string
  messages: OllamaMessage[]
  think?: boolean | 'low' | 'medium' | 'high'
  tools?: OllamaTool[]
  options?: Record<string, unknown>
  keep_alive?: string
}

export interface ChatChunk {
  message?: { role: string; content?: string; thinking?: string; tool_calls?: ToolCall[] }
  done: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
  eval_duration?: number
  total_duration?: number
  error?: string
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

function target(): { base: string; headers: Record<string, string> } {
  const s = getSettings()
  if (s.connection.mode === 'direct') {
    const key = getApiKey()
    return { base: OLLAMA_CLOUD, headers: key ? { Authorization: `Bearer ${key}` } : {} }
  }
  return { base: s.connection.host.replace(/\/+$/, ''), headers: {} }
}

function friendly(status: number, body: string, model?: string): OllamaError {
  let detail = body
  try {
    detail = (JSON.parse(body) as { error?: string }).error ?? body
  } catch {
    /* not JSON */
  }
  if (status === 401 || status === 403)
    return new OllamaError(
      getSettings().connection.mode === 'direct'
        ? 'Ollama cloud rejected the API key. Check it in Settings → Models.'
        : 'Ollama cloud needs you to sign in. Run `ollama signin` in a terminal, then retry.',
      status
    )
  if (status === 429)
    return new OllamaError('Ollama cloud usage limit reached. Try again later, or switch to a local model.', status)
  if (status === 404 && /not found/i.test(detail))
    return new OllamaError(model ? `Model “${model}” was not found by Ollama.` : detail, status)
  return new OllamaError(detail || `Ollama returned HTTP ${status}`, status)
}

async function request(path: string, init: RequestInit & { model?: string; base?: string } = {}): Promise<Response> {
  const { base, headers } = target()
  const url = `${init.base ?? base}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...headers, ...(init.headers as Record<string, string>) }
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new OllamaError(
      getSettings().connection.mode === 'direct'
        ? `Can't reach ${OLLAMA_CLOUD}. Check your internet connection.`
        : `Can't reach Ollama at ${base}. Is the Ollama app running?`
    )
  }
  if (!res.ok) throw friendly(res.status, await res.text().catch(() => ''), init.model)
  return res
}

export async function* chatStream(body: ChatBody, signal: AbortSignal): AsyncGenerator<ChatChunk> {
  const res = await request('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ ...body, stream: true }),
    signal,
    model: body.model
  })
  if (!res.body) throw new OllamaError('Ollama returned an empty response')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const chunk = JSON.parse(line) as ChatChunk
      if (chunk.error) throw new OllamaError(chunk.error)
      yield chunk
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as ChatChunk
}

export async function chatOnce(body: ChatBody, signal?: AbortSignal): Promise<ChatChunk> {
  const res = await request('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ ...body, stream: false }),
    signal,
    model: body.model
  })
  return (await res.json()) as ChatChunk
}

export interface TagModel {
  name: string
  remote_host?: string
  details?: { family?: string; parameter_size?: string }
}

export async function listTags(fromCloudCatalog = false): Promise<TagModel[]> {
  const res = await request('/api/tags', fromCloudCatalog ? { base: OLLAMA_CLOUD } : {})
  return ((await res.json()) as { models?: TagModel[] }).models ?? []
}

export interface ShowResponse {
  capabilities?: string[]
  details?: { family?: string; parameter_size?: string }
  model_info?: Record<string, unknown>
}

export async function showModel(model: string): Promise<ShowResponse> {
  const res = await request('/api/show', { method: 'POST', body: JSON.stringify({ model }), model })
  return (await res.json()) as ShowResponse
}

export const isCloudName = (name: string): boolean => /(:|-)cloud$/.test(name)

export function connectionMode(): 'local' | 'direct' {
  return getSettings().connection.mode
}
