import { Plus, RotateCcw, ScrollText, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { McpServer, McpStatus } from '@shared/types'
import { Button, Field, Modal, Switch, TextArea, TextField, Tooltip } from '@/components/ui'
import { api } from '@/lib/api'
import { cn } from '@/lib/format'
import { reportError, useApp } from '@/stores/app'
import { Row, Section } from './settingsParts'

const DOT: Record<McpStatus['state'], string> = {
  ready: 'bg-success',
  starting: 'bg-warn animate-pulse',
  error: 'bg-danger',
  stopped: 'bg-subtle'
}

function stateText(status: McpStatus | undefined): string {
  if (!status || status.state === 'stopped') return 'Not running. It starts when a chat uses it.'
  if (status.state === 'starting') return 'Starting…'
  if (status.state === 'error') return status.error ?? "Couldn't start."
  const n = status.tools.length
  return `Running · ${n} ${n === 1 ? 'tool' : 'tools'}`
}

const commandLine = (s: McpServer) => [s.command, ...s.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' ')

function ServerRow({ server, status, onEdit }: { server: McpServer; status: McpStatus | undefined; onEdit: () => void }) {
  const [log, setLog] = useState<string[] | null>(null)
  const [confirming, setConfirming] = useState(false)
  const loadMcp = useApp((s) => s.loadMcp)
  const state = status?.state ?? 'stopped'

  const showLog = async () => {
    if (log) return setLog(null)
    try {
      setLog(await api.mcp.log(server.id))
    } catch (err) {
      reportError(err)
    }
  }
  const remove = async () => {
    try {
      await api.mcp.remove(server.id)
      await loadMcp()
    } catch (err) {
      reportError(err)
    }
  }

  return (
    <div data-testid="mcp-server" className="rounded-kiln border border-line p-3">
      <div className="flex items-start gap-3">
        <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', DOT[state])} aria-label={state} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{server.name}</div>
          <div className="truncate font-mono text-xs text-subtle">{commandLine(server)}</div>
          <div className={cn('mt-1 text-xs', state === 'error' ? 'text-danger' : 'text-muted')}>{stateText(status)}</div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Tooltip content="Restart">
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Restart ${server.name}`}
              onClick={() => void api.mcp.restart(server.id).catch(reportError)}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </Tooltip>
          <Tooltip content={log ? 'Hide log' : 'Show what the server logged'}>
            <Button size="sm" variant="ghost" aria-label={`Log for ${server.name}`} onClick={() => void showLog()}>
              <ScrollText className="size-3.5" />
            </Button>
          </Tooltip>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            Edit
          </Button>
          {confirming ? (
            <Button size="sm" variant="danger" onClick={() => void remove()} onBlur={() => setConfirming(false)} autoFocus>
              Remove
            </Button>
          ) : (
            <Button size="sm" variant="ghost" aria-label={`Remove ${server.name}`} onClick={() => setConfirming(true)}>
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      {log && (
        <pre className="selectable mt-3 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-code p-2 font-mono text-[11px] text-muted">
          {log.length ? log.join('\n') : 'Nothing written to stderr yet.'}
        </pre>
      )}
    </div>
  )
}

interface EnvRow {
  key: string
  value: string
  /** Stored already: its value isn't shown, only kept, replaced or removed. */
  saved: boolean
  removed?: boolean
}

function ServerDialog({ server, onClose }: { server: McpServer | null; onClose: () => void }) {
  const loadMcp = useApp((s) => s.loadMcp)
  const [name, setName] = useState(server?.name ?? '')
  const [command, setCommand] = useState(server?.command ?? '')
  const [args, setArgs] = useState(server?.args.join('\n') ?? '')
  const [cwd, setCwd] = useState(server?.cwd ?? '')
  const [defaultOn, setDefaultOn] = useState(server?.defaultOn ?? true)
  const [env, setEnv] = useState<EnvRow[]>(server?.envKeys.map((key) => ({ key, value: '', saved: true })) ?? [])
  const [saving, setSaving] = useState(false)

  const setRow = (i: number, patch: Partial<EnvRow>) => setEnv(env.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const save = async () => {
    setSaving(true)
    try {
      const values: Record<string, string | null> = {}
      for (const r of env) {
        const key = r.key.trim()
        if (!key) continue
        if (r.removed) values[key] = null
        else if (!r.saved || r.value) values[key] = r.value
      }
      await api.mcp.save({
        id: server?.id,
        name,
        command,
        args: args.split('\n'),
        cwd: cwd.trim() || null,
        env: values,
        defaultOn
      })
      await loadMcp()
      onClose()
    } catch (err) {
      reportError(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={server ? `Edit ${server.name}` : 'Add an MCP server'}
      description="A local server Kiln starts with a command, like the ones in an MCP server's README."
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {server ? 'Save' : 'Add server'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <TextField value={name} onChange={(e) => setName(e.target.value)} placeholder="Filesystem" autoFocus />
        </Field>
        <Field label="Command" hint="Found on your login shell's PATH, as in Terminal.">
          <TextField value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className="font-mono" />
        </Field>
        <Field label="Arguments" hint="One per line.">
          <TextArea
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            rows={3}
            placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/Users/you/Desktop'}
            className="font-mono text-[13px]"
          />
        </Field>
        <div className="space-y-1.5">
          <div className="text-sm font-medium">Environment variables</div>
          {env.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <TextField
                value={r.key}
                readOnly={r.saved}
                onChange={(e) => setRow(i, { key: e.target.value })}
                placeholder="NAME"
                aria-label="Variable name"
                className={cn('w-48 font-mono text-[13px]', r.removed && 'line-through opacity-60')}
              />
              <TextField
                value={r.value}
                type="password"
                disabled={r.removed}
                onChange={(e) => setRow(i, { value: e.target.value })}
                placeholder={r.saved ? 'Saved (leave blank to keep)' : 'value'}
                aria-label={`Value of ${r.key || 'variable'}`}
                className="flex-1 font-mono text-[13px]"
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={r.removed ? `Keep ${r.key}` : `Remove ${r.key || 'variable'}`}
                onClick={() => (r.saved ? setRow(i, { removed: !r.removed }) : setEnv(env.filter((_, j) => j !== i)))}
              >
                {r.removed ? <RotateCcw className="size-3.5" /> : <X className="size-3.5" />}
              </Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setEnv([...env, { key: '', value: '', saved: false }])}>
            <Plus className="size-3.5" /> Add variable
          </Button>
          <div className="text-xs text-subtle">Values are stored encrypted with your Mac's keychain and never shown again.</div>
        </div>
        <Field label="Working folder" hint="Optional. Defaults to your home folder.">
          <TextField value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~" className="font-mono text-[13px]" />
        </Field>
        <Row label="Use in new chats" hint="You can switch servers on and off per chat in the + menu, under Tools.">
          <Switch checked={defaultOn} onChange={setDefaultOn} />
        </Row>
      </div>
    </Modal>
  )
}

export function ToolsTab() {
  const { mcpServers, mcpStatus, loadMcp } = useApp()
  const [editing, setEditing] = useState<McpServer | 'new' | null>(null)
  useEffect(() => {
    void loadMcp()
  }, [loadMcp])

  return (
    <>
      <Section
        title="MCP servers"
        description="Local servers that give models more tools: files, notes, calendars, developer tools. Kiln starts them on this Mac when a chat uses them. They run with your permissions and aren't sandboxed, so add only servers you trust. Models ask before using a tool."
      >
        {mcpServers.length === 0 && <p className="text-sm text-muted">No servers yet.</p>}
        {mcpServers.map((s) => (
          <ServerRow key={s.id} server={s} status={mcpStatus.find((x) => x.id === s.id)} onEdit={() => setEditing(s)} />
        ))}
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus className="size-3.5" /> Add server
        </Button>
      </Section>
      {editing && <ServerDialog server={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  )
}
