import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import type { ToolEvent } from '@shared/types'
import { childPath } from '../env'
import type { OllamaTool } from '../ollama/client'
import { getSettings } from '../settings'
import { listSkills } from '../skills/library'
import type { ToolProvider, ToolResult } from '../chat/tools'
import { capText } from '../chat/results'
import { chatVenvDir, ensureBaseVenv, findPython, venvPython } from './python'
import { policyFor, PRIVATE_ROOTS, runSandboxed } from './sandbox'
import { changedFiles, KILN_DIR, snapshot } from './workspace'

// run_code: Python or bash in the chat's workspace, under the sandbox. Each call is a fresh process; files persist.

/** The tool source for the code runner in Conversation.toolSources. */
export const CODE_SOURCE = 'code'
const OUTPUT_CHARS = 20_000
const RECORD_CHARS = 500

export const RUN_CODE: OllamaTool = {
  type: 'function',
  function: {
    name: 'run_code',
    description:
      "Run Python 3 or bash in a sandbox on the user's Mac, in this chat's working folder. Returns the exit code and output (stdout and stderr), and lists files the code created or changed. Each call is a new process: variables don't carry over, files do.",
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['python', 'bash'], description: 'python (the default) or bash' },
        code: { type: 'string', description: 'The whole program or script to run' }
      },
      required: ['code']
    }
  }
}

/** Whether this reply may run code: the chat switched the runner on and a workspace was prepared for it. */
const enabled = (ctx: { sources: readonly string[]; workspace: string | null }) =>
  ctx.sources.includes(CODE_SOURCE) && !!ctx.workspace && getSettings().runner.mode !== 'off'

type Language = 'python' | 'bash'

/** The code and language of a call (gpt-oss's built-in python tool sends its code under other names). */
function readCall(args: Record<string, unknown>, via: string | null): { language: Language; code: string } {
  const code = [args.code, args.input, args.script, args.source].find((v) => typeof v === 'string') as string | undefined
  const language: Language = via === 'python' || args.language !== 'bash' ? 'python' : 'bash'
  return { language, code: code ?? '' }
}

const firstLine = (code: string) =>
  code
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'))
    ?.slice(0, 120) ?? ''

let runs = 0

/**
 * Folders code may read inside the hidden ones (see policyFor): skills and tool folders on PATH. Not Kiln's runner
 * folder: a run reads only the Python environment it uses, never another chat's.
 */
async function readableFolders(): Promise<string[]> {
  const hidden = [homedir(), ...PRIVATE_ROOTS]
  const skills = [...new Set((await listSkills()).map((s) => s.dir))]
  const onPath = (await childPath()).split(delimiter).filter((d) => hidden.some((h) => d.startsWith(h + '/')))
  return [...skills, ...onPath]
}

/**
 * The Python environment a run uses: the chat's own when it may install packages or already has one; otherwise the
 * shared one, which no run can write (#69). A chat's own is made inside the sandbox: its earlier runs could have left
 * links in it that Kiln, writing outside the sandbox, would follow.
 */
async function environmentFor(
  workspace: string,
  pypi: boolean,
  sandbox: (venv: string) => ReturnType<typeof policyFor>,
  env: Record<string, string>,
  signal?: AbortSignal
): Promise<{ venv: string } | { error: string }> {
  const own = chatVenvDir(basename(workspace))
  if (existsSync(venvPython(own))) return { venv: own }
  if (!pypi) return { venv: await ensureBaseVenv() }
  const python = await findPython()
  if (!python) return { error: 'Python 3 was not found on your PATH.' }
  await mkdir(own, { recursive: true })
  const made = await runSandboxed({
    command: `"${python.path}" -m venv "${own}"`,
    policy: sandbox(own),
    cwd: workspace,
    env,
    timeoutMs: 120_000,
    signal,
    id: `venv:${basename(workspace)}`
  })
  return made.code === 0 && existsSync(venvPython(own))
    ? { venv: own }
    : { error: `Couldn't make this chat's Python environment: ${made.output.trim().slice(-2000) || `exit code ${made.code}`}` }
}

async function run(language: Language, code: string, workspace: string, signal?: AbortSignal): Promise<ToolResult> {
  const settings = getSettings().runner
  const args = { language, code }
  const summary = firstLine(code)
  if (!code.trim())
    return { content: 'Error: run_code needs the code to run.', event: { tool: 'run_code', args, ok: false, summary: 'no code' } }

  const n = ++runs
  const script = join(KILN_DIR, `run-${n}.${language === 'python' ? 'py' : 'sh'}`)
  await mkdir(join(workspace, KILN_DIR), { recursive: true })
  await writeFile(join(workspace, script), code)

  // Tools that keep caches or config in HOME or TMPDIR find a writable one inside the workspace.
  const baseEnv = {
    HOME: join(workspace, KILN_DIR, 'home'),
    TMPDIR: join(workspace, KILN_DIR, 'tmp'),
    PIP_CACHE_DIR: join(workspace, KILN_DIR, 'tmp', 'pip'),
    MPLBACKEND: 'Agg',
    PYTHONUNBUFFERED: '1'
  }
  const readable = await readableFolders()
  const sandbox = (venv: string) => policyFor({ workspace, home: homedir(), readable, venv, pypi: settings.pypi })
  const environment = await environmentFor(workspace, settings.pypi, sandbox, baseEnv, signal)
  if ('error' in environment)
    return { content: `Error: ${environment.error}`, event: { tool: 'run_code', args, ok: false, summary: 'no Python environment' } }
  const { venv } = environment

  const before = await snapshot(workspace)
  const result = await runSandboxed({
    command: language === 'python' ? `"${venvPython(venv)}" ${script}` : `/bin/bash ${script}`,
    policy: sandbox(venv),
    cwd: workspace,
    // Kiln's environment comes first on PATH for bash too, so `python` and `pip` work there (Homebrew has only python3).
    env: { ...baseEnv, VIRTUAL_ENV: venv, PATH: `${join(venv, 'bin')}${delimiter}${await childPath()}` },
    timeoutMs: settings.timeoutSec * 1000,
    signal,
    id: `run_code:${n}`
  })
  const files = changedFiles(before, await snapshot(workspace))

  const status = result.timedOut
    ? `Stopped after ${settings.timeoutSec} seconds (the time limit).`
    : `Exit code ${result.code ?? 'none (killed)'}.`
  const output = result.output.trim() ? capText(result.output, OUTPUT_CHARS) : '(no output)'
  const listed = files.length ? `\n\nFiles created or changed:\n${files.map((f) => `- ${f.path} (${f.size} bytes)`).join('\n')}` : ''
  const content = `${status}${result.truncated ? ' (output was cut short)' : ''}\n\n${output}${listed}`
  const ok = !result.timedOut && result.code === 0
  const event: ToolEvent = {
    tool: 'run_code',
    args,
    ok,
    summary: ok ? summary : result.timedOut ? 'timed out' : `exit code ${result.code ?? '?'}`,
    files,
    record: `${status} ${result.output.trim().slice(0, RECORD_CHARS)}${files.length ? ` Files: ${files.map((f) => f.path).join(', ')}` : ''}`
  }
  return { content, event }
}

export const runnerTools: ToolProvider = {
  id: 'runner',
  tools: (ctx) => (enabled(ctx) ? [RUN_CODE] : []),
  grants: ['code'],
  hint: 'Use run_code to run Python or bash.',
  // gpt-oss is trained with a built-in `python` tool and calls it by that name.
  alias: (name) => (name === 'python' ? 'run_code' : null),
  pending: ({ args, via }) => {
    const { language, code } = readCall(args, via)
    return { tool: 'run_code', args: { language, code }, ok: true, pending: true, summary: firstLine(code) }
  },
  run: async ({ args, via }, ctx) => {
    const { language, code } = readCall(args, via)
    return run(language, code, ctx.workspace!, ctx.signal)
  },
  approval: () => (getSettings().runner.mode === 'allow' ? 'auto' : 'ask'),
  endpoint: ({ args, via }) => `kiln://runner/${readCall(args, via).language}`,
  // Later turns keep what a run printed and wrote, briefly.
  replay: (e) =>
    e.tool === 'run_code' && e.record
      ? {
          name: 'run_code',
          args: { ...e.args, code: capText(String(e.args.code ?? ''), 2_000) },
          record: e.record,
          note: 'Kept in brief from an earlier turn; the files are still in the working folder.'
        }
      : null
}
