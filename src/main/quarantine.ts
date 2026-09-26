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

/**
 * Setting the mark needs write permission, which code can take away (a script left read-only would stay unmarked):
 * the owner gets it back first. The file is opened without following a link, so only the file itself changes.
 */
async function ensureWritable(file: string): Promise<void> {
  const s = await lstat(file)
  if (!s.isFile() || s.mode & 0o200) return
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    await handle.chmod((s.mode & 0o7777) | 0o200)
  } finally {
    await handle.close()
  }
}

/** Mark files as downloaded (a link itself, never what it points to). Throws if one can't be marked; does nothing off macOS. */
export async function quarantine(...files: string[]): Promise<void> {
  if (process.platform !== 'darwin') return
  for (const file of files) await ensureWritable(file)
  const value = quarantineValue()
  for (let i = 0; i < files.length; i += BATCH)
    await run('/usr/bin/xattr', ['-w', '-s', QUARANTINE_ATTR, value, ...files.slice(i, i + BATCH)])
}
