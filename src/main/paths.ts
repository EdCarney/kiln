import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

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

export function initPaths(): void {
  paths.data = app.getPath('userData')
  paths.db = join(paths.data, 'kiln.db')
  paths.files = join(paths.data, 'files')
  paths.skills = join(paths.data, 'skills')
  paths.workspaces = join(paths.data, 'workspaces')
  paths.runner = join(paths.data, 'runner')
  for (const dir of [paths.files, paths.skills]) mkdirSync(dir, { recursive: true })
}
