import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { childEnv } from '../env'
import { spawnGroup } from '../processes'
import { errorMessage } from '../util'

// Code the model writes runs under macOS's Seatbelt sandbox through @anthropic-ai/sandbox-runtime (the one Claude
// Code uses). The package is ESM-only and Kiln's main process is CommonJS, so it's loaded with import() on first use.
// Nothing ever runs unsandboxed: if the sandbox can't start, the runner isn't offered.

type Manager = (typeof import('@anthropic-ai/sandbox-runtime'))['SandboxManager']

/** The package domains `pip install` needs when PyPI is allowed. */
export const PYPI_HOSTS = ['pypi.org', 'files.pythonhosted.org']

/** How much output a run keeps (the model sees less: tool results are capped). */
const OUTPUT_BYTES = 256 * 1024

/**
 * Where user data lives outside the home folder: other accounts' homes and /Users/Shared, other disks and mounted
 * images, and the per-user and shared temp folders (caches, drafts, downloads in progress). Hidden like the home
 * folder (#68). macOS spells /tmp and /var as /private/tmp and /private/var.
 */
export const PRIVATE_ROOTS = ['/Users', '/Volumes', '/private/var/folders', '/private/tmp']

export interface PolicyInput {
  /** The chat's workspace: the only folder code can write to (and read inside the hidden folders). */
  workspace: string
  home: string
  /** Folders code may read inside the hidden folders: skills, Kiln's Python environment, tool folders on PATH. */
  readable: string[]
  /** Kiln's Python environment, writable only when packages may be installed. */
  venv: string
  pypi: boolean
}

/**
 * What code may touch. Reads: the system (libraries, Homebrew, Python), but in the home folder and PRIVATE_ROOTS only
 * the workspace and `readable`. Writes: the workspace (and the Python environment when PyPI is allowed). Network: none,
 * or PyPI's two hosts.
 */
export function policyFor(p: PolicyInput): SandboxRuntimeConfig {
  return {
    network: { allowedDomains: p.pypi ? PYPI_HOSTS : [], deniedDomains: [] },
    filesystem: {
      denyRead: [...new Set([p.home, ...PRIVATE_ROOTS])],
      allowRead: [p.workspace, ...p.readable, p.venv],
      allowWrite: p.pypi ? [p.workspace, p.venv] : [p.workspace],
      denyWrite: []
    }
  }
}

let manager: Promise<Manager> | null = null

async function load(): Promise<Manager> {
  const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
  if (!SandboxManager.isSupportedPlatform()) throw new Error("This Mac's sandbox isn't supported.")
  const deps = await SandboxManager.checkDependenciesAsync()
  if (deps.errors.length) throw new Error(deps.errors.join(' '))
  // Per-run settings (the workspace) are passed with each command; this starts the network proxy.
  await SandboxManager.initialize({
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] }
  })
  return SandboxManager
}

/** The sandbox, started once. Rejects (every time) when it can't run on this Mac. */
function sandbox(): Promise<Manager> {
  manager ??= load().catch((err) => {
    manager = null
    throw err
  })
  return manager
}

/** Whether code can be sandboxed here, and if not, why. */
export async function sandboxStatus(): Promise<{ ok: boolean; reason: string | null }> {
  try {
    await sandbox()
    return { ok: true, reason: null }
  } catch (err) {
    return { ok: false, reason: `The sandbox couldn't start: ${errorMessage(err)}` }
  }
}

export interface RunResult {
  code: number | null
  /** stdout and stderr as they arrived, with any sandbox denials explained at the end. */
  output: string
  timedOut: boolean
  /** Output past the limit was dropped. */
  truncated: boolean
}

/**
 * Run a shell command in the sandbox, in its own process group (so background jobs die with it). Stop (the signal)
 * kills it and rejects; running past `timeoutMs` kills it and says so.
 */
export async function runSandboxed(opts: {
  command: string
  policy: SandboxRuntimeConfig
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  signal?: AbortSignal
  /** Ties sandbox denials to this run. */
  id: string
}): Promise<RunResult> {
  const sb = await sandbox()
  opts.signal?.throwIfAborted()
  // The network proxy reads the allowlist per request from the global config; the filesystem rules go with the command.
  sb.updateConfig(opts.policy)
  const { argv, env } = await sb.wrapWithSandboxArgv(opts.command, '/bin/bash', opts.policy, opts.signal, opts.cwd, { commandId: opts.id })
  const proc = spawnGroup(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    env: { ...(await childEnv()), ...env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const chunks: Buffer[] = []
  let bytes = 0
  let truncated = false
  const collect = (chunk: Buffer) => {
    if (bytes >= OUTPUT_BYTES) return void (truncated = true)
    chunks.push(chunk)
    bytes += chunk.length
  }
  proc.child.stdout!.on('data', collect)
  proc.child.stderr!.on('data', collect)

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void proc.stop(1000)
  }, opts.timeoutMs)
  const onAbort = () => void proc.stop(500)
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      proc.child.once('error', reject)
      proc.child.once('close', (c) => resolve(c))
    })
    opts.signal?.throwIfAborted()
    const output = sb.annotateStderrWithSandboxFailures(opts.id, Buffer.concat(chunks).toString('utf8'))
    return { code, output, timedOut, truncated }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
    sb.cleanupAfterCommand()
  }
}
