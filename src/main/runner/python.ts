import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { childEnv } from '../env'
import { paths } from '../paths'

// Code runs with Kiln's own Python environments (venvs made from the Python 3 on the user's PATH), so packages the
// model installs never touch the user's Python. A chat that may install packages (PyPI allowed) gets an environment of
// its own, writable only by its runs: a shared writable one would let one chat's code plant code (a sitecustomize.py,
// a .pth file, a patched package) that runs in every other chat (#69). Other chats share one without pip that no run
// can write.

const run = promisify(execFile)

/** The shared environment: no packages, never writable by code. */
export const baseVenvDir = (): string => join(paths.runner, 'base-venv')
/** Each chat's own environment, by chat id: outside its workspace, where code can't swap a folder above it for a link. */
export const chatVenvsDir = (): string => join(paths.runner, 'venvs')
export const chatVenvDir = (conversationId: string): string => join(chatVenvsDir(), conversationId)
export const venvPython = (venv: string): string => join(venv, 'bin', 'python')
/** The environment all chats shared before #69, which code could write with PyPI allowed. Deleted, never used. */
const legacyVenvDir = (): string => join(paths.runner, 'venv')

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

/**
 * The shared environment, made on first use (outside the sandbox: no code can write here). Returns its folder. The
 * old shared environment is deleted first, since code may have planted something in it.
 */
export async function ensureBaseVenv(): Promise<string> {
  if (existsSync(venvPython(baseVenvDir()))) return baseVenvDir()
  await rm(legacyVenvDir(), { recursive: true, force: true })
  const python = await findPython()
  if (!python) throw new Error('Python 3 was not found on your PATH.')
  await run(python.path, ['-m', 'venv', '--without-pip', baseVenvDir()], { env: await childEnv(), timeout: 120_000 })
  return baseVenvDir()
}

/** Delete every Kiln Python environment (and every package installed in them). The next run makes a fresh one. */
export async function resetVenv(): Promise<void> {
  // fs.rm removes links without following them, so a link code left in a chat's environment is only unlinked.
  await Promise.all([chatVenvsDir(), baseVenvDir(), legacyVenvDir()].map((dir) => rm(dir, { recursive: true, force: true })))
}

/** Delete a chat's own environment, with the chat. */
export async function removeChatVenv(conversationId: string): Promise<void> {
  if (!/^[\w-]+$/.test(conversationId)) return
  await rm(chatVenvDir(conversationId), { recursive: true, force: true })
}

/** Whether any Kiln environment exists yet. */
export function venvsExist(): boolean {
  if (existsSync(venvPython(baseVenvDir()))) return true
  try {
    return readdirSync(chatVenvsDir()).length > 0
  } catch {
    return false
  }
}

/**
 * Packages installed in the chats' environments (each once, by name and version), read from the *.dist-info folder
 * names. Nothing in a chat's environment is ever run outside the sandbox: that chat's code can write there.
 */
export async function installedPackages(): Promise<Array<{ name: string; version: string }>> {
  const found = new Map<string, { name: string; version: string }>()
  for (const chat of await readdir(chatVenvsDir()).catch(() => [])) {
    const lib = join(chatVenvsDir(), chat, 'lib')
    for (const py of await readdir(lib).catch(() => [])) {
      for (const entry of await readdir(join(lib, py, 'site-packages')).catch(() => [])) {
        const m = entry.match(/^(.+?)-([^-]+)\.dist-info$/)
        if (m) found.set(`${m[1]} ${m[2]}`, { name: m[1], version: m[2] })
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}
