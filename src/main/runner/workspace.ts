import { randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { copyFile, type FileHandle, lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { attachmentRowsForConversation } from '../db/conversations'
import { paths } from '../paths'
import { removeChatVenv } from './python'
import { forgetWorkspace, quiesce, quiesceEvery } from './reaper'
import { KILN_DIR } from './sandbox'

// Each chat that runs code gets a folder: code runs there, the chat's attachments are copied into uploads/, and
// what code writes is listed on the run's card. It's deleted with the chat.
//
// Code can write anything in the folder, and Kiln works in it outside the sandbox, so Kiln must never follow a link
// code left there (#71). The sandbox won't let code replace the folder itself or .kiln (see policyFor). Otherwise Kiln
// changes or lists the folder only while none of the chat's code runs (quiesce), replacing any link where it expects
// a folder; and it hands a file out only by opening it with no link anywhere in its path.

export const UPLOADS_DIR = 'uploads'
const MAX_FILES = 5000
const MAX_LISTED = 20

export const workspaceDir = (conversationId: string): string => join(paths.workspaces, conversationId)
/** The scripts a chat's runs execute: outside its workspace, where code can read them but never change them. */
export const scriptsDir = (conversationId: string): string => join(paths.runner, 'scripts', conversationId)
/** Copies of files being previewed, so what's previewed is the file that was checked. Cleared at startup. */
const previewsDir = (): string => join(paths.runner, 'previews')

const validId = (conversationId: string) => /^[\w-]+$/.test(conversationId)

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
 * The chat's workspace, with its attachments copied into uploads/ (names made unique). Returns the folder and the
 * upload names, for the prompt.
 */
export async function prepareWorkspace(conversationId: string): Promise<{ dir: string; uploads: string[] }> {
  const dir = workspaceDir(conversationId)
  await readyForRun(dir)
  const rows = attachmentRowsForConversation(conversationId)
  const uploads: string[] = []
  if (rows.length) await ensureFolder(join(dir, UPLOADS_DIR))
  for (const row of rows) {
    let name = safeName(row.name)
    for (let n = 2; uploads.includes(name); n++) name = safeName(row.name).replace(/(\.[^.]*)?$/, (ext) => ` (${n})${ext}`)
    uploads.push(name)
    const target = join(dir, UPLOADS_DIR, name)
    const existing = await lstat(target).catch(() => null)
    if (existing?.isFile() && existing.size === row.size) continue
    // A changed copy, or a link or folder code put in its place: replaced, never written through.
    if (existing) await rm(target, { recursive: true, force: true })
    await copyFile(row.path, target, constants.COPYFILE_EXCL).catch(() => undefined)
  }
  return { dir, uploads }
}

/**
 * Before code runs in a workspace: none of its code is still running (see quiesce), and it and Kiln's folders in it
 * (the sandbox's HOME and TMPDIR, which code may have deleted) are real folders. Throws if leftover code can't be
 * stopped.
 */
export async function readyForRun(dir: string): Promise<void> {
  await mkdir(dirname(dir), { recursive: true })
  await ensureFolder(dir)
  await quiesce(dir)
  for (const sub of [KILN_DIR, join(KILN_DIR, 'home'), join(KILN_DIR, 'tmp')]) await ensureFolder(join(dir, sub))
}

export type Snapshot = Map<string, { size: number; mtimeMs: number }>

/**
 * Regular files under `dir`, by relative path, at most MAX_FILES: links aren't followed (nor is `dir` itself if it's
 * one), and entries `skip` names are left out. Breadth-first, so when there are too many, the ones nearer the top
 * (what Finder shows first) are kept. Only while no code runs in `dir`: code could swap a folder for a link mid-walk.
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
 * Every file in the workspace except Kiln's own and the uploads, with its size and modification time. Waits for no
 * code to be running there (see quiesce), and throws if some is.
 */
export async function snapshot(dir: string): Promise<Snapshot> {
  await quiesce(dir)
  const files: Snapshot = new Map()
  for (const rel of await listFiles(dir, (rel, name) => rel === KILN_DIR || rel === UPLOADS_DIR || name === '__pycache__')) {
    const s = await lstat(join(dir, rel)).catch(() => null)
    if (s?.isFile()) files.set(rel, { size: s.size, mtimeMs: s.mtimeMs })
  }
  return files
}

/**
 * Every file in a chat's workspace a user can see in Finder (not Kiln's hidden .kiln folder), as full paths. Show in
 * Finder marks them all as downloaded, since Finder shows the whole folder (#67). Throws while the chat's code runs.
 */
export async function workspaceFiles(conversationId: string): Promise<string[]> {
  if (!validId(conversationId)) return []
  const dir = workspaceDir(conversationId)
  await quiesce(dir)
  return (await listFiles(dir, (rel) => rel === KILN_DIR)).map((rel) => join(dir, rel))
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
 * Open a file in a chat's workspace by its relative path, or null when it would be anything else. Everything that
 * opens, saves or previews a workspace file goes through this, outside the sandbox, possibly while the chat's code
 * runs. So the chat id must be a plain id, the path must stay inside the workspace, and no part of it may be a link:
 * not the workspace, not a folder in it, not the file (code could link to a file anywhere). The caller closes it.
 */
async function openWorkspaceFile(conversationId: string, rel: string): Promise<{ handle: FileHandle; path: string } | null> {
  if (!validId(conversationId) || !rel || isAbsolute(rel)) return null
  let handle: FileHandle | null = null
  try {
    // The folder that holds the workspaces is Kiln's own (code can't write it), so its real path can be trusted.
    const root = join(await realpath(paths.workspaces), conversationId)
    const path = resolve(root, rel)
    if (!path.startsWith(root + sep)) return null
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

/** Copy a workspace file to `dest` (a new file), from the file that was checked. Returns false when there's none. */
export async function copyWorkspaceFile(conversationId: string, rel: string, dest: string): Promise<boolean> {
  const file = await openWorkspaceFile(conversationId, rel)
  if (!file) return false
  // The read stream closes the handle when it's done.
  await pipeline(file.handle.createReadStream(), createWriteStream(dest))
  return true
}

/**
 * A copy of a workspace file to preview, in a folder of its own outside the workspace: Quick Look (or the default app)
 * reads the file by its path, whenever it likes, and code could swap a folder on that path for a link meanwhile.
 */
export async function stageWorkspaceFile(conversationId: string, rel: string): Promise<string | null> {
  const dir = join(previewsDir(), randomUUID())
  await mkdir(dir, { recursive: true })
  const dest = join(dir, basename(rel))
  if (await copyWorkspaceFile(conversationId, rel, dest)) return dest
  await rm(dir, { recursive: true, force: true })
  return null
}

/** Remove the preview copies (at startup, when none is open). */
export async function clearPreviews(): Promise<void> {
  await rm(previewsDir(), { recursive: true, force: true })
}

/**
 * Delete a chat's workspace, scripts and Python environment, once none of its code is running: code left running
 * could swap a folder for a link while it's being deleted, and the delete would follow it.
 */
export async function removeWorkspace(conversationId: string): Promise<void> {
  if (!validId(conversationId)) return
  const dir = workspaceDir(conversationId)
  await quiesce(dir)
  await Promise.all([
    rm(dir, { recursive: true, force: true }),
    removeChatVenv(conversationId),
    rm(scriptsDir(conversationId), { recursive: true, force: true })
  ])
  forgetWorkspace(dir)
}

/**
 * Stop code left running in any chat: at startup (after a crash), when quitting, and before deleting every Python
 * environment. A workspace a link replaced (before the sandbox prevented it) becomes a real folder first, so its
 * code can be found. Throws while code runs in some chat. Returns how many processes were stopped.
 */
export async function quiesceAll(): Promise<number> {
  const ids = (await readdir(paths.workspaces).catch(() => [] as string[])).filter(validId)
  const dirs = ids.map(workspaceDir)
  for (const dir of dirs) await ensureFolder(dir).catch(() => undefined)
  return quiesceEvery(dirs)
}
