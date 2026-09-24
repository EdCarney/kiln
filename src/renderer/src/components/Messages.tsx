import { Ban, Check, Copy, FileText, Globe, LoaderCircle, Pencil, RotateCcw, Search, Sparkles, TriangleAlert } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { parseMessage, type Segment, typeForCodeLanguage } from '@shared/artifactParser'
import type { Artifact, Message, ToolEvent } from '@shared/types'
import { formatCost } from '@shared/usage'
import { api } from '@/lib/api'
import { cn, displayModelName, formatDuration, formatTokens } from '@/lib/format'
import { reportError } from '@/stores/app'
import { useArtifactPanel } from '@/stores/artifactPanel'
import { type StreamState, useChat } from '@/stores/chat'
import { ArtifactCard } from './ArtifactCard'
import { useCopy } from './CodeBlock'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { Button, IconButton, TextArea, Tooltip } from './ui'

/** Plain text of a reply for the clipboard: prose plus artifact bodies, without the tags. */
function plainText(content: string): string {
  return parseMessage(content)
    .map((s) => (s.kind === 'text' ? s.text : s.content))
    .join('\n\n')
    .trim()
}

// ---- User -----------------------------------------------------------------

export const UserMessage = memo(function UserMessage({ message, onEdit, disabled }: { message: Message; onEdit: (content: string) => void; disabled: boolean }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [copied, copy] = useCopy()

  return (
    <div className="group flex flex-col items-end gap-2">
      {message.attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {message.attachments.map((a) =>
            a.kind === 'image' ? (
              <img key={a.id} src={`kiln://attachment/${a.id}`} alt={a.name} className="max-h-48 max-w-64 rounded-kiln border border-line object-cover" />
            ) : (
              <div key={a.id} className="flex h-12 max-w-56 items-center gap-2 rounded-lg border border-line bg-panel px-2.5">
                <FileText className="size-4 shrink-0 text-muted" />
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">{a.name}</div>
                  <div className="text-[11px] text-subtle">{a.textless ? 'No text found' : `${formatTokens(a.tokenEstimate)} tokens`}</div>
                </div>
              </div>
            )
          )}
        </div>
      )}
      {editing ? (
        <div className="w-full max-w-[85%] space-y-2">
          <TextArea autoFocus rows={Math.min(12, draft.split('\n').length + 1)} value={draft} onChange={(e) => setDraft(e.target.value)} className="bg-panel text-[15px]" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!draft.trim() || disabled}
              onClick={() => {
                setEditing(false)
                onEdit(draft.trim())
              }}
            >
              Save & send
            </Button>
          </div>
        </div>
      ) : (
        message.content && (
          <div className="selectable max-w-[85%] whitespace-pre-wrap rounded-kiln-lg bg-bubble px-4 py-2.5 text-[15px] leading-relaxed">
            {message.content}
          </div>
        )
      )}
      {!editing && (
        <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <IconButton label={copied ? 'Copied' : 'Copy'} size="sm" onClick={() => copy(message.content)}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </IconButton>
          <IconButton
            label="Edit"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setDraft(message.content)
              setEditing(true)
            }}
          >
            <Pencil className="size-3.5" />
          </IconButton>
        </div>
      )}
    </div>
  )
})

// ---- Assistant ------------------------------------------------------------

const SKILL_TOOL_NAMES = new Set(['load_skill', 'read_skill_file'])
const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch'])

const pill = 'flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 font-ui text-xs'

function WebEvent({ e }: { e: ToolEvent }) {
  const Icon = e.pending ? LoaderCircle : e.tool === 'web_search' ? Search : Globe
  const url = typeof e.args.url === 'string' ? e.args.url : null
  const label = e.pending
    ? e.tool === 'web_search'
      ? 'Searching the web:'
      : 'Reading'
    : !e.ok
      ? e.tool === 'web_search'
        ? 'Search failed:'
        : "Couldn't read page:"
      : e.tool === 'web_search'
        ? 'Searched the web:'
        : 'Read'
  const content = (
    <>
      <Icon className={cn('size-3.5 shrink-0', e.pending && 'animate-spin')} />
      <span className="shrink-0">{label}</span>
      <span className="truncate font-medium text-fg">{e.summary}</span>
      {e.ok && !e.pending && e.tool === 'web_search' && typeof e.args.results === 'number' && (
        <span className="shrink-0 text-subtle">
          · {e.args.results} {e.args.results === 1 ? 'result' : 'results'}
        </span>
      )}
    </>
  )
  const cls = cn(pill, e.ok ? 'border-line text-muted' : 'border-danger/40 text-danger')
  // Pages open in the browser, so you can check what the model read.
  return url && e.ok && !e.pending ? (
    <Tooltip content={url}>
      <button onClick={() => void api.app.openExternal(url)} className={cn(cls, 'hover:border-line-strong hover:text-fg')}>
        {content}
      </button>
    </Tooltip>
  ) : (
    <span className={cls}>{content}</span>
  )
}

function ToolEvents({ events }: { events: ToolEvent[] }) {
  if (!events.length) return null
  const skillEvents = events.filter((e) => SKILL_TOOL_NAMES.has(e.tool))
  const webEvents = events.filter((e) => WEB_TOOL_NAMES.has(e.tool))
  // Tools the model invented (web.run, python…) collapse into one note instead of a row of errors.
  const unavailable = [
    ...new Set(events.filter((e) => !SKILL_TOOL_NAMES.has(e.tool) && !WEB_TOOL_NAMES.has(e.tool) && !e.pending).map((e) => e.tool))
  ]
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {webEvents.map((e, i) => (
        <WebEvent key={`w${i}`} e={e} />
      ))}
      {skillEvents.map((e, i) => (
        <span
          key={i}
          className={cn(
            'flex items-center gap-1.5 rounded-lg border px-2 py-1 font-ui text-xs',
            e.ok ? 'border-line text-muted' : 'border-danger/40 text-danger'
          )}
        >
          {e.pending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          {e.pending
            ? e.tool === 'load_skill'
              ? `Loading skill ${e.summary}…`
              : 'Reading skill file…'
            : e.tool === 'load_skill'
              ? e.ok
                ? <>Using skill <b className="font-medium text-fg">{e.summary}</b></>
                : `Skill failed: ${e.summary}`
              : e.ok
                ? `Read ${e.summary}`
                : `Couldn't read file: ${e.summary}`}
        </span>
      ))}
      {unavailable.length > 0 && (
        <Tooltip content="The model tried tools Kiln doesn't provide. Kiln can't browse the web or run code.">
          <span className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 font-ui text-xs text-muted">
            <Ban className="size-3.5 text-warn" />
            Tried unavailable {unavailable.length === 1 ? 'tool' : 'tools'}: <span className="font-mono text-fg">{unavailable.join(', ')}</span>
          </span>
        </Tooltip>
      )}
    </div>
  )
}

function statsLine(message: Message): string {
  const s = message.stats
  if (!s) return displayModelName(message.model)
  return [
    displayModelName(message.model),
    s.tokensPerSecond && `${s.tokensPerSecond.toFixed(0)} tok/s`,
    s.completionTokens && `${formatTokens(s.completionTokens)} output tokens`,
    s.durationMs && formatDuration(s.durationMs),
    s.costUsd === 0 ? 'local' : s.costUsd != null ? `${s.estimated ? '≈' : ''}${formatCost(s.costUsd)}` : null,
    s.truncatedHistory && `${s.truncatedHistory} older messages left out to fit the context window`
  ]
    .filter(Boolean)
    .join(' · ')
}

interface AssistantProps {
  message: Message
  stream: StreamState | undefined
  artifacts: Artifact[]
  isLast: boolean
  onRetry: () => void
}

export const AssistantMessage = memo(function AssistantMessage({ message, stream, artifacts, isLast, onRetry }: AssistantProps) {
  const streaming = !!stream
  const content = stream ? stream.content : message.content
  const thinking = stream ? stream.thinking : (message.thinking ?? '')
  const toolEvents = stream ? stream.toolEvents : message.toolEvents
  const segments = useMemo(() => parseMessage(content, streaming), [content, streaming])
  const [copied, copy] = useCopy()
  const conversationId = message.conversationId
  const openLive = useArtifactPanel((s) => s.openLive)
  const openArtifact = useArtifactPanel((s) => s.openArtifact)

  // Like Claude, pop the panel open the first time an artifact starts streaming.
  const opened = useRef(new Set<string>())
  useEffect(() => {
    if (!streaming) return
    for (const s of segments) {
      if (s.kind === 'artifact' && !s.complete && !opened.current.has(s.identifier)) {
        opened.current.add(s.identifier)
        openLive(message.id, s.identifier)
      }
    }
  }, [segments, streaming, message.id, openLive])

  const openAsArtifact = async (code: string, lang: string | null) => {
    try {
      const type = typeForCodeLanguage(lang)
      const title = lang ? `${lang[0].toUpperCase()}${lang.slice(1)} ${type === 'code' ? 'code' : 'snippet'}` : 'Code snippet'
      const artifact = await api.artifacts.createFromBlock({ conversationId, messageId: message.id, title, type, language: lang, content: code })
      useChat.getState().addArtifact(artifact)
      openArtifact(artifact.id)
    } catch (err) {
      reportError(err)
    }
  }

  const thinkingActive = streaming && !content && !toolEvents.length
  const thinkingMs = stream
    ? stream.thinkingStartedAt && stream.thinkingEndedAt
      ? stream.thinkingEndedAt - stream.thinkingStartedAt
      : null
    : (message.stats?.thinkingMs ?? null)

  const occurrences = new Map<string, number>()
  const rendered = segments.map((seg: Segment, i) => {
    if (seg.kind === 'text')
      return (
        <Markdown key={i} text={seg.text} onOpenAsArtifact={streaming ? undefined : openAsArtifact} />
      )
    const n = occurrences.get(seg.identifier) ?? 0
    occurrences.set(seg.identifier, n + 1)
    return <ArtifactCard key={i} segment={seg} messageId={message.id} occurrence={n} artifacts={artifacts} streaming={streaming} />
  })

  return (
    <div className="group">
      <ThinkingBlock thinking={thinking} active={thinkingActive && !!(thinking || streaming)} durationMs={thinkingMs} />
      <ToolEvents events={toolEvents} />
      {rendered}
      {streaming && !content && !thinking && (
        <div className="stream-caret h-6" aria-label="Waiting for reply" />
      )}
      {streaming && content && <span className="stream-caret" />}
      {message.error && !streaming && (
        <div className="mt-2 flex items-start gap-2 rounded-kiln border border-danger/40 bg-[color-mix(in_srgb,var(--k-danger)_8%,transparent)] px-3 py-2.5 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="flex-1 selectable">{message.error}</div>
          {isLast && (
            <Button size="sm" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      )}
      {!streaming && (message.content || !message.error) && (
        <div className={cn('mt-2 flex items-center gap-0.5 transition-opacity', isLast ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
          <IconButton label={copied ? 'Copied' : 'Copy'} size="sm" onClick={() => copy(plainText(message.content))}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </IconButton>
          {isLast && (
            <IconButton label="Retry" size="sm" onClick={onRetry}>
              <RotateCcw className="size-3.5" />
            </IconButton>
          )}
          <Tooltip content={statsLine(message)}>
            <span className="ml-1 cursor-default text-xs text-subtle">{displayModelName(message.model)}</span>
          </Tooltip>
          {message.stats?.truncatedHistory ? (
            <Tooltip content={`${message.stats.truncatedHistory} older messages were left out to fit the model's context window.`}>
              <TriangleAlert className="ml-1 size-3.5 text-subtle" />
            </Tooltip>
          ) : null}
        </div>
      )}
    </div>
  )
})
