import { type ChildProcess, spawn, type StdioOptions } from 'node:child_process'

// Every process Kiln starts (MCP servers, sandboxed code) leads its own process group, so stopping it stops whatever
// it started too: `npx` runs the real server as a child, and a script can leave background jobs behind. Signalling
// only the direct child would leave those running after Kiln quits.

const DEFAULT_GRACE_MS = 2_000

/** Groups that may still have processes in them, by the leader's pid (which is also the group id). */
const live = new Set<number>()

export interface GroupProcess {
  child: ChildProcess
  /** SIGTERM to the whole group, then SIGKILL to anything still there after `graceMs`. */
  stop(graceMs?: number): Promise<void>
}

function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal)
    return true
  } catch {
    return false // ESRCH: nothing left in the group
  }
}

const groupAlive = (pgid: number) => signalGroup(pgid, 0)

async function stopGroup(pgid: number, graceMs: number): Promise<void> {
  if (!signalGroup(pgid, 'SIGTERM')) return void live.delete(pgid)
  const deadline = Date.now() + graceMs
  while (groupAlive(pgid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  signalGroup(pgid, 'SIGKILL')
  live.delete(pgid)
}

/**
 * Start a process as the leader of a new process group. When the leader exits, anything it left in its group is
 * stopped too. Spawn failures (a missing command) arrive as the child's 'error' event, as with `spawn`.
 */
export function spawnGroup(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: StdioOptions } = {}
): GroupProcess {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? ['pipe', 'pipe', 'pipe'],
    // setsid(): the child starts a new process group (and session) with itself as leader.
    detached: true
  })
  const pgid = child.pid
  if (pgid === undefined) return { child, stop: async () => undefined }
  live.add(pgid)
  child.once('exit', () => void stopGroup(pgid, DEFAULT_GRACE_MS))
  return { child, stop: (graceMs = DEFAULT_GRACE_MS) => stopGroup(pgid, graceMs) }
}

/** Whether any process Kiln started may still be running. */
export const hasChildren = (): boolean => live.size > 0

/** Stop every process Kiln started (before quitting). */
export async function stopAllGroups(graceMs = DEFAULT_GRACE_MS): Promise<void> {
  await Promise.all([...live].map((pgid) => stopGroup(pgid, graceMs)))
}

// Last resort when Kiln exits without stopping them (a quit that timed out, a crash in the main process).
process.once('exit', () => {
  for (const pgid of live) signalGroup(pgid, 'SIGKILL')
})
