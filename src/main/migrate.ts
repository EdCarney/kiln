import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { transaction } from './db/index'
import { deleteSetting, readSetting, writeSetting } from './db/kv'
import { forgetEnvValues } from './mcp/config'

// Kiln was renamed Ollmost (#60). An install that ran Kiln has its data in the folder next to Ollmost's, named for
// the old app; the first launch moves it over (phase 1, before anything can create the new folder), then finishes
// the move inside it (phase 2). This file holds the old names, so the rename must never touch it.

export const OLD_FOLDER = 'Kiln'
export const OLD_DB = 'kiln.db'
export const OLD_WORKSPACE_DIR = '.kiln'
/** Written once the folder has moved; removed when phase 2 has finished. */
export const MARKER = '.migrating-from-kiln'

/** Where Kiln kept the data for this data folder: next to it. */
export const oldDataFolder = (dataDir: string): string => join(dirname(dataDir), OLD_FOLDER)

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Kiln itself, or Electron running Kiln from source. */
function isKilnProcess(pid: number): boolean {
  try {
    return /\/(Kiln|Electron)$/.test(execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim())
  } catch {
    return false
  }
}

/**
 * Kiln's pid while it runs. Kiln always holds Chromium's singleton lock, a link in its folder to "<host>-<pid>"; a
 * lock left by a crash names a dead process, or one another program has since been given.
 */
export function kilnPid(folder: string, isKiln: (pid: number) => boolean = isKilnProcess): number | null {
  let target: string
  try {
    target = readlinkSync(join(folder, 'SingletonLock'))
  } catch {
    return null
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1))
  return Number.isInteger(pid) && pid > 0 && alive(pid) && isKiln(pid) ? pid : null
}

export type MoveResult =
  { state: 'none' } | { state: 'moved' } | { state: 'kiln-running'; pid: number } | { state: 'failed'; error: string }

/**
 * Whether `dir` holds anything. Electron creates the default data folder, empty, before the app's code runs, so an
 * empty one is as good as none (a rename replaces an empty folder). Anything unreadable counts as in use.
 */
function hasData(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/**
 * Move Kiln's data folder to `dataDir`, if Kiln left one there and nothing is in `dataDir` yet. Synchronous: it runs
 * before the single-instance lock, which puts Chromium's files in the data folder, and then the move would never happen.
 */
export function moveKilnData(dataDir: string, opts: { isKiln?: (pid: number) => boolean } = {}): MoveResult {
  const from = oldDataFolder(dataDir)
  if (from === dataDir || hasData(dataDir) || !existsSync(join(from, OLD_DB))) return { state: 'none' }
  const pid = kilnPid(from, opts.isKiln)
  if (pid !== null) return { state: 'kiln-running', pid }
  try {
    renameSync(from, dataDir)
  } catch (err) {
    return { state: 'failed', error: (err as Error).message }
  }
  // Chromium's lock files belong to Kiln's last session.
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) rmSync(join(dataDir, name), { force: true })
  writeFileSync(join(dataDir, MARKER), new Date().toISOString())
  return { state: 'moved' }
}

/**
 * Show `show` (a message that closes when its signal aborts) until Kiln has quit. True once it has (the caller
 * relaunches, and the relaunch moves the folder); false when the user quit instead.
 */
export async function waitForKiln(
  isRunning: () => boolean,
  show: (signal: AbortSignal) => Promise<unknown>,
  intervalMs = 500
): Promise<boolean> {
  const quit = new AbortController()
  const timer = setInterval(() => {
    if (!isRunning()) quit.abort()
  }, intervalMs)
  try {
    await show(quit.signal)
    return quit.signal.aborted
  } finally {
    clearInterval(timer)
  }
}

export const STILL_OPEN = {
  message: 'Kiln is still open',
  detail: 'Quit Kiln to move your chats, projects and settings to Ollmost. Ollmost will carry on by itself once Kiln has quit.',
  button: 'Quit Ollmost'
}

export const moveFailedText = (error: string): { title: string; content: string } => ({
  title: "Ollmost couldn't move your Kiln data",
  content: `${error}\n\nNothing was changed: Kiln still has all of it.`
})

export const renameFailedText = (error: string, dataDir: string): { title: string; content: string } => ({
  title: "Ollmost couldn't open your Kiln data",
  content: `${error}\n\nIt's all still in ${dataDir}. Ollmost tries again the next time it opens.`
})

/** Whether a moved Kiln folder still has work left: the marker, or Kiln's database not yet renamed. */
export function migrationPending(dataDir: string, dbFile: string): boolean {
  return existsSync(join(dataDir, MARKER)) || (basename(dbFile) !== OLD_DB && existsSync(join(dataDir, OLD_DB)))
}

/**
 * Give Kiln's database its new name, before it's opened. The marker goes first, so a crash before phase 2 has
 * finished still finishes it. Then the WAL and shared-memory files, then the database: SQLite finds the WAL by the
 * database's name, so ollmost.db must never sit next to a kiln.db-wal (its unsaved transactions would be lost).
 */
export function renameDatabase(dataDir: string, dbFile: string): void {
  const oldDb = join(dataDir, OLD_DB)
  if (dbFile === oldDb) return
  if (!existsSync(join(dataDir, MARKER))) writeFileSync(join(dataDir, MARKER), new Date().toISOString())
  if (!existsSync(oldDb)) return
  if (existsSync(dbFile)) return void console.warn(`Ollmost: both ${OLD_DB} and ${basename(dbFile)} exist; using ${basename(dbFile)}`)
  for (const suffix of ['-wal', '-shm', '']) if (existsSync(oldDb + suffix)) renameSync(oldDb + suffix, dbFile + suffix)
}

export interface MigrationNotice {
  at: number
  /** An ollama.com API key was saved: it needs entering again. */
  apiKey: boolean
  /** MCP servers whose environment values need entering again, by id. */
  servers: string[]
  dismissed: boolean
}

const NOTICE_KEY = 'migratedFromKiln'

/**
 * Finish the move, once the database is open. Secrets Kiln encrypted with its keychain entry are forgotten (read with
 * Ollmost's key they'd fail, or about once in 256 decrypt to garbage), noting in the same transaction what to ask for
 * again. The Python environments go (they point at the old folder; the next run rebuilds them), and each chat's
 * hidden folder gets its new name (it holds the run's home folder). Every step can run again after a crash; the
 * marker goes last. A step that fails (code can make its own folders unwritable) is logged and the rest still run:
 * the marker stays, so the next launch tries again, and Ollmost starts either way.
 */
export async function finishMigration(dataDir: string, workspaceDir: string): Promise<void> {
  let finished = true
  const step = async (what: string, act: () => unknown): Promise<void> => {
    try {
      await act()
    } catch (err) {
      finished = false
      console.warn(`Ollmost: couldn't ${what} after the move from Kiln (the next launch tries again):`, err)
    }
  }
  await step('forget its secrets', () =>
    transaction(() => {
      if (readSetting<MigrationNotice | null>(NOTICE_KEY, null)) return
      const apiKey = readSetting<string | null>('apiKey', null) !== null
      deleteSetting('apiKey')
      writeSetting(NOTICE_KEY, { at: Date.now(), apiKey, servers: forgetEnvValues(), dismissed: false } satisfies MigrationNotice)
    })
  )
  // rm removes a link code left in an environment without following it.
  for (const venv of ['base-venv', 'venvs', 'venv'])
    await step(`remove runner/${venv}`, () => rm(join(dataDir, 'runner', venv), { recursive: true, force: true }))
  const workspaces = join(dataDir, 'workspaces')
  for (const id of await readdir(workspaces).catch(() => [] as string[])) {
    const from = join(workspaces, id, OLD_WORKSPACE_DIR)
    const to = join(workspaces, id, workspaceDir)
    if (from === to || !(await lstat(from).catch(() => null))) continue
    // rename and rm act on the entry itself: a link code put there is moved or removed, never followed.
    await step(`rename workspaces/${id}/${OLD_WORKSPACE_DIR}`, async () => {
      if (await lstat(to).catch(() => null)) await rm(from, { recursive: true, force: true })
      else await rename(from, to)
    })
  }
  if (finished) await rm(join(dataDir, MARKER), { force: true })
}

/** What didn't carry over, until the user dismisses the notice. */
export function migrationNotice(): MigrationNotice | null {
  const notice = readSetting<MigrationNotice | null>(NOTICE_KEY, null)
  return notice && !notice.dismissed ? notice : null
}

export function dismissMigrationNotice(): void {
  const notice = readSetting<MigrationNotice | null>(NOTICE_KEY, null)
  if (notice) writeSetting(NOTICE_KEY, { ...notice, dismissed: true })
}
