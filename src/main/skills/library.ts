import { existsSync, type FSWatcher, watch } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { shell } from 'electron'
import YAML from 'yaml'
import type { SkillInput } from '@shared/ipc'
import type { Skill, SkillDetail, SkillSource } from '@shared/types'
import { paths } from '../paths'
import { getSettings, updateSettings } from '../settings'

interface Root {
  source: SkillSource
  dir: string
  readOnly: boolean
}

const SOURCE_PRIORITY: SkillSource[] = ['app', 'ollama', 'claude']
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

function roots(): Root[] {
  const s = getSettings().skills.sources
  const list: Root[] = [{ source: 'app', dir: paths.skills, readOnly: false }]
  if (s.ollama) list.push({ source: 'ollama', dir: join(homedir(), '.ollama', 'skills'), readOnly: true })
  if (s.claude) list.push({ source: 'claude', dir: join(homedir(), '.claude', 'skills'), readOnly: true })
  return list.filter((r) => existsSync(r.dir))
}

export function parseSkillMarkdown(raw: string): { name?: string; description?: string; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { body: raw.trim() }
  let meta: Record<string, unknown> = {}
  try {
    meta = (YAML.parse(m[1]) as Record<string, unknown>) ?? {}
  } catch {
    /* malformed frontmatter: treat as body-only */
  }
  return {
    name: typeof meta.name === 'string' ? meta.name.trim() : undefined,
    description: typeof meta.description === 'string' ? meta.description.trim() : undefined,
    body: raw.slice(m[0].length).trim()
  }
}

export function serializeSkill(name: string, description: string, body: string): string {
  return `---\n${YAML.stringify({ name, description }, { lineWidth: 0 }).trim()}\n---\n\n${body.trim()}\n`
}

async function findSkillDirs(dir: string, depth: number): Promise<string[]> {
  if (existsSync(join(dir, 'SKILL.md'))) return [dir]
  if (depth === 0) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const nested = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => findSkillDirs(join(dir, e.name), depth - 1))
  )
  return nested.flat()
}

async function listFiles(dir: string, base = dir, depth = 3): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === '__pycache__' || e.name === 'node_modules') continue
    const full = join(dir, e.name)
    if (e.isDirectory() && depth > 0) out.push(...(await listFiles(full, base, depth - 1)))
    else if (e.isFile() && !(dir === base && e.name === 'SKILL.md')) out.push(relative(base, full))
    if (out.length > 200) break
  }
  return out
}

let cache: Skill[] | null = null

export async function listSkills(): Promise<Skill[]> {
  if (cache) return cache
  const { disabled, enabledImports } = getSettings().skills
  const off = new Set(disabled)
  const optedIn = new Set(enabledImports)
  const skills: Skill[] = []
  const ids = new Set<string>()
  for (const root of roots()) {
    for (const dir of await findSkillDirs(root.dir, 3)) {
      if (dir === root.dir) continue
      const raw = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => null)
      if (raw == null) continue
      const meta = parseSkillMarkdown(raw)
      const name = meta.name || dir.split(sep).pop()!
      let id = `${root.source}:${name}`
      for (let n = 2; ids.has(id); n++) id = `${root.source}:${name}#${n}`
      ids.add(id)
      const files = await listFiles(dir)
      skills.push({
        id,
        name,
        description: meta.description ?? '',
        source: root.source,
        dir,
        readOnly: root.readOnly,
        hasScripts: files.some((f) => f.startsWith(`scripts${sep}`)),
        enabled: root.source === 'claude' ? optedIn.has(id) : !off.has(id),
        files
      })
    }
  }
  skills.sort(
    (a, b) => SOURCE_PRIORITY.indexOf(a.source) - SOURCE_PRIORITY.indexOf(b.source) || a.name.localeCompare(b.name)
  )
  cache = skills
  return skills
}

export function invalidateSkills(): void {
  cache = null
}

export async function getSkill(id: string): Promise<SkillDetail | null> {
  const skill = (await listSkills()).find((s) => s.id === id)
  if (!skill) return null
  const raw = await readFile(join(skill.dir, 'SKILL.md'), 'utf8')
  return { ...skill, body: parseSkillMarkdown(raw).body }
}

/** Enabled skill by name, preferring the app's own copy over imported ones. */
export async function findSkillByName(name: string): Promise<Skill | null> {
  const wanted = name.trim().toLowerCase()
  return (await listSkills()).find((s) => s.enabled && s.name.toLowerCase() === wanted) ?? null
}

export async function readSkillFile(skill: Skill, relPath: string): Promise<string> {
  const full = resolve(skill.dir, relPath)
  if (!full.startsWith(skill.dir + sep)) throw new Error('Path is outside the skill folder')
  const info = await stat(full)
  if (info.size > 200_000) throw new Error('File is too large to load')
  return readFile(full, 'utf8')
}

export async function saveSkill(input: SkillInput): Promise<Skill> {
  const name = input.name.trim()
  if (!SKILL_NAME_RE.test(name) || name.length > 64)
    throw new Error('Skill names use lowercase letters, numbers and single hyphens (max 64 characters).')
  if (!input.description.trim()) throw new Error('Add a description: it tells the model when to use the skill.')

  const existing = input.id ? (await listSkills()).find((s) => s.id === input.id) : undefined
  if (existing?.readOnly) throw new Error('Imported skills are read-only. Duplicate it to edit.')
  const target = join(paths.skills, name)
  if (existing && existing.dir !== target) {
    if (existsSync(target)) throw new Error(`A skill named “${name}” already exists.`)
    await rename(existing.dir, target)
  } else if (!existing) {
    if (existsSync(target)) throw new Error(`A skill named “${name}” already exists.`)
    await mkdir(target, { recursive: true })
  }
  await writeFile(join(target, 'SKILL.md'), serializeSkill(name, input.description, input.body))
  invalidateSkills()
  return (await listSkills()).find((s) => s.dir === target)!
}

export async function deleteSkill(id: string): Promise<void> {
  const skill = (await listSkills()).find((s) => s.id === id)
  if (!skill) return
  if (skill.readOnly) throw new Error('Imported skills are managed by their own app.')
  await shell.trashItem(skill.dir)
  invalidateSkills()
}

export async function duplicateSkill(id: string): Promise<Skill> {
  const skill = (await listSkills()).find((s) => s.id === id)
  if (!skill) throw new Error('Skill not found')
  let name = skill.name
  for (let n = 2; existsSync(join(paths.skills, name)); n++) name = `${skill.name}-${n}`
  const target = join(paths.skills, name)
  await cp(skill.dir, target, { recursive: true })
  if (name !== skill.name) {
    const raw = await readFile(join(target, 'SKILL.md'), 'utf8')
    const meta = parseSkillMarkdown(raw)
    await writeFile(join(target, 'SKILL.md'), serializeSkill(name, meta.description ?? '', meta.body))
  }
  invalidateSkills()
  return (await listSkills()).find((s) => s.dir === target)!
}

export function setSkillEnabled(id: string, enabled: boolean): void {
  const { disabled, enabledImports } = getSettings().skills
  const toggle = (list: string[], add: boolean) => (add ? [...new Set([...list, id])] : list.filter((x) => x !== id))
  if (id.startsWith('claude:')) updateSettings({ skills: { enabledImports: toggle(enabledImports, enabled) } })
  else updateSettings({ skills: { disabled: toggle(disabled, !enabled) } })
  invalidateSkills()
}

export async function revealSkill(id: string | null): Promise<void> {
  const skill = id ? (await listSkills()).find((s) => s.id === id) : null
  if (skill) shell.showItemInFolder(join(skill.dir, 'SKILL.md'))
  else await shell.openPath(paths.skills)
}

let watchers: FSWatcher[] = []
let debounce: NodeJS.Timeout | null = null

/** Watch every skill root; call again after the enabled sources change. */
export function watchSkills(onChange: () => void): void {
  for (const w of watchers) w.close()
  watchers = []
  for (const root of roots()) {
    try {
      watchers.push(
        watch(root.dir, { recursive: true }, () => {
          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(() => {
            invalidateSkills()
            onChange()
          }, 300)
        })
      )
    } catch {
      /* unwatchable directory; manual refresh still works */
    }
  }
}
