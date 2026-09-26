import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Files a code run wrote leave Kiln marked the way browsers mark downloads (com.apple.quarantine), so macOS asks
// before running one as an app or script, and apps that check the mark treat it as untrusted (#67).

const run = promisify(execFile)

export const QUARANTINE_ATTR = 'com.apple.quarantine'

/** The mark's value: flags (0081, a download, as Chrome writes it), the time in hex seconds, and the app. */
export function quarantineValue(now = Date.now()): string {
  return `0081;${Math.floor(now / 1000).toString(16)};Kiln;`
}

/** Mark a file as downloaded. Throws if it can't be marked; does nothing off macOS. */
export async function quarantine(file: string): Promise<void> {
  if (process.platform !== 'darwin') return
  await run('/usr/bin/xattr', ['-w', QUARANTINE_ATTR, quarantineValue(), file])
}
