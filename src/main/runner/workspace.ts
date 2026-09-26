import { createHash } from 'node:crypto'
import { constants, createWriteStream, rmSync } from 'node:fs'
import { copyFile, type FileHandle, lstat, mkdir, open, readdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { attachmentRowsForConversation, getConversation } from '../db/conversations'
import { isPlainId, paths } from '../paths'
import { quarantineInWorkspace } from '../quarantine'
import { forgetWorkspace, quiesce, quiesceEvery } from './lock'
import { chatVenvDir, chatVenvsDir, removeChatVenv, resetVenv } from './python'
import { KILN_DIR } from './sandbox'

// Each chat that runs code gets a folder: code runs there, the chat's attachments are copied into uploads/, and
// what code writes is listed on the run's card. It's deleted with the chat.
//
// Code can write anything in the folder, and Kiln works in it outside the sandbox, so Kiln must never follow a link
// code left there (#71). The sandbox won't let code replace the folder itself or .kiln (see policyFor). Otherwise Kiln
// changes or lists the folder only under its lock (quiesce: none of the chat's code running, none starting until the
// work is done), replacing any link where it expects a folder; and it hands a file out only by opening it with no link
// anywhere in its path.

export const UPLOADS_DIR = 'uploads'
const MAX_FILES = 5000
const MAX_LISTED = 20

export const workspaceDir = (conversationId: string): string => join(paths.workspaces, conversationId)
/** The scripts a chat's runs execute: outside its workspace, where code can read them but never change them. */
export const scriptsDir = (conversationId: string): string => join(paths.runner, 'scripts', conversationId)
/** Copies of a chat's files being previewed, so what's previewed is the file that was checked. */
const previewsDir = (conversationId?: string): string => join(paths.runner, 'previews', conversationId ?? '')

/** A safe file name for an upload: no folders, and not hidden. */
const safeName = (name: string) => name.replace(/[/\\:]/g, '_').replace(/^\.+/, '_') || 'file'

/** `dir` as a real folder: a link (or file) code left there is removed first, never followed. */
async function ensureFolder(dir: string): Promise<void> {
  const s = await lstat(dir).catch(() => null)
  if (s?.isDirectory()) return
  if (s) await rm(dir, { force: true })
  await mkdir(dir)
}

/**
 * The workspace folder itself, as a real folder. Safe outside the lock: the folder holding it is Kiln's, and the
 * sandbox pins it (only a link left from before the pin can be there). It must exist for its code to be found.
 */
async function ensureWorkspace(dir: string): Promise<void> {
  await mkdir(dirname(dir), { recursive: true })
  await ensureFolder(dir)
}

/**
 * Kiln's folders in a workspace (the sandbox's HOME and TMPDIR, which code may have deleted) as real folders, and
 * the chat's own Python environment, which its code can write, never a link. Under the workspace's lock.
 */
async function fixFolders(dir: string): Promise<void> {
  for (const sub of [KILN_DIR, join(KILN_DIR, 'home'), join(KILN_DIR, 'tmp')]) await ensureFolder(join(dir, sub))
  const venv = chatVenvDir(basename(dir))
  const found = await lstat(venv).catch(() => null)
  if (found && !found.isDirectory()) await rm(venv, { force: true })
}

/**
 * The chat's workspace, with its attachments copied into uploads/ (names made unique). Returns the folder and the
 * names of the uploads that are there, for the prompt.
 */
export async function prepareWorkspace(conversationId: string): Promise<{ dir: string; uploads: string[] }> {
  const dir = workspaceDir(conversationId)
  await ensureWorkspace(dir)
  const uploads = await quiesce(dir, async () => {
    await fixFolders(dir)
    return copyUploads(conversationId, dir)
  })
  return { dir, uploads }
}

async function copyUploads(conversationId: string, dir: string): Promise<string[]> {
  const rows = attachmentRowsForConversation(conversationId)
  const names: string[] = []
  const copied: string[] = []
  if (rows.length) await ensureFolder(join(dir, UPLOADS_DIR))
  for (const row of rows) {
    let name = safeName(row.name)
    for (let n = 2; names.includes(name); n++) name = safeName(row.name).replace(/(\.[^.]*)?$/, (ext) => ` (${n})${ext}`)
    names.push(name)
    const target = join(dir, UPLOADS_DIR, name)
    const existing = await lstat(target).catch(() => null)
    if (existing?.isFile() && existing.size === row.size) {
      copied.push(name)
      continue
    }
    // Nothing to copy (the attachment's file is gone): leave what's there, and don't name it.
    if (!(await stat(row.path).catch(() => null))?.isFile()) continue
    // A changed copy, or a link or folder code put in its place: replaced, never written through.
    if (existing) await rm(target, { recursive: true, force: true })
    if (
      await copyFile(row.path, target, constants.COPYFILE_EXCL).then(
        () => true,
        () => false
      )
    )
      copied.push(name)
  }
  return copied
}

/**
 * Before code runs in a workspace: it and Kiln's folders in it are real folders, and none of its code is still
 * running (see quiesce). Throws if leftover code can't be stopped.
 */
export async function readyForRun(dir: string): Promise<void> {
  await ensureWorkspace(dir)
  await quiesce(dir, () => fixFolders(dir))
}

export type Snapshot = Map<string, { size: number; mtimeMs: number }>

/**
 * Regular files under `dir`, by relative path, at most MAX_FILES: links aren't followed (nor is `dir` itself if it's
 * one), and entries `skip` names are left out. Breadth-first, so when there are too many, the ones nearer the top
 * (what Finder shows first) are kept. Only under the workspace's lock: code could swap a folder for a link mid-walk.
 */
async function listFiles(dir: string, skip: (rel: string, name: string) => boolean): Promise<string[]> {
  if (!(await lstat(dir).catch(() => null))?.isDirectory()) return []
  const files: string[] = []
  const folders = [dir]
  while (folders.length && files.length < MAX_FILES) {
    const folder = folders.shift()!
    let entries
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) break
      const full = join(folder, e.name)
      const rel = relative(dir, full)
      if (skip(rel, e.name)) continue
      if (e.isDirectory()) folders.push(full)
      else if (e.isFile()) files.push(rel)
    }
  }
  return files
}

/**
 * Every file in the workspace except Kiln's own and the uploads, with its size and modification time. Throws while
 * the chat's code runs (see quiesce).
 */
export function snapshot(dir: string): Promise<Snapshot> {
  return quiesce(dir, async () => {
    const files: Snapshot = new Map()
    for (const rel of await listFiles(dir, (rel, name) => rel === KILN_DIR || rel === UPLOADS_DIR || name === '__pycache__')) {
      const s = await lstat(join(dir, rel)).catch(() => null)
      if (s?.isFile()) files.set(rel, { size: s.size, mtimeMs: s.mtimeMs })
    }
    return files
  })
}

/** A chat's workspace by its real path: the folder holding the workspaces is Kiln's own, so its real path is trusted. */
const realWorkspace = async (conversationId: string) => join(await realpath(paths.workspaces), conversationId)

/** Every file in a chat's workspace a user can see in Finder (not Kiln's hidden .kiln folder), by relative path. */
async function visibleFiles(conversationId: string): Promise<string[]> {
  const root = await realWorkspace(conversationId).catch(() => null)
  return root ? listFiles(root, (rel) => rel === KILN_DIR) : []
}

/** The files Show in Finder marks (see markWorkspaceFiles). Throws while the chat's code runs. */
export async function workspaceFiles(conversationId: string): Promise<string[]> {
  if (!isPlainId(conversationId)) return []
  return quiesce(workspaceDir(conversationId), () => visibleFiles(conversationId))
}

/**
 * Before showing `rel` in Finder: mark it and every other file in the chat's workspace as downloaded, since Finder
 * shows the whole folder (#67). Under the workspace's lock, so no code can put a link in a path being marked (#76).
 * Throws while the chat's code runs, or if a file can't be marked.
 */
export async function markWorkspaceFiles(conversationId: string, rel: string): Promise<void> {
  if (!isPlainId(conversationId)) return
  await quiesce(workspaceDir(conversationId), async () => {
    const root = await realWorkspace(conversationId)
    const rest = (await visibleFiles(conversationId)).filter((f) => f !== rel)
    await quarantineInWorkspace(...[rel, ...rest].map((f) => join(root, f)))
  })
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

/** On a Mac, open() fails if any part of the path is a link (O_NOFOLLOW_ANY), which code can't race. */
const NO_LINKS = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW

/**
 * Where a file in a chat's workspace would be, by its relative path, or null when that's outside it: the chat id must
 * be a plain id, and the path must stay inside the workspace. Nothing is opened.
 */
export async function workspacePath(conversationId: string, rel: string): Promise<string | null> {
  if (!isPlainId(conversationId) || !rel || isAbsolute(rel)) return null
  try {
    const root = await realWorkspace(conversationId)
    const path = resolve(root, rel)
    return path.startsWith(root + sep) ? path : null
  } catch {
    return null
  }
}

/**
 * Open a file in a chat's workspace by its relative path, or null when it would be anything else. Everything that
 * opens, saves or previews a workspace file goes through this, outside the sandbox, possibly while the chat's code
 * runs: so besides workspacePath's checks, no part of the path may be a link, not the workspace, not a folder in it,
 * not the file (code could link to a file anywhere). The caller closes it.
 */
async function openWorkspaceFile(conversationId: string, rel: string): Promise<{ handle: FileHandle; path: string } | null> {
  const path = await workspacePath(conversationId, rel)
  if (!path) return null
  let handle: FileHandle | null = null
  try {
    handle = await open(path, constants.O_RDONLY | NO_LINKS)
    // Elsewhere only the file itself is checked by open(): the folders above it are checked here.
    const ok = (await handle.stat()).isFile() && (process.platform === 'darwin' || (await realpath(path)) === path)
    if (ok) return { handle, path }
  } catch {
    // Missing, a link, or not a file.
  }
  await handle?.close()
  return null
}

/** The full path of a file in a chat's workspace, checked as openWorkspaceFile does, or null. */
export async function workspaceFile(conversationId: string, rel: string): Promise<string | null> {
  const file = await openWorkspaceFile(conversationId, rel)
  await file?.handle.close()
  return file?.path ?? null
}

/** A workspace file's contents (for the images the chat previews), or null. */
export async function readWorkspaceFile(conversationId: string, rel: string): Promise<Buffer | null> {
  const file = await openWorkspaceFile(conversationId, rel)
  if (!file) return null
  try {
    return await file.handle.readFile()
  } finally {
    await file.handle.close()
  }
}

/** Copy a workspace file to `dest`, from the file that was checked. Returns false when there's none. */
export async function copyWorkspaceFile(conversationId: string, rel: string, dest: string): Promise<boolean> {
  const file = await openWorkspaceFile(conversationId, rel)
  if (!file) return false
  // The read stream closes the handle when it's done.
  await pipeline(file.handle.createReadStream(), createWriteStream(dest))
  return true
}

/**
 * A copy of a workspace file to preview, outside the workspace: Quick Look (or the default app) reads the file by its
 * path, whenever it likes, and code could swap a folder on that path for a link meanwhile. One place per file, so
 * previewing it again replaces its copy. Null when there's no such file.
 */
export async function stageWorkspaceFile(conversationId: string, rel: string): Promise<string | null> {
  if (!isPlainId(conversationId)) return null
  const dir = join(previewsDir(conversationId), createHash('sha256').update(rel).digest('hex').slice(0, 16))
  const dest = join(dir, basename(rel))
  await mkdir(dir, { recursive: true })
  try {
    if (await copyWorkspaceFile(conversationId, rel, dest)) return dest
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw err
  }
  await rm(dir, { recursive: true, force: true })
  return null
}

/** Remove the preview copies (at startup, when none is open). */
export async function clearPreviews(): Promise<void> {
  if (paths.runner) await rm(previewsDir(), { recursive: true, force: true })
}

/**
 * Remove the preview copies as Kiln quits (synchronously: it's the last thing it does). Not before its folders are
 * known: a second copy of Kiln quits at once, and a relative path would be the working folder's.
 */
export function clearPreviewsSync(): void {
  if (paths.runner) rmSync(previewsDir(), { recursive: true, force: true })
}

/** Delete a chat's workspace, scripts, Python environment and preview copies. Under the workspace's lock. */
async function deleteChatFolders(conversationId: string): Promise<void> {
  await Promise.all([
    rm(workspaceDir(conversationId), { recursive: true, force: true }),
    removeChatVenv(conversationId),
    rm(scriptsDir(conversationId), { recursive: true, force: true }),
    rm(previewsDir(conversationId), { recursive: true, force: true })
  ])
  forgetWorkspace(workspaceDir(conversationId))
}

/**
 * Delete a deleted chat's folders, once none of its code is running: code left running could swap a folder for a
 * link while it's being deleted, and the delete would follow it. Never throws: the chat is gone already, so folders
 * that can't be deleted now (its code can't be stopped, say) are left for the next start's sweep.
 */
export async function removeWorkspace(conversationId: string): Promise<void> {
  if (!isPlainId(conversationId)) return
  try {
    await quiesce(workspaceDir(conversationId), () => deleteChatFolders(conversationId))
  } catch (err) {
    console.warn(`Kiln: left the folders of deleted chat ${conversationId} for the next start:`, err)
  }
}

/** Every chat that has folders of its own: a workspace, scripts or a Python environment. */
async function chatsWithFolders(): Promise<string[]> {
  const lists = await Promise.all(
    [paths.workspaces, join(paths.runner, 'scripts'), chatVenvsDir()].map((dir) => readdir(dir).catch(() => [] as string[]))
  )
  return [...new Set(lists.flat())].filter(isPlainId)
}

/**
 * Stop code left running in every chat that has none running now: at startup (after a crash) and when quitting.
 * At startup it also deletes the folders of chats that no longer exist (a delete that couldn't stop their code). A
 * workspace a link replaced (before the sandbox prevented it) becomes a real folder first, so its code can be found.
 * Returns how many processes were stopped.
 */
export async function sweepWorkspaces(opts: { removeOrphans?: boolean } = {}): Promise<number> {
  const ids = await chatsWithFolders()
  for (const id of ids) if (await lstat(workspaceDir(id)).catch(() => null)) await ensureFolder(workspaceDir(id)).catch(() => undefined)
  return quiesceEvery(ids.map(workspaceDir), {
    skipRunning: true,
    work: async (quiet) => {
      if (!opts.removeOrphans) return
      for (const id of quiet.map((w) => basename(w))) if (!getConversation(id)) await deleteChatFolders(id)
    }
  })
}

/** Delete every Kiln Python environment, with no chat's code running or left running (they may write their own). */
export async function resetEnvironments(): Promise<void> {
  const ids = await chatsWithFolders()
  await quiesceEvery(ids.map(workspaceDir), { work: () => resetVenv(ids) })
}
