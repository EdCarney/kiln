import { execFileSync } from 'node:child_process'
import { existsSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
 * Move Kiln's data folder to `dataDir`, if Kiln left one there and nothing is at `dataDir` yet. Synchronous: it runs
 * before the single-instance lock, which makes Chromium create the data folder, and then the move would never happen.
 */
export function moveKilnData(dataDir: string, opts: { isKiln?: (pid: number) => boolean } = {}): MoveResult {
  const from = oldDataFolder(dataDir)
  if (from === dataDir || existsSync(dataDir) || !existsSync(join(from, OLD_DB))) return { state: 'none' }
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
