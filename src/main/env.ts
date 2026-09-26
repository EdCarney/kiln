import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

// macOS starts apps from the Dock or Finder with a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so anything Ollmost
// spawns (MCP servers via npx or uvx, a code runner via python3) wouldn't find tools from Homebrew, nvm, uv and
// the like. Ollmost asks the user's login shell for its PATH once, and gives it to every process it starts.

const MARK = '__OLLMOST_ENV__'
const LOGIN_TIMEOUT_MS = 3_000

/** Where these tools usually live, for when the login shell can't be asked. Only ones that exist are used. */
export const FALLBACK_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.cargo', 'bin')
]

/** Join PATH lists, keeping the first occurrence of each directory. */
export function mergePath(...lists: Array<string | null | undefined>): string {
  const dirs = lists.flatMap((list) => (list ? list.split(delimiter) : [])).filter(Boolean)
  return [...new Set(dirs)].join(delimiter)
}

/**
 * The PATH an interactive login shell sets up (`-i` too, because many people set PATH in .zshrc), or null if
 * the shell fails or takes too long. The shell prints its whole environment between markers, which works in
 * fish as well (its "$PATH" would join with spaces) and ignores any banner a startup file prints.
 */
export function readLoginPath(shell: string, timeoutMs = LOGIN_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s\\n' '${MARK}'; /usr/bin/env; printf '%s\\n' '${MARK}'`],
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
      (_err, stdout) => {
        // A shell can exit non-zero after printing everything (a failing line in .zshrc), so only the output counts.
        const env = String(stdout ?? '').split(MARK)[1] ?? ''
        const line = env.split('\n').find((l) => l.startsWith('PATH='))
        resolve(line?.slice('PATH='.length).trim() || null)
      }
    )
  })
}

/** The PATH for processes Ollmost starts: the login shell's, else Ollmost's own plus the usual tool folders. */
export async function loginPath(
  opts: { shell?: string; timeoutMs?: number; basePath?: string; fallbackDirs?: string[] } = {}
): Promise<string> {
  const base = opts.basePath ?? process.env.PATH
  const shell = opts.shell ?? process.env.SHELL ?? '/bin/zsh'
  const fromShell = await readLoginPath(shell, opts.timeoutMs)
  if (fromShell) return mergePath(fromShell, base)
  return mergePath(base, ...(opts.fallbackDirs ?? FALLBACK_DIRS).filter((dir) => existsSync(dir)))
}

let resolved: Promise<string> | null = null

/** Ollmost's PATH for child processes, worked out once (call early at startup so the first spawn doesn't wait). */
export function childPath(): Promise<string> {
  resolved ??= loginPath()
  return resolved
}

/**
 * The variables a process Ollmost starts inherits from Ollmost: the MCP SDK's own list (its StdioClientTransport passes only
 * these), plus the temp folder and locale. Anything else in Ollmost's environment (a terminal launch carries AWS_*,
 * GITHUB_TOKEN and the like) stays out; a server that needs a variable gets it from its own settings.
 */
export const INHERITED_ENV = ['HOME', 'LOGNAME', 'SHELL', 'TERM', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE']

/** The inherited variables from `env`, leaving out exported shell functions (`() { …`), as the SDK does. */
export function inheritedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const key of INHERITED_ENV) {
    const value = env[key]
    if (value !== undefined && !value.startsWith('()')) kept[key] = value
  }
  return kept
}

/** The environment for a process Ollmost starts: the inherited variables, the login shell's PATH, then its own. */
export async function childEnv(extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  return { ...inheritedEnv(), PATH: await childPath(), ...extra }
}
