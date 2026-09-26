import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { promisify } from 'node:util'

// Files a code run wrote leave Kiln marked the way browsers mark downloads (com.apple.quarantine), so macOS asks
// before running one as an app or script, and apps that check the mark treat it as untrusted (#67).

const run = promisify(execFile)
/** Files per xattr call, well inside the argument length limit. */
const BATCH = 200

export const QUARANTINE_ATTR = 'com.apple.quarantine'

/** The mark's value: flags (0081, a download, as Chrome writes it), the time in hex seconds, and the app. */
export function quarantineValue(now = Date.now()): string {
  return `0081;${Math.floor(now / 1000).toString(16)};Kiln;`
}

/** On a Mac, open() refuses a link anywhere in the path (O_NOFOLLOW_ANY), not only as the file itself. */
const O_NOFOLLOW_ANY = 0x20000000

/**
 * Setting the mark needs write permission, which code can take away (a script left read-only would stay unmarked):
 * the owner gets it back first, set on the open file, so only the file itself changes. Outside a workspace a link is
 * marked itself and never opened; in one, every file is opened with no link allowed anywhere in its path, so a link
 * fails the lot. (Never blocking: a FIFO opened for reading would wait for a writer.)
 */
async function ensureWritable(file: string, inWorkspace: boolean): Promise<void> {
  if (!inWorkspace && (await lstat(file)).isSymbolicLink()) return
  const noFollow = inWorkspace ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | noFollow)
  try {
    const s = await handle.stat()
    if (s.isFile() && !(s.mode & 0o200)) await handle.chmod((s.mode & 0o7777) | 0o200)
  } finally {
    await handle.close()
  }
}

async function mark(files: string[], inWorkspace: boolean): Promise<void> {
  if (process.platform !== 'darwin') return
  for (const file of files) await ensureWritable(file, inWorkspace)
  const value = quarantineValue()
  for (let i = 0; i < files.length; i += BATCH)
    await run('/usr/bin/xattr', ['-w', '-s', QUARANTINE_ATTR, value, ...files.slice(i, i + BATCH)])
}

/** Mark files as downloaded (a link itself, never what it points to). Throws if one can't be marked; does nothing off macOS. */
export async function quarantine(...files: string[]): Promise<void> {
  await mark(files, false)
}

/**
 * Mark files in a chat's workspace, by real paths: as quarantine(), but each is opened first with no link allowed
 * anywhere in its path (code can put one there), and one that has a link fails the lot before any is marked.
 */
export async function quarantineInWorkspace(...files: string[]): Promise<void> {
  await mark(files, true)
}
