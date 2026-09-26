import { existsSync } from 'node:fs'
import type { RunnerStatus } from '@shared/types'
import { findPython, venvDir, venvPython } from './python'
import { sandboxStatus } from './sandbox'

/** Whether code can run here (the sandbox starts, Python 3 is on the PATH), and if not, why. */
export async function runnerStatus(): Promise<RunnerStatus> {
  const [sandbox, python] = await Promise.all([sandboxStatus(), findPython()])
  const reason = !sandbox.ok
    ? sandbox.reason
    : !python
      ? 'Python 3 was not found on your PATH. Install it (for example with Homebrew: brew install python) and restart Kiln.'
      : null
  return { available: !reason, reason, python, venv: venvDir(), venvExists: existsSync(venvPython()) }
}
