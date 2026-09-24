import { ArrowDown, Bug, ChevronDown, FolderClosed } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Composer } from '@/components/Composer'
import { ConversationMenu } from '@/components/ConversationMenu'
import { AssistantMessage, UserMessage } from '@/components/Messages'
import { TopBar } from '@/components/TopBar'
import { ChatCost } from '@/components/UsageBar'
import { IconButton, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { editMessage, retryLast, sendMessage } from '@/lib/chatActions'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'

export function ChatView({ id }: { id: string }) {
  const { conversation, messages, artifacts, loading, open, usage } = useChat()
  const stream = useChat((s) => s.streams[id])
  const { projects, navigate } = useApp()
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [showJump, setShowJump] = useState(false)

  useEffect(() => {
    pinned.current = true
    void open(id)
  }, [id, open])

  // Stick to the bottom while content grows, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, stream?.content, stream?.thinking, loading])

  const onScroll = () => {
    const el = scroller.current!
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    pinned.current = atBottom
    setShowJump(!atBottom)
  }

  const jump = () => {
    pinned.current = true
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }

  const project = conversation?.projectId ? projects.find((p) => p.id === conversation.projectId) : null
  const current = conversation?.id === id ? conversation : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        className="border-b border-transparent"
        right={
          current && (
            <>
              <ChatCost usage={usage} model={current.model} />
              <IconButton label="Open debugger (⌘⇧D)" size="sm" onClick={() => api.debug.open(current.id)}>
                <Bug className="size-4" />
              </IconButton>
            </>
          )
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {project && (
            <>
              <button
                onClick={() => navigate({ name: 'project', id: project.id })}
                className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-muted hover:bg-hover hover:text-fg"
              >
                <FolderClosed className="size-3.5 shrink-0" />
                <span className="max-w-[180px] truncate">{project.name}</span>
              </button>
              <span className="text-subtle">/</span>
            </>
          )}
          {current && (
            <ConversationMenu
              conversation={current}
              trigger={
                <button className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-sm font-medium hover:bg-hover">
                  <span className="truncate">{current.title}</span>
                  <ChevronDown className="size-3.5 shrink-0 text-subtle" />
                </button>
              }
            />
          )}
        </div>
      </TopBar>

      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <div className="mx-auto space-y-8 px-6 pb-10 pt-4" style={{ maxWidth: 'calc(var(--k-chat-width) + 48px)' }}>
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <UserMessage key={m.id} message={m} disabled={!!stream} onEdit={(content) => editMessage(m, content, messages)} />
              ) : (
                <AssistantMessage
                  key={m.id}
                  message={m}
                  stream={stream?.messageId === m.id ? stream : undefined}
                  artifacts={artifacts}
                  isLast={i === messages.length - 1}
                  onRetry={() => retryLast(id, messages)}
                />
              )
            )}
          </div>
        )}
      </div>

      <div className="relative shrink-0 px-6 pb-5">
        {showJump && (
          <button
            onClick={jump}
            aria-label="Scroll to bottom"
            className="absolute -top-12 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-panel text-muted shadow-md hover:text-fg"
          >
            <ArrowDown className="size-4" />
          </button>
        )}
        <div className="mx-auto" style={{ maxWidth: 'var(--k-chat-width)' }}>
          <Composer
            conversation={current}
            streaming={!!stream}
            autoFocus
            onStop={() => api.chat.stop(id)}
            onSubmit={async (input) => {
              pinned.current = true
              return sendMessage(id, current?.projectId ?? null, input)
            }}
          />
          <p className="mt-2 text-center text-[11px] text-subtle">Models can make mistakes. Check important information.</p>
        </div>
      </div>
    </div>
  )
}
