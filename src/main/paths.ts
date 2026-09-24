import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export const paths = {
  data: '',
  db: '',
  files: '',
  skills: ''
}

export function initPaths(): void {
  paths.data = app.getPath('userData')
  paths.db = join(paths.data, 'kiln.db')
  paths.files = join(paths.data, 'files')
  paths.skills = join(paths.data, 'skills')
  for (const dir of [paths.files, paths.skills]) mkdirSync(dir, { recursive: true })
}
