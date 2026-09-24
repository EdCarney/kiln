import type { ConversationPatch } from '@shared/ipc'
import type { Attachment, Conversation, Message, MessageStats, Role, SearchHit, ThinkSetting, ToolEvent } from '@shared/types'
import { now, parseJson, uid } from '../util'
import { all, get, run } from './index'

// ---- Conversations ------------------------------------------------------

interface ConversationRow {
  id: string
  project_id: string | null
  title: string
  model: string | null
  think: string | null
  skills: string
  auto_skills: string
  pinned: number
  created_at: number
  updated_at: number
}

const toConversation = (r: ConversationRow): Conversation => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  model: r.model,
  think: (r.think as ThinkSetting | null) ?? null,
  skills: parseJson<string[]>(r.skills, []),
  autoSkills: parseJson<string[]>(r.auto_skills, []),
  pinned: !!r.pinned,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export function listConversations(opts: { projectId?: string; limit?: number } = {}): Conversation[] {
  const limit = opts.limit ?? 200
  const rows = opts.projectId
    ? all<ConversationRow>(
        'SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?',
        opts.projectId,
        limit
      )
    : all<ConversationRow>('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?', limit)
  return rows.map(toConversation)
}

export function getConversation(id: string): Conversation | null {
  const row = get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id)
  return row ? toConversation(row) : null
}

export function createConversation(input: {
  projectId: string | null
  model: string
  think: ThinkSetting | null
  skills: string[]
}): Conversation {
  const id = uid()
  const t = now()
  run(
    `INSERT INTO conversations (id, project_id, model, think, skills, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.projectId,
    input.model,
    input.think,
    JSON.stringify(input.skills),
    t,
    t
  )
  indexTitle(id, 'New chat')
  return getConversation(id)!
}

export function updateConversation(
  id: string,
  patch: ConversationPatch & { touch?: boolean; autoSkills?: string[] }
): Conversation {
  const c = getConversation(id)
  if (!c) throw new Error('Conversation not found')
  const next = {
    title: patch.title?.trim() || c.title,
    pinned: patch.pinned ?? c.pinned,
    projectId: patch.projectId !== undefined ? patch.projectId : c.projectId,
    model: patch.model !== undefined ? patch.model : c.model,
    think: patch.think !== undefined ? patch.think : c.think,
    skills: patch.skills ?? c.skills,
    autoSkills: patch.autoSkills ?? c.autoSkills
  }
  run(
    `UPDATE conversations SET title = ?, pinned = ?, project_id = ?, model = ?, think = ?, skills = ?, auto_skills = ?,
       updated_at = ?
     WHERE id = ?`,
    next.title,
    next.pinned ? 1 : 0,
    next.projectId,
    next.model,
    next.think,
    JSON.stringify(next.skills),
    JSON.stringify(next.autoSkills),
    patch.touch ? now() : c.updatedAt,
    id
  )
  if (next.title !== c.title) indexTitle(id, next.title)
  return getConversation(id)!
}

export function touchConversation(id: string): void {
  run('UPDATE conversations SET updated_at = ? WHERE id = ?', now(), id)
}

/** Returns on-disk attachment paths so the caller can delete the files. */
export function deleteConversation(id: string): string[] {
  const paths = all<{ path: string }>(
    'SELECT a.path FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.conversation_id = ?',
    id
  ).map((r) => r.path)
  run('DELETE FROM search_index WHERE conversation_id = ?', id)
  run('DELETE FROM conversations WHERE id = ?', id)
  return paths
}

// ---- Messages -----------------------------------------------------------

interface MessageRow {
  id: string
  conversation_id: string
  parent_id: string | null
  role: string
  content: string
  thinking: string | null
  model: string | null
  tool_events: string
  stats: string | null
  error: string | null
  created_at: number
}

const toMessage = (r: MessageRow, attachments: Attachment[]): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  parentId: r.parent_id,
  role: r.role as Role,
  content: r.content,
  thinking: r.thinking,
  model: r.model,
  attachments,
  toolEvents: parseJson<ToolEvent[]>(r.tool_events, []),
  stats: parseJson<MessageStats | null>(r.stats, null),
  error: r.error,
  createdAt: r.created_at
})

export function listMessages(conversationId: string): Message[] {
  const rows = all<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at', conversationId)
  const byMessage = new Map<string, Attachment[]>()
  for (const a of all<AttachmentRow>(
    `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
     WHERE m.conversation_id = ? ORDER BY a.created_at`,
    conversationId
  )) {
    const list = byMessage.get(a.message_id!) ?? []
    list.push(toAttachment(a))
    byMessage.set(a.message_id!, list)
  }
  return rows.map((r) => toMessage(r, byMessage.get(r.id) ?? []))
}

export function getMessage(id: string): Message | null {
  const row = get<MessageRow>('SELECT * FROM messages WHERE id = ?', id)
  if (!row) return null
  const atts = all<AttachmentRow>('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at', id).map(
    toAttachment
  )
  return toMessage(row, atts)
}

export function insertMessage(m: {
  conversationId: string
  parentId: string | null
  role: Role
  content: string
  model?: string | null
}): Message {
  const id = uid()
  run(
    `INSERT INTO messages (id, conversation_id, parent_id, role, content, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    m.conversationId,
    m.parentId,
    m.role,
    m.content,
    m.model ?? null,
    now()
  )
  if (m.content) indexMessage(m.conversationId, id, m.content)
  return getMessage(id)!
}

export function updateMessage(
  id: string,
  patch: {
    content?: string
    thinking?: string | null
    model?: string | null
    toolEvents?: ToolEvent[]
    stats?: MessageStats | null
    error?: string | null
  }
): Message {
  const m = getMessage(id)
  if (!m) throw new Error('Message not found')
  run(
    'UPDATE messages SET content = ?, thinking = ?, model = ?, tool_events = ?, stats = ?, error = ? WHERE id = ?',
    patch.content ?? m.content,
    patch.thinking !== undefined ? patch.thinking : m.thinking,
    patch.model !== undefined ? patch.model : m.model,
    JSON.stringify(patch.toolEvents ?? m.toolEvents),
    JSON.stringify(patch.stats !== undefined ? patch.stats : m.stats),
    patch.error !== undefined ? patch.error : m.error,
    id
  )
  if (patch.content !== undefined) indexMessage(m.conversationId, id, patch.content)
  return getMessage(id)!
}

/**
 * Save a streaming reply's progress. Deliberately one UPDATE: this runs every couple of seconds on the
 * main thread, and search indexing waits for the final save (updateMessage).
 */
export function checkpointMessage(id: string, patch: { content: string; thinking: string | null; toolEvents: ToolEvent[] }): void {
  run('UPDATE messages SET content = ?, thinking = ?, tool_events = ? WHERE id = ?', patch.content, patch.thinking, JSON.stringify(patch.toolEvents), id)
}

/**
 * Assistant messages that never got their final save: every finished reply has stats, even an
 * errored or stopped one, so no stats and no error means the app quit or crashed mid-reply.
 */
export function unfinishedReplyIds(): string[] {
  return all<{ id: string }>(
    `SELECT id FROM messages WHERE role = 'assistant' AND (stats IS NULL OR stats = 'null') AND error IS NULL`
  ).map((r) => r.id)
}

/** Delete messages created at or after `fromCreatedAt` (used by retry and edit). */
export function deleteMessagesFrom(conversationId: string, fromCreatedAt: number): string[] {
  const ids = all<{ id: string }>(
    'SELECT id FROM messages WHERE conversation_id = ? AND created_at >= ?',
    conversationId,
    fromCreatedAt
  ).map((r) => r.id)
  const paths: string[] = []
  for (const id of ids) {
    for (const a of all<{ path: string }>('SELECT path FROM attachments WHERE message_id = ?', id)) paths.push(a.path)
    run('DELETE FROM search_index WHERE message_id = ?', id)
    run('DELETE FROM messages WHERE id = ?', id)
  }
  return paths
}

// ---- Attachments --------------------------------------------------------

export interface AttachmentRow {
  id: string
  message_id: string | null
  kind: string
  name: string
  mime: string
  size: number
  path: string
  text: string | null
  token_est: number
  created_at: number
}

const toAttachment = (r: AttachmentRow): Attachment => ({
  id: r.id,
  messageId: r.message_id,
  kind: r.kind as Attachment['kind'],
  name: r.name,
  mime: r.mime,
  size: r.size,
  tokenEstimate: r.token_est,
  textless: r.kind === 'document' && !r.text
})

export function insertAttachment(a: Omit<AttachmentRow, 'created_at' | 'message_id'>): Attachment {
  run(
    `INSERT INTO attachments (id, message_id, kind, name, mime, size, path, text, token_est, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.id,
    a.kind,
    a.name,
    a.mime,
    a.size,
    a.path,
    a.text,
    a.token_est,
    now()
  )
  return toAttachment(getAttachmentRow(a.id)!)
}

export function getAttachmentRow(id: string): AttachmentRow | undefined {
  return get<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', id)
}

export function attachmentRowsForMessage(messageId: string): AttachmentRow[] {
  return all<AttachmentRow>('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at', messageId)
}

export function linkAttachments(ids: string[], messageId: string): void {
  for (const id of ids) run('UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL', messageId, id)
}

export function deletePendingAttachment(id: string): string | null {
  const row = get<{ path: string }>('SELECT path FROM attachments WHERE id = ? AND message_id IS NULL', id)
  if (!row) return null
  run('DELETE FROM attachments WHERE id = ?', id)
  return row.path
}

/** Uploads that were never sent. */
export function staleAttachmentPaths(olderThan: number): string[] {
  const rows = all<{ id: string; path: string }>(
    'SELECT id, path FROM attachments WHERE message_id IS NULL AND created_at < ?',
    olderThan
  )
  for (const r of rows) run('DELETE FROM attachments WHERE id = ?', r.id)
  return rows.map((r) => r.path)
}

// ---- Search -------------------------------------------------------------

function indexMessage(conversationId: string, messageId: string, body: string): void {
  run('DELETE FROM search_index WHERE message_id = ?', messageId)
  run('INSERT INTO search_index (conversation_id, message_id, body) VALUES (?, ?, ?)', conversationId, messageId, body)
}

function indexTitle(conversationId: string, title: string): void {
  run('DELETE FROM search_index WHERE conversation_id = ? AND message_id IS NULL', conversationId)
  run('INSERT INTO search_index (conversation_id, message_id, body) VALUES (?, NULL, ?)', conversationId, title)
}

/** Snippets mark matches with \u0001…\u0002 so the renderer can highlight without HTML. */
export function search(query: string): SearchHit[] {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter(Boolean)
  if (!terms.length) return []
  const match = terms.map((t) => `"${t}"*`).join(' ')
  const rows = all<{ conversation_id: string; snip: string; title: string; updated_at: number }>(
    `SELECT s.conversation_id, snippet(search_index, 2, char(1), char(2), '…', 14) AS snip, c.title, c.updated_at
     FROM search_index s JOIN conversations c ON c.id = s.conversation_id
     WHERE search_index MATCH ? ORDER BY rank LIMIT 100`,
    match
  )
  const seen = new Set<string>()
  const hits: SearchHit[] = []
  for (const r of rows) {
    if (seen.has(r.conversation_id)) continue
    seen.add(r.conversation_id)
    hits.push({ conversationId: r.conversation_id, title: r.title, snippet: r.snip, updatedAt: r.updated_at })
  }
  return hits.slice(0, 30)
}
