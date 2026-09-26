import { copyFile, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { attachmentRowsForConversation } from '../db/conversations'
import { paths } from '../paths'
import { removeChatVenv } from './python'

// Each chat that runs code gets a folder: code runs there, the chat's attachments are copied into uploads/, and
// what code writes is listed on the run's card. It's deleted with the chat.

/** Kiln's own files in a workspace (scripts, the sandbox's HOME and TMPDIR), never listed as outputs. */
export const KILN_DIR = '.kiln'
export const UPLOADS_DIR = 'uploads'
const MAX_FILES = 5000
const MAX_LISTED = 20

export const workspaceDir = (conversationId: string): string => join(paths.workspaces, conversationId)

/** A safe file name for an upload: no folders, and not hidden. */
const safeName = (name: string) => name.replace(/[/\\:]/g, '_').replace(/^\.+/, '_') || 'file'

/**
 * The chat's workspace, with its attachments copied into uploads/ (names made unique). Returns the folder and the
 * upload names, for the prompt.
 */
export async function prepareWorkspace(conversationId: string): Promise<{ dir: string; uploads: string[] }> {
  const dir = workspaceDir(conversationId)
  await mkdir(join(dir, KILN_DIR, 'home'), { recursive: true })
  await mkdir(join(dir, KILN_DIR, 'tmp'), { recursive: true })
  const rows = attachmentRowsForConversation(conversationId)
  const uploads: string[] = []
  if (rows.length) await mkdir(join(dir, UPLOADS_DIR), { recursive: true })
  for (const row of rows) {
    let name = safeName(row.name)
    for (let n = 2; uploads.includes(name); n++) name = safeName(row.name).replace(/(\.[^.]*)?$/, (ext) => ` (${n})${ext}`)
    uploads.push(name)
    const target = join(dir, UPLOADS_DIR, name)
    const existing = await stat(target).catch(() => null)
    if (existing?.size !== row.size) await copyFile(row.path, target).catch(() => undefined)
  }
  return { dir, uploads }
}

export type Snapshot = Map<string, { size: number; mtimeMs: number }>

/** Every file in the workspace except Kiln's own and the uploads, with its size and modification time. */
export async function snapshot(dir: string): Promise<Snapshot> {
  const files: Snapshot = new Map()
  const walk = async (folder: string) => {
    let entries
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (files.size >= MAX_FILES) return
      const full = join(folder, e.name)
      const rel = relative(dir, full)
      if (rel === KILN_DIR || rel === UPLOADS_DIR || e.name === '__pycache__') continue
      if (e.isDirectory()) await walk(full)
      else if (e.isFile()) {
        const s = await stat(full).catch(() => null)
        if (s) files.set(rel, { size: s.size, mtimeMs: s.mtimeMs })
      }
    }
  }
  await walk(dir)
  return files
}

/** Files that are new or changed since `before` (at most 20, by path). */
export function changedFiles(before: Snapshot, after: Snapshot): Array<{ path: string; size: number }> {
  return [...after]
    .filter(([path, f]) => {
      const was = before.get(path)
      return !was || was.size !== f.size || was.mtimeMs !== f.mtimeMs
    })
    .map(([path, f]) => ({ path, size: f.size }))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAX_LISTED)
}

/**
 * A file in a chat's workspace, by its relative path, or null when it would be anything else. Everything that opens,
 * saves or previews a workspace file goes through this, outside the sandbox: so the chat id must be a plain id, and
 * the path must stay inside the workspace after symlinks are followed (code could link to a file anywhere).
 */
export async function workspaceFile(conversationId: string, rel: string): Promise<string | null> {
  if (!/^[\w-]+$/.test(conversationId) || !rel || isAbsolute(rel)) return null
  try {
    const dir = await realpath(workspaceDir(conversationId))
    const full = await realpath(resolve(dir, rel))
    return full.startsWith(dir + sep) && (await stat(full)).isFile() ? full : null
  } catch {
    return null
  }
}

export async function removeWorkspace(conversationId: string): Promise<void> {
  if (!/^[\w-]+$/.test(conversationId)) return
  await Promise.all([rm(workspaceDir(conversationId), { recursive: true, force: true }), removeChatVenv(conversationId)])
}
