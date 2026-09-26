import { type ChildProcess, execFile, spawn, type StdioOptions } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

// Every process Kiln starts (MCP servers, sandboxed code) leads its own process group, so stopping it stops whatever
// it started too: `npx` runs the real server as a child, and a script can leave background jobs behind. Signalling
// only the direct child would leave those running after Kiln quits.

const DEFAULT_GRACE_MS = 2_000

/** Groups that may still have processes in them, by the leader's pid (which is also the group id). */
const live = new Map<number, GroupRecord>()

/** What the pidfile keeps of a group, so a later start can find it if Kiln died without stopping it. */
interface GroupRecord {
  startedAt: number
  command: string
}

// A crash or a force quit skips the exit handler below, and detached groups outlive Kiln (sandboxed code stuck in a
// loop, a server that ignores stdin closing). The live groups are written to a file, and the next start stops them.
let pidFile: string | null = null

function persist(): void {
  if (!pidFile) return
  try {
    writeFileSync(pidFile, JSON.stringify([...live].map(([pgid, r]) => ({ pgid, ...r }))))
  } catch {
    // Best effort: a missing record only means an orphan can't be cleaned up later.
  }
}

const forget = (pgid: number) => {
  if (live.delete(pgid)) persist()
}

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
  if (!signalGroup(pgid, 'SIGTERM')) return forget(pgid)
  const deadline = Date.now() + graceMs
  while (groupAlive(pgid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  signalGroup(pgid, 'SIGKILL')
  forget(pgid)
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
  live.set(pgid, { startedAt: Date.now(), command: [command, ...args].join(' ').slice(0, 200) })
  persist()
  child.once('exit', () => void stopGroup(pgid, DEFAULT_GRACE_MS))
  return { child, stop: (graceMs = DEFAULT_GRACE_MS) => stopGroup(pgid, graceMs) }
}

/** Whether any process Kiln started may still be running. */
export const hasChildren = (): boolean => live.size > 0

/** Stop every process Kiln started (before quitting). */
export async function stopAllGroups(graceMs = DEFAULT_GRACE_MS): Promise<void> {
  await Promise.all([...live.keys()].map((pgid) => stopGroup(pgid, graceMs)))
}

// Last resort when Kiln exits without stopping them (a quit that timed out, an exception in the main process).
process.once('exit', () => {
  for (const pgid of live.keys()) signalGroup(pgid, 'SIGKILL')
  live.clear()
  persist()
})

const run = promisify(execFile)

/** When this Mac last started, in ms (groups recorded before then died with it). */
async function bootTime(): Promise<number> {
  try {
    const out = (await run('/usr/sbin/sysctl', ['-n', 'kern.boottime'])).stdout
    return Number(/sec = (\d+)/.exec(out)?.[1] ?? 0) * 1000
  } catch {
    return 0
  }
}

/** `ps` elapsed time ([[dd-]hh:]mm:ss) in ms. */
export function elapsedMs(etime: string): number {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime]
  const parts = clock.split(':').map(Number)
  while (parts.length < 3) parts.unshift(0)
  const [h, m, sec] = parts
  return (((Number(days) * 24 + h) * 60 + m) * 60 + sec) * 1000
}

/**
 * Start recording live groups in `file`, first stopping any a previous run recorded and left behind. A recorded
 * group id is only acted on when it can still be Kiln's: recorded since this Mac started, and with a process in it
 * that started no earlier than the record (a pid reused by something older isn't touched). Returns how many groups
 * were stopped.
 */
export async function trackProcesses(file: string): Promise<number> {
  let recorded: Array<GroupRecord & { pgid: number }> = []
  try {
    recorded = JSON.parse(readFileSync(file, 'utf8')) as typeof recorded
  } catch {
    // No file (a clean exit), or an unreadable one.
  }
  pidFile = file
  persist()
  if (!recorded.length) return 0

  const booted = await bootTime()
  let table: string
  try {
    table = (await run('/bin/ps', ['-A', '-o', 'pid=,pgid=,etime='])).stdout
  } catch {
    return 0
  }
  const now = Date.now()
  const rows = table
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .map(([pid, pgid, etime]) => ({ pid: Number(pid), pgid: Number(pgid), startedAt: now - elapsedMs(etime) }))
  const orphans = recorded.filter(
    (r) => r.startedAt > booted && !live.has(r.pgid) && rows.some((p) => p.pgid === r.pgid && p.startedAt >= r.startedAt - 5_000)
  )
  await Promise.all(orphans.map((r) => stopGroup(r.pgid, 1_000)))
  return orphans.length
}
