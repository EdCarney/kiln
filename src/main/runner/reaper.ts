import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { childEnv } from '../env'
import { findPython } from './python'

// A run's process group is stopped when it ends, but code can leave it: fork, setsid(), let go of its output. Such a
// process outlives the run, Stop and Kiln, and nothing ties it to the run once launchd adopts it (#73). Its sandbox
// does, though: a process can't leave its sandbox, and only a chat's own code may write that chat's folder. So when a
// run ends, Kiln asks macOS (sandbox_check) which of the user's processes are sandboxed and allowed to write the chat's
// folder, and stops them. Kiln touches a chat's folder outside the sandbox only when no such process is left (#71):
// while one runs, it could swap a folder for a link between Kiln's check and its write.

const run = promisify(execFile)

/**
 * Stops every process of the user's that Kiln's sandbox runs for one of the folders given as arguments, and prints
 * {"stopped": n, "left": [pids still running]}. That's a process that is sandboxed, may write the folder, and may not
 * write the folder holding it: Kiln's policy allows only the workspace, while a sandbox that also covers a folder above
 * it (macOS agents and browser helpers may write the per-user temp folder, say) isn't Kiln's. Each is stopped (SIGSTOP)
 * first, so none can fork or exit while the rest are found, and so its pid can't be reused: a stopped process that no
 * longer matches had its pid reused just before, and is let go. Then all are killed. If anything goes wrong, every
 * process it stopped is let go.
 */
const REAPER = String.raw`
import ctypes, json, os, signal, sys, time
lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
check = lib.sandbox_check
check.restype = ctypes.c_int
# Only the fixed arguments are declared: the path is variadic, which Apple silicon passes differently.
check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
listpids = lib.proc_listpids
listpids.restype = ctypes.c_int
listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
PROC_UID_ONLY, FILTER_PATH, NO_REPORT = 4, 1, 0x40000000
folders = [(ctypes.c_char_p(os.fsencode(f)), ctypes.c_char_p(os.fsencode(os.path.dirname(f)))) for f in sys.argv[1:]]
me = os.getpid()

def pids():
    size = listpids(PROC_UID_ONLY, os.getuid(), None, 0)
    buf = (ctypes.c_int * (max(size, 0) // 4 + 256))()
    size = listpids(PROC_UID_ONLY, os.getuid(), buf, ctypes.sizeof(buf))
    return [p for p in buf[: max(size, 0) // 4] if p > 0 and p != me]

def may_write(pid, path):
    return check(pid, b'file-write-data', FILTER_PATH | NO_REPORT, path) == 0

def kilns(pid):
    if check(pid, None, 0) != 1:
        return False
    # The folders mostly share a parent, and most sandboxes that may write one may write the parent: ask that first.
    parents = {}
    for f, parent in folders:
        if parent.value not in parents:
            parents[parent.value] = may_write(pid, parent)
        if not parents[parent.value] and may_write(pid, f):
            return True
    return False

def send(pid, sig):
    try:
        os.kill(pid, sig)
        return True
    except OSError:
        return False

held = set()
try:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        found = [p for p in pids() if p not in held and kilns(p)]
        if not found:
            break
        for p in found:
            if send(p, signal.SIGSTOP):
                if kilns(p):
                    held.add(p)
                else:
                    send(p, signal.SIGCONT)
except BaseException:
    for p in held:
        send(p, signal.SIGCONT)
    raise
for p in held:
    send(p, signal.SIGKILL)
left = []
for _ in range(40):
    left = [p for p in pids() if kilns(p)]
    if not left:
        break
    time.sleep(0.025)
print(json.dumps({'stopped': len(held), 'left': left}))
`

/** Workspaces with code running in them now, by folder (a count: a venv is made in the sandbox before a run). */
const running = new Map<string, number>()
/**
 * Checks in progress, by workspace. Code doesn't start in a workspace while one runs there: the check would stop it
 * as a leftover.
 */
const checking = new Map<string, Promise<unknown>>()
/** Workspaces checked since their last run: none of their code is still running. */
const settled = new Set<string>()
/** Workspaces code ran in this session that haven't been checked since (a check failed). */
const unchecked = new Set<string>()

export class CodeRunningError extends Error {
  constructor(where = 'this chat') {
    super(`Code is running in ${where}. Try again when it finishes.`)
  }
}

/** Real folders among `folders` (a process's sandbox is checked against a folder that exists), by their real path. */
async function existingFolders(folders: string[]): Promise<string[]> {
  const found = await Promise.all(
    folders.map(async (f) => ((await lstat(f).catch(() => null))?.isDirectory() ? realpath(f).catch(() => null) : null))
  )
  return found.filter((f): f is string => f !== null)
}

/**
 * Stop every process whose sandbox lets it write one of these folders: code from the chats they belong to. Returns
 * how many were stopped, and throws if any is still running afterwards. On Linux the sandbox (bubblewrap, in its own
 * process namespace) takes every process with it when the run ends, so there's nothing to do.
 */
export async function reap(folders: string[]): Promise<number> {
  if (process.platform !== 'darwin') return 0
  const existing = await existingFolders(folders)
  if (!existing.length) return 0
  const python = await findPython()
  if (!python) throw new Error("Python 3 wasn't found, so Kiln couldn't check for code still running.")
  // -I: none of the user's PYTHON* settings or site-packages; -S -B: no site module, no .pyc files written.
  const { stdout } = await run(python.path, ['-I', '-S', '-B', '-c', REAPER, ...existing], {
    env: await childEnv(),
    timeout: 20_000
  })
  const { stopped, left } = JSON.parse(stdout) as { stopped: number; left: number[] }
  if (left.length) throw new Error(`Code from this chat is still running (process ${left.join(', ')}) and couldn't be stopped.`)
  return stopped
}

/** Checks in progress in any of these workspaces. */
const checksIn = (workspaces: string[]) => workspaces.map((w) => checking.get(w)).filter((p) => p !== undefined)

/**
 * Run `check` as the only check in these workspaces, with no code starting in them meanwhile. The wait is a loop
 * here, not a helper awaited: from its last look to claiming the workspaces there must be no await, or another check
 * could slip in.
 */
async function exclusive<T>(workspaces: string[], check: () => Promise<T>): Promise<T> {
  for (let pending = checksIn(workspaces); pending.length; pending = checksIn(workspaces)) await Promise.allSettled(pending)
  const done = check()
  for (const w of workspaces) checking.set(w, done)
  try {
    return await done
  } finally {
    for (const w of workspaces) if (checking.get(w) === done) checking.delete(w)
  }
}

function settle(workspace: string): void {
  settled.add(workspace)
  unchecked.delete(workspace)
}

/** Code is about to start in `workspace` (once no check is running there). */
export async function codeStarting(workspace: string): Promise<void> {
  for (let pending = checksIn([workspace]); pending.length; pending = checksIn([workspace])) await Promise.allSettled(pending)
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
    await exclusive([workspace], async () => {
      await reap([workspace])
      settle(workspace)
    })
  } catch (err) {
    console.warn(`Kiln: couldn't stop code left running in ${workspace}:`, err)
  }
}

/**
 * Before Kiln reads or writes a chat's folder outside the sandbox: make sure none of the chat's code is running,
 * stopping any a run left behind. Throws CodeRunningError while a run is in progress, or if leftovers can't be stopped.
 */
export async function quiesce(workspace: string): Promise<void> {
  if (running.has(workspace)) throw new CodeRunningError()
  await exclusive([workspace], async () => {
    // A run may have started while an earlier check finished.
    if (running.has(workspace)) throw new CodeRunningError()
    if (settled.has(workspace)) return
    await reap([workspace])
    settle(workspace)
  })
}

/** Whether code this session started may still be running (in a run, or left behind where a check failed). */
export const codeMayBeRunning = (): boolean => running.size > 0 || unchecked.size > 0

/**
 * Stop code left running in any of these workspaces (all of them: at startup after a crash, when quitting, before
 * deleting every Python environment). Throws CodeRunningError while code runs in one. Returns how many processes were
 * stopped.
 */
export async function quiesceEvery(workspaces: string[]): Promise<number> {
  if (workspaces.some((w) => running.has(w))) throw new CodeRunningError('a chat')
  return exclusive(workspaces, async () => {
    if (workspaces.some((w) => running.has(w))) throw new CodeRunningError('a chat')
    const stopped = await reap(workspaces)
    for (const w of workspaces) settle(w)
    return stopped
  })
}

/** Forget a folder that was deleted. */
export function forgetWorkspace(workspace: string): void {
  settled.delete(workspace)
  unchecked.delete(workspace)
}
