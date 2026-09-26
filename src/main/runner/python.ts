import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { childEnv } from '../env'
import { paths } from '../paths'

// Code runs with Kiln's own Python environment (a venv made from the Python 3 on the user's PATH), so packages the
// model installs never touch the user's Python, and resetting it is just deleting a folder.

const run = promisify(execFile)

export const venvDir = (): string => join(paths.runner, 'venv')
export const venvPython = (): string => join(venvDir(), 'bin', 'python')

export interface PythonInfo {
  path: string
  version: string
}

let found: Promise<PythonInfo | null> | null = null

async function locate(): Promise<PythonInfo | null> {
  const env = await childEnv()
  let path: string
  try {
    path = (await run('/usr/bin/which', ['python3'], { env })).stdout.trim()
  } catch {
    return null
  }
  // Without the Command Line Tools, macOS's /usr/bin/python3 is a stub that opens an install dialog.
  if (path === '/usr/bin/python3') {
    try {
      await run('/usr/bin/xcode-select', ['-p'])
    } catch {
      return null
    }
  }
  try {
    const out = await run(path, ['-c', 'import sys; print(sys.version.split()[0])'], { env, timeout: 10_000 })
    return { path, version: out.stdout.trim() }
  } catch {
    return null
  }
}

/** The Python 3 on the user's PATH (looked up once), or null. */
export function findPython(): Promise<PythonInfo | null> {
  found ??= locate()
  return found
}

/** Kiln's Python environment, made on first use. Returns its python. */
export async function ensureVenv(): Promise<string> {
  if (existsSync(venvPython())) return venvPython()
  const python = await findPython()
  if (!python) throw new Error('Python 3 was not found on your PATH.')
  await run(python.path, ['-m', 'venv', venvDir()], { env: await childEnv(), timeout: 120_000 })
  return venvPython()
}

/** Delete Kiln's Python environment (and every package installed into it). The next run makes a fresh one. */
export async function resetVenv(): Promise<void> {
  await rm(venvDir(), { recursive: true, force: true })
}

/**
 * Packages in Kiln's Python environment, read from the *.dist-info folder names. Nothing in the environment is ever
 * run outside the sandbox: with PyPI allowed, sandboxed code can write there (a sitecustomize.py would run in any
 * Python started from it).
 */
export async function installedPackages(): Promise<Array<{ name: string; version: string }>> {
  const lib = join(venvDir(), 'lib')
  const found: Array<{ name: string; version: string }> = []
  for (const py of await readdir(lib).catch(() => [])) {
    for (const entry of await readdir(join(lib, py, 'site-packages')).catch(() => [])) {
      const m = entry.match(/^(.+?)-([^-]+)\.dist-info$/)
      if (m) found.push({ name: m[1], version: m[2] })
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}
