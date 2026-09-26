import { Ellipsis, FolderInput, FolderMinus, Hand, Pencil, Pin, PinOff, ScrollText, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type { Conversation } from '@shared/types'
import { api } from '@/lib/api'
import { cn } from '@/lib/format'
import { reportError, useApp } from '@/stores/app'
import { useArtifactPanel } from '@/stores/artifactPanel'
import { useChat } from '@/stores/chat'
import { useDrafts } from '@/stores/drafts'
import {
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuTrigger,
  Modal,
  TextArea,
  TextField,
  Tooltip
} from './ui'

async function patch(conversation: Conversation, p: Parameters<typeof api.conversations.update>[1]) {
  try {
    const updated = await api.conversations.update(conversation.id, p)
    useChat.getState().setConversation(updated)
    await useApp.getState().loadProjects()
  } catch (err) {
    reportError(err)
  }
}

export function ConversationMenu({
  conversation,
  trigger,
  align = 'start'
}: {
  conversation: Conversation
  trigger?: ReactNode
  align?: 'start' | 'end'
}) {
  const projects = useApp((s) => s.projects)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [title, setTitle] = useState(conversation.title)
  const [editingInstructions, setEditingInstructions] = useState(false)
  const [instructions, setInstructions] = useState(conversation.instructions)

  const remove = async () => {
    try {
      await api.conversations.delete(conversation.id)
      useDrafts.getState().discard([conversation.id])
      setDeleting(false)
      const app = useApp.getState()
      await Promise.all([app.loadConversations(), app.loadProjects()])
      if (app.route.name === 'chat' && app.route.id === conversation.id) {
        useArtifactPanel.getState().close()
        useChat.getState().clear()
        app.navigate(conversation.projectId ? { name: 'project', id: conversation.projectId } : { name: 'home' })
      }
    } catch (err) {
      reportError(err)
    }
  }

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          {trigger ?? (
            <button
              aria-label="Chat options"
              onClick={(e) => e.stopPropagation()}
              className="flex size-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
            >
              <Ellipsis className="size-4" />
            </button>
          )}
        </MenuTrigger>
        <MenuContent align={align}>
          <MenuItem
            icon={conversation.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            onSelect={() => patch(conversation, { pinned: !conversation.pinned })}
          >
            {conversation.pinned ? 'Unpin' : 'Pin'}
          </MenuItem>
          <MenuItem
            icon={<Pencil className="size-4" />}
            onSelect={() => {
              setTitle(conversation.title)
              setRenaming(true)
            }}
          >
            Rename
          </MenuItem>
          <MenuItem
            icon={<ScrollText className="size-4" />}
            onSelect={() => {
              setInstructions(conversation.instructions)
              setEditingInstructions(true)
            }}
          >
            {conversation.instructions.trim() ? 'Edit instructions' : 'Add instructions'}
          </MenuItem>
          <MenuSub label="Move to project" icon={<FolderInput className="size-4" />}>
            {projects.length === 0 && <MenuLabel>No projects yet</MenuLabel>}
            {projects.map((p) => (
              <MenuItem key={p.id} disabled={p.id === conversation.projectId} onSelect={() => patch(conversation, { projectId: p.id })}>
                <span className="max-w-[220px] truncate">{p.name}</span>
              </MenuItem>
            ))}
          </MenuSub>
          {conversation.projectId && (
            <MenuItem icon={<FolderMinus className="size-4" />} onSelect={() => patch(conversation, { projectId: null })}>
              Remove from project
            </MenuItem>
          )}
          {conversation.allowedTools.length > 0 && (
            <MenuSub label="Tools allowed in this chat" icon={<Hand className="size-4" />}>
              <MenuLabel>These run without asking here:</MenuLabel>
              {conversation.allowedTools.map((tool) => (
                <MenuLabel key={tool}>
                  <span className="font-mono">{tool}</span>
                </MenuLabel>
              ))}
              <MenuSeparator />
              <MenuItem onSelect={() => patch(conversation, { allowedTools: [] })}>Ask again before each tool</MenuItem>
            </MenuSub>
          )}
          <MenuSeparator />
          <MenuItem danger icon={<Trash2 className="size-4 text-danger" />} onSelect={() => setDeleting(true)}>
            Delete
          </MenuItem>
        </MenuContent>
      </Menu>

      <Modal
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename chat"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!title.trim()}
              onClick={async () => {
                await patch(conversation, { title: title.trim() })
                setRenaming(false)
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            if (!title.trim()) return
            await patch(conversation, { title: title.trim() })
            setRenaming(false)
          }}
        >
          <TextField autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </form>
      </Modal>

      <Modal
        open={editingInstructions}
        onOpenChange={setEditingInstructions}
        title="Chat instructions"
        description="Applied to every reply in this chat, on top of your preferences and any project instructions. Use it for a role, tone or rules, e.g. “You are a strict code reviewer. Answer in bullet points.”"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditingInstructions(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                await patch(conversation, { instructions: instructions.trim() })
                setEditingInstructions(false)
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <TextArea
          autoFocus
          rows={8}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="How should the model behave in this chat?"
        />
      </Modal>

      <Modal
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete chat?"
        description={`“${conversation.title}” and its artifacts will be permanently deleted.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove}>
              Delete
            </Button>
          </>
        }
      />
    </>
  )
}

export function ConversationRow({
  conversation,
  active,
  onOpen,
  streaming,
  waiting
}: {
  conversation: Conversation
  active: boolean
  onOpen: () => void
  streaming: boolean
  /** A tool call in this chat is waiting for your approval. */
  waiting: boolean
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className={cn(
        'group flex h-8 items-center gap-2 rounded-lg pl-2.5 pr-1 text-[13px]',
        active ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-fg'
      )}
    >
      <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
      {waiting ? (
        <Tooltip content="Waiting for your approval">
          <Hand className="size-3.5 shrink-0 text-warn" aria-label="Waiting for your approval" />
        </Tooltip>
      ) : (
        streaming && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-label="Responding" />
      )}
      <span className={cn('shrink-0', active ? 'flex' : 'hidden group-hover:flex has-[[data-state=open]]:flex')}>
        <ConversationMenu conversation={conversation} />
      </span>
    </div>
  )
}
