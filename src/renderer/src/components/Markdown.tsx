import { memo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { normalizeCitations } from '@shared/citations'
import { api } from '@/lib/api'
import { cn } from '@/lib/format'
import { CodeBlock } from './CodeBlock'

interface Props {
  text: string
  className?: string
  onOpenAsArtifact?: (code: string, lang: string | null) => void
}

// Models often write \( \) and \[ \] delimiters; remark-math only understands dollars.
function normalizeMath(text: string): string {
  return text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, inner: string) => `$$${inner}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, inner: string) => `$${inner}$`)
}

function textOf(children: ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(textOf).join('')
  return ''
}

export const Markdown = memo(function Markdown({ text, className, onOpenAsArtifact }: Props) {
  const components: Components = {
    pre: ({ children }) => <>{children}</>,
    code: ({ className: cls, children }) => {
      const match = /language-([\w+#.-]+)/.exec(cls ?? '')
      const code = textOf(children).replace(/\n$/, '')
      // Fenced blocks have a language class or contain newlines; everything else is inline.
      if (!match && !code.includes('\n')) return <code>{children}</code>
      return <CodeBlock code={code} lang={match?.[1] ?? null} onOpenAsArtifact={onOpenAsArtifact} />
    },
    a: ({ href, children }) => (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          if (href) void api.app.openExternal(href)
        }}
      >
        {children}
      </a>
    ),
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto">
        <table>{children}</table>
      </div>
    )
  }

  return (
    <div className={cn('prose-kiln selectable', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components}>
        {normalizeCitations(normalizeMath(text))}
      </ReactMarkdown>
    </div>
  )
})
