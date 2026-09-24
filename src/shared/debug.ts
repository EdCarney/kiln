// Pure helpers for the debugger window: redaction, prompt anatomy and curl export.

const IMAGE_PLACEHOLDER = /^<image [\d.]+ KB>$/

/** Deep-copy a request body, replacing base64 images with a size placeholder. */
export function redactImages<T>(body: T): T {
  return JSON.parse(
    JSON.stringify(body, (key, value) => {
      if (key === 'images' && Array.isArray(value))
        return value.map((img) => (typeof img === 'string' ? `<image ${((img.length * 3) / 4 / 1024).toFixed(0)} KB>` : img))
      return value
    })
  ) as T
}

/** Drop redacted image placeholders so a recorded request can be replayed. */
export function stripImagePlaceholders<T>(body: T): { body: T; removed: number } {
  let removed = 0
  const clean = JSON.parse(
    JSON.stringify(body, (key, value) => {
      if (key === 'images' && Array.isArray(value)) {
        const kept = value.filter((img) => !(typeof img === 'string' && IMAGE_PLACEHOLDER.test(img)))
        removed += value.length - kept.length
        return kept.length ? kept : undefined
      }
      return value
    })
  ) as T
  return { body: clean, removed }
}

const estimate = (text: string) => Math.ceil(text.length / 4)
const IMAGE_TOKENS = 1600

export interface AnatomySegment {
  label: string
  group: 'system' | 'history' | 'latest' | 'tools' | 'images'
  tokens: number
}

const SECTION_LABELS: Record<string, string> = {
  user_preferences: 'Your preferences',
  project: 'Project instructions',
  project_knowledge: 'Project knowledge',
  artifacts: 'Artifact instructions',
  web: 'Web tool guidance',
  skills: 'Skill index',
  loaded_skills: 'Loaded skills',
  selected_skills: 'Selected skills'
}

interface BodyLike {
  messages?: Array<{ role?: string; content?: string; images?: unknown[]; thinking?: string; tool_calls?: unknown[] }>
  tools?: unknown[]
}

/**
 * Where a request's tokens go, estimated at ~4 characters per token (the same heuristic Kiln uses
 * for trimming history). Compare the total with Ollama's prompt_eval_count for the real number.
 */
export function promptAnatomy(body: BodyLike): { segments: AnatomySegment[]; total: number } {
  const segments: AnatomySegment[] = []
  const messages = body.messages ?? []
  const system = messages.find((m) => m.role === 'system')?.content ?? ''
  let rest = system
  for (const m of system.matchAll(/<([a-z_]+)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g)) {
    segments.push({ label: SECTION_LABELS[m[1]] ?? `<${m[1]}>`, group: 'system', tokens: estimate(m[0]) })
    rest = rest.replace(m[0], '')
  }
  if (rest.trim()) segments.unshift({ label: 'Base instructions', group: 'system', tokens: estimate(rest) })

  const convo = messages.filter((m) => m.role !== 'system')
  const lastUser = convo.map((m) => m.role).lastIndexOf('user')
  const byRole = new Map<string, number>()
  let latest = 0
  let latestHasTools = false
  let images = 0
  convo.forEach((m, i) => {
    const t = estimate((m.content ?? '') + (m.thinking ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : ''))
    images += m.images?.length ?? 0
    if (i >= lastUser && lastUser >= 0) {
      latest += t
      if (m.role === 'tool') latestHasTools = true
    }
    else byRole.set(m.role ?? 'other', (byRole.get(m.role ?? 'other') ?? 0) + t)
  })
  for (const [role, tokens] of byRole)
    segments.push({ label: role === 'tool' ? 'Earlier tool results' : `Earlier ${role} messages`, group: 'history', tokens })
  if (lastUser >= 0) segments.push({ label: latestHasTools ? 'Latest message + tool results' : 'Latest message', group: 'latest', tokens: latest })
  if (body.tools?.length) segments.push({ label: `Tool definitions (${body.tools.length})`, group: 'tools', tokens: estimate(JSON.stringify(body.tools)) })
  if (images) segments.push({ label: `Images (${images})`, group: 'images', tokens: images * IMAGE_TOKENS })

  const kept = segments.filter((s) => s.tokens > 0)
  return { segments: kept, total: kept.reduce((n, s) => n + s.tokens, 0) }
}

/** A curl command that reproduces the request (non-streaming). The API key is never embedded. */
export function toCurl(endpoint: string, body: unknown, needsKey: boolean): string {
  const { body: clean, removed } = stripImagePlaceholders(body)
  const payload = JSON.stringify({ ...(clean as object), stream: false }, null, 2)
  const auth = needsKey ? ` \\\n  -H "Authorization: Bearer $OLLAMA_API_KEY"` : ''
  const note = removed ? `# ${removed} image(s) weren't recorded and are left out.\n` : ''
  return `${note}curl ${endpoint} \\\n  -H 'Content-Type: application/json'${auth} \\\n  -d @- <<'JSON'\n${payload}\nJSON`
}
