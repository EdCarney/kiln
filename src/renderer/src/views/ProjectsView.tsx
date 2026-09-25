import { FolderClosed, Pin, Plus, Search } from 'lucide-react'
import { useState } from 'react'
import { PageHeader, TopBar } from '@/components/TopBar'
import { Button, EmptyState, Field, Modal, TextArea, TextField } from '@/components/ui'
import { api } from '@/lib/api'
import { cn, relativeTime } from '@/lib/format'
import { reportError, useApp } from '@/stores/app'

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { loadProjects, navigate } = useApp()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const create = async () => {
    try {
      const project = await api.projects.create({ name, description })
      await loadProjects()
      onOpenChange(false)
      setName('')
      setDescription('')
      navigate({ name: 'project', id: project.id })
    } catch (err) {
      reportError(err)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Create a project"
      description="Projects keep related chats together with shared instructions and knowledge files."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={create}>
            Create project
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="What are you working on?">
          <TextField autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name your project" />
        </Field>
        <Field label="What are you trying to achieve?">
          <TextArea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe your project, goals, subject, etc."
          />
        </Field>
      </div>
    </Modal>
  )
}

export function ProjectsView() {
  const { projects, navigate, loadProjects } = useApp()
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const shown = projects
    .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()) || p.description.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 pb-12 pt-6">
          <PageHeader
            title="Projects"
            actions={
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus className="size-4" /> New project
              </Button>
            }
          />
          {projects.length > 0 && (
            <div className="relative mb-6">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects…"
                className="h-11 w-full rounded-kiln border border-line bg-panel pl-9 pr-3 text-sm outline-none placeholder:text-subtle focus:border-line-strong focus:ring-2 focus:ring-accent-soft"
              />
            </div>
          )}
          {shown.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
              {shown.map((p) => (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate({ name: 'project', id: p.id })}
                  onKeyDown={(e) => e.key === 'Enter' && navigate({ name: 'project', id: p.id })}
                  className="group flex h-44 flex-col rounded-kiln-lg border border-line bg-panel p-5 transition-colors hover:border-line-strong"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium">{p.name}</div>
                    <button
                      aria-label={p.pinned ? 'Unpin project' : 'Pin project'}
                      onClick={async (e) => {
                        e.stopPropagation()
                        await api.projects.update(p.id, { pinned: !p.pinned }).catch(reportError)
                        await loadProjects()
                      }}
                      className={cn(
                        'rounded p-1 hover:bg-hover',
                        p.pinned ? 'text-accent' : 'text-subtle opacity-0 group-hover:opacity-100'
                      )}
                    >
                      <Pin className={cn('size-4', p.pinned && 'fill-current')} />
                    </button>
                  </div>
                  <p className="mt-2 line-clamp-3 flex-1 text-sm text-muted">{p.description}</p>
                  <div className="text-xs text-subtle">
                    {p.conversationCount ?? 0} chats · Updated {relativeTime(p.updatedAt)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={<FolderClosed className="size-5" />} title={projects.length ? 'No matching projects' : 'No projects yet'}>
              {projects.length ? null : 'Create a project to give a set of chats shared instructions and knowledge files.'}
            </EmptyState>
          )}
        </div>
      </div>
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  )
}
