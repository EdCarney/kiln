import type { ArtifactType } from './types'

export type Segment =
  | { kind: 'text'; text: string }
  | {
      kind: 'artifact'
      identifier: string
      type: ArtifactType
      title: string
      language: string | null
      content: string
      /** False while the closing tag has not streamed in yet. */
      complete: boolean
    }

// Accept Claude's historical tag name too — open models trained on Claude transcripts emit it.
const OPEN_RE = /<(artifact|antArtifact)\b([^>]*)>/i
const ATTR_RE = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
// A tag that has started streaming but whose `>` hasn't arrived yet: "<", "<arti", "<artifact type=..".
const prefixes = (word: string) => Array.from({ length: word.length }, (_, i) => word.slice(0, i + 1))
const PARTIAL_OPEN_RE = new RegExp(
  `<(?:(?:artifact|antArtifact)(?:\\s[^>]*)?|${[...new Set([...prefixes('artifact'), ...prefixes('antArtifact')])].join('|')})?$`
)
const PARTIAL_CLOSE_RE = /<\/?([a-zA-Z]*)$/

const TYPE_ALIASES: Record<string, ArtifactType> = {
  markdown: 'markdown',
  md: 'markdown',
  document: 'markdown',
  'text/markdown': 'markdown',
  code: 'code',
  'application/vnd.ant.code': 'code',
  html: 'html',
  'text/html': 'html',
  svg: 'svg',
  'image/svg+xml': 'svg',
  mermaid: 'mermaid',
  'application/vnd.ant.mermaid': 'mermaid'
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const m of raw.matchAll(ATTR_RE)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? ''
  return attrs
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'artifact'
  )
}

function normalizeType(raw: string | undefined, language: string | null): { type: ArtifactType; language: string | null } {
  const key = (raw ?? '').trim().toLowerCase()
  if (TYPE_ALIASES[key]) return { type: TYPE_ALIASES[key], language }
  // React artifacts aren't rendered (out of scope); show them as JSX source.
  if (key.includes('react')) return { type: 'code', language: language ?? 'jsx' }
  // Some models put the language in `type`.
  if (key && !language) return { type: 'code', language: key }
  return { type: 'code', language }
}

/** Strip a markdown fence that some models wrap artifact content in. */
function stripFences(content: string, complete: boolean): string {
  let c = content.replace(/^\s*\n/, '')
  const open = c.match(/^\s*```[\w+#.-]*[^\n]*\n/)
  if (open) {
    c = c.slice(open[0].length)
    if (complete) c = c.replace(/\n?```\s*$/, '')
    else c = c.replace(/\n?`{1,3}$/, '')
  }
  return complete ? c.replace(/\s+$/, '') : c
}

/**
 * Split an assistant message into prose and artifact segments. Stateless on purpose:
 * during streaming the renderer re-parses the accumulated text each frame, which is
 * cheap and avoids an incremental state machine drifting out of sync.
 */
/** A segment plus where it came from in the raw message, so tool calls can be placed between or inside segments. */
export type RangedSegment = Segment & { start: number; end: number }

export function parseMessage(input: string, streaming = false): Segment[] {
  return parseMessageRanges(input, streaming).map(({ start: _start, end: _end, ...segment }) => segment as Segment)
}

/** parseMessage, keeping each segment's [start, end) range in `input` (text may be trimmed within it). */
export function parseMessageRanges(input: string, streaming = false): RangedSegment[] {
  const segments: RangedSegment[] = []
  const counters = new Map<string, number>()
  let rest = input

  const pushText = (text: string, start: number) => {
    if (!text) return
    const last = segments[segments.length - 1]
    if (last && last.kind === 'text') {
      last.text += text
      last.end = start + text.length
    } else segments.push({ kind: 'text', text, start, end: start + text.length })
  }

  while (rest.length) {
    const offset = input.length - rest.length
    const open = OPEN_RE.exec(rest)
    if (!open) {
      let text = rest
      if (streaming) text = text.replace(PARTIAL_OPEN_RE, '')
      pushText(text, offset)
      break
    }
    pushText(rest.slice(0, open.index), offset)

    const tagName = open[1]
    const attrs = parseAttrs(open[2])
    const afterOpen = rest.slice(open.index + open[0].length)
    const closeRe = new RegExp(`</${tagName}\\s*>`, 'i')
    const close = closeRe.exec(afterOpen)
    const complete = !!close
    let body = close ? afterOpen.slice(0, close.index) : afterOpen
    if (!complete && streaming) body = body.replace(PARTIAL_CLOSE_RE, '')

    const title = attrs.title?.trim() || 'Untitled'
    const { type, language } = normalizeType(attrs.type, attrs.language?.trim() || null)
    let identifier = attrs.identifier?.trim() || slugify(title)
    // Duplicate identifiers inside one message stay distinct only if the model forgot to set one.
    if (!attrs.identifier) {
      const n = (counters.get(identifier) ?? 0) + 1
      counters.set(identifier, n)
      if (n > 1) identifier = `${identifier}-${n}`
    }

    const tagStart = offset + open.index
    const afterOpenStart = tagStart + open[0].length
    segments.push({
      kind: 'artifact',
      identifier,
      type,
      title,
      language,
      content: stripFences(body, complete),
      complete,
      start: tagStart,
      end: close ? afterOpenStart + close.index + close[0].length : input.length
    })
    rest = close ? afterOpen.slice(close.index + close[0].length) : ''
  }

  return tidyFenceWrappers(segments)
}

/** Remove the stray ``` left behind when a model wraps the whole artifact tag in a code fence. */
function tidyFenceWrappers<T extends Segment>(segments: T[]): T[] {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg.kind !== 'artifact') continue
    const before = segments[i - 1]
    const after = segments[i + 1]
    if (before?.kind === 'text' && /```[\w-]*\s*$/.test(before.text)) {
      before.text = before.text.replace(/```[\w-]*\s*$/, '')
      if (after?.kind === 'text') after.text = after.text.replace(/^\s*```/, '')
    }
  }
  return segments.filter((s) => s.kind !== 'text' || s.text.trim().length > 0)
}

export function artifactExtension(type: ArtifactType, language: string | null): string {
  switch (type) {
    case 'markdown':
      return 'md'
    case 'html':
      return 'html'
    case 'svg':
      return 'svg'
    case 'mermaid':
      return 'mmd'
    case 'code':
      return LANGUAGE_EXT[(language ?? '').toLowerCase()] ?? 'txt'
  }
}

const LANGUAGE_EXT: Record<string, string> = {
  python: 'py',
  py: 'py',
  javascript: 'js',
  js: 'js',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  jsx: 'jsx',
  rust: 'rs',
  go: 'go',
  java: 'java',
  kotlin: 'kt',
  swift: 'swift',
  ruby: 'rb',
  php: 'php',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  csharp: 'cs',
  'c#': 'cs',
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  zsh: 'sh',
  sql: 'sql',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  css: 'css',
  scss: 'scss',
  html: 'html',
  xml: 'xml',
  markdown: 'md',
  r: 'r',
  lua: 'lua',
  dart: 'dart'
}

/** Map a fenced-code language to the artifact type used by "Open as artifact". */
export function typeForCodeLanguage(language: string | null): ArtifactType {
  switch ((language ?? '').toLowerCase()) {
    case 'html':
      return 'html'
    case 'svg':
      return 'svg'
    case 'mermaid':
      return 'mermaid'
    case 'markdown':
    case 'md':
      return 'markdown'
    default:
      return 'code'
  }
}
