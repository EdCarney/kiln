import { Check, Copy, PanelRight } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { cn } from '@/lib/format'
import { highlight } from '@/lib/highlighter'

export const ARTIFACT_MIN_LINES = 15

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  return [
    copied,
    (text: string) => {
      void navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    }
  ]
}

interface Props {
  code: string
  lang: string | null
  /** Shown when the block is long enough to be worth promoting to an artifact. */
  onOpenAsArtifact?: (code: string, lang: string | null) => void
  bare?: boolean
  className?: string
}

export const CodeBlock = memo(function CodeBlock({ code, lang, onOpenAsArtifact, bare, className }: Props) {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, copy] = useCopy()

  useEffect(() => {
    let cancelled = false
    // Debounce so a streaming block isn't re-highlighted on every token.
    const t = setTimeout(() => {
      highlight(code, lang)
        .then((h) => !cancelled && setHtml(h))
        .catch(() => !cancelled && setHtml(null))
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [code, lang])

  const body = html ? (
    <div className="code-body selectable" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <div className="code-body selectable">
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )

  if (bare) return <div className={className}>{body}</div>

  const lines = code.split('\n').length
  return (
    <div className={cn('group/code my-3 overflow-hidden rounded-kiln border border-line bg-code font-ui', className)}>
      <div className="flex h-9 items-center justify-between border-b border-line px-3 text-xs text-subtle">
        <span className="font-mono">{lang || 'text'}</span>
        <div className="flex items-center gap-1">
          {onOpenAsArtifact && lines >= ARTIFACT_MIN_LINES && (
            <button
              onClick={() => onOpenAsArtifact(code, lang)}
              className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-hover hover:text-fg"
            >
              <PanelRight className="size-3.5" /> Open as artifact
            </button>
          )}
          <button onClick={() => copy(code)} className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-hover hover:text-fg">
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      {body}
    </div>
  )
})
