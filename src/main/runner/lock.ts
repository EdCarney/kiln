import { basename } from 'node:path'
import { chatVenvDir } from './python'
import { reap } from './reaper'

// Kiln works in a chat's folders outside the sandbox (getting the workspace ready, listing and marking its files,
// deleting it, resetting environments), so it must never do that while code that could change them runs: code could
// swap a folder for a link between Kiln's check and its write, and Kiln would follow it (#71). Code runs in a chat's
// folders two ways: a run in progress, or a process a run left behind (#73). So Kiln's work in a workspace goes inside
// its lock (quiesce): no run in progress, leftovers stopped first, and no run starting until the work is done (#76).

/** Workspaces with code running in them now, by folder (a count: a venv is made in the sandbox before a run). */
const running = new Map<string, number>()
/** Work in progress under a workspace's lock (a check, and what it protects). Code doesn't start there meanwhile. */
const locked = new Map<string, Promise<unknown>>()
/** Workspaces checked since their last run: none of their code is still running. */
const settled = new Set<string>()
/** Workspaces code ran in this session that haven't been checked since (a check failed). */
const unchecked = new Set<string>()

export class CodeRunningError extends Error {
  constructor(where = 'this chat') {
    super(`Code is running in ${where}. Try again when it finishes.`)
  }
}

/** The folders a chat's code may write: its workspace, and its own Python environment (with PyPI allowed). */
const foldersOf = (workspace: string) => [workspace, chatVenvDir(basename(workspace))]

const lockedIn = (workspaces: string[]) => workspaces.map((w) => locked.get(w)).filter((p) => p !== undefined)

/**
 * Run `work` holding these workspaces' locks, once no other work holds any of them. The wait is a loop here, not a
 * helper awaited: from its last look to taking the locks there must be no await, or other work could slip in.
 */
async function exclusive<T>(workspaces: string[], work: () => Promise<T>): Promise<T> {
  for (let pending = lockedIn(workspaces); pending.length; pending = lockedIn(workspaces)) await Promise.allSettled(pending)
  const done = work()
  for (const w of workspaces) locked.set(w, done)
  try {
    return await done
  } finally {
    for (const w of workspaces) if (locked.get(w) === done) locked.delete(w)
  }
}

/** Stop code left running in these workspaces. Only a workspace whose folder the check covered counts as settled. */
async function check(workspaces: string[]): Promise<number> {
  const { stopped, checked } = await reap(workspaces.flatMap(foldersOf))
  for (const w of workspaces) {
    if (!checked.includes(w)) continue
    settled.add(w)
    unchecked.delete(w)
  }
  return stopped
}

/** Code is about to start in `workspace` (once no work holds its lock). */
export async function codeStarting(workspace: string): Promise<void> {
  for (let pending = lockedIn([workspace]); pending.length; pending = lockedIn([workspace])) await Promise.allSettled(pending)
  settled.delete(workspace)
  unchecked.add(workspace)
  running.set(workspace, (running.get(workspace) ?? 0) + 1)
}

/** Code in `workspace` has ended: stop anything it left running. A failure is left for the next quiesce() to report. */
export async function codeEnded(workspace: string): Promise<void> {
  const n = (running.get(workspace) ?? 1) - 1
  if (n > 0) return void running.set(workspace, n)
  running.delete(workspace)
  try {
    await exclusive([workspace], () => check([workspace]))
  } catch (err) {
    console.warn(`Kiln: couldn't stop code left running in ${workspace}:`, err)
  }
}

/**
 * Do `work` in a chat's folders outside the sandbox: with none of the chat's code running (leftovers stopped first),
 * and no run starting until it's done. Throws CodeRunningError while a run is in progress, or if leftovers can't be
 * stopped. `work` must not quiesce the same workspace again: it would wait for itself.
 */
export async function quiesce<T>(workspace: string, work: () => Promise<T>): Promise<T> {
  if (running.has(workspace)) throw new CodeRunningError()
  return exclusive([workspace], async () => {
    // A run may have started while earlier work finished.
    if (running.has(workspace)) throw new CodeRunningError()
    if (!settled.has(workspace)) await check([workspace])
    return work()
  })
}

/**
 * Stop code left running in these workspaces, then do `work` with the ones that are quiet, under all their locks.
 * Returns how many processes were stopped. By default any run in progress refuses it all (deleting every environment
 * mustn't pull one from under a run); `skipRunning` leaves running workspaces to their run's end instead (the sweeps
 * at startup and when quitting).
 */
export async function quiesceEvery(
  workspaces: string[],
  opts: { skipRunning?: boolean; work?: (quiet: string[]) => Promise<void> } = {}
): Promise<number> {
  const busy = () => workspaces.filter((w) => running.has(w))
  if (!opts.skipRunning && busy().length) throw new CodeRunningError('a chat')
  const claimed = opts.skipRunning ? workspaces.filter((w) => !running.has(w)) : workspaces
  return exclusive(claimed, async () => {
    const quiet = claimed.filter((w) => !running.has(w))
    if (!opts.skipRunning && quiet.length < claimed.length) throw new CodeRunningError('a chat')
    const stopped = await check(quiet)
    await opts.work?.(quiet)
    return stopped
  })
}

/** Whether code this session started may still be running (in a run, or left behind where a check failed). */
export const codeMayBeRunning = (): boolean => running.size > 0 || unchecked.size > 0

/** Forget a workspace that was deleted. */
export function forgetWorkspace(workspace: string): void {
  settled.delete(workspace)
  unchecked.delete(workspace)
}
