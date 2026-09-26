import { mkdirSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

export const paths = {
  data: '',
  db: '',
  files: '',
  skills: '',
  /** Each chat's folder for code runs: <workspaces>/<conversation id>. */
  workspaces: '',
  /** The code runner's own files (its Python environment). */
  runner: ''
}

/** Whether `id` is a plain id (letters, digits, `_`, `-`): safe as one folder name under Kiln's own folders. */
export const isPlainId = (id: string): boolean => /^[\w-]+$/.test(id)

export function initPaths(dataDir: string): void {
  paths.data = dataDir
  paths.db = join(paths.data, 'kiln.db')
  paths.files = join(paths.data, 'files')
  paths.skills = join(paths.data, 'skills')
  paths.workspaces = join(paths.data, 'workspaces')
  paths.runner = join(paths.data, 'runner')
  for (const dir of [paths.files, paths.skills]) mkdirSync(dir, { recursive: true })
}

/**
 * A file in the data folder as the database stores it: relative to the folder, so the folder can move without the
 * database being rewritten (#60). Every stored file is in files/, so a path anywhere else is a mistake.
 */
export function toStored(path: string): string {
  const rel = relative(paths.data, path)
  if (!paths.data || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`Not a file in the data folder: ${path}`)
  return rel
}

/** A path from the database (see toStored) as a path on disk. */
export const fromStored = (stored: string): string => join(paths.data, stored)
