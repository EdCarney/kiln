import type { ModelOverrides, ThemeDef } from '@shared/types'
import { now, parseJson } from '../util'
import { all, get, run } from './index'

// ---- Settings (key/value) -----------------------------------------------

export function readSetting<T>(key: string, fallback: T): T {
  return parseJson(get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value, fallback)
}

export function writeSetting(key: string, value: unknown): void {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value))
}

export function deleteSetting(key: string): void {
  run('DELETE FROM settings WHERE key = ?', key)
}

// ---- Model profile cache ------------------------------------------------

export interface CachedModelInfo {
  capabilities: string[]
  contextLength: number | null
  family: string | null
  parameterSize: string | null
}

export function readModelProfile(model: string): { info: CachedModelInfo | null; fetchedAt: number; overrides: ModelOverrides } {
  const row = get<{ info: string | null; fetched_at: number | null; overrides: string }>(
    'SELECT info, fetched_at, overrides FROM model_profiles WHERE model = ?',
    model
  )
  return {
    info: parseJson<CachedModelInfo | null>(row?.info, null),
    fetchedAt: row?.fetched_at ?? 0,
    overrides: parseJson<ModelOverrides>(row?.overrides, {})
  }
}

export function writeModelInfo(model: string, info: CachedModelInfo): void {
  run(
    `INSERT INTO model_profiles (model, info, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(model) DO UPDATE SET info = excluded.info, fetched_at = excluded.fetched_at`,
    model,
    JSON.stringify(info),
    Date.now()
  )
}

export function writeModelOverrides(model: string, overrides: ModelOverrides): void {
  run(
    `INSERT INTO model_profiles (model, overrides) VALUES (?, ?)
     ON CONFLICT(model) DO UPDATE SET overrides = excluded.overrides`,
    model,
    JSON.stringify(overrides)
  )
}

// ---- Custom themes ------------------------------------------------------

export function listCustomThemes(): ThemeDef[] {
  return all<{ def: string }>('SELECT def FROM themes ORDER BY created_at')
    .map((r) => parseJson<ThemeDef | null>(r.def, null))
    .filter((t): t is ThemeDef => !!t)
}

export function saveCustomTheme(theme: ThemeDef): void {
  run(
    `INSERT INTO themes (id, def, created_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET def = excluded.def`,
    theme.id,
    JSON.stringify({ ...theme, builtin: false }),
    now()
  )
}

export function deleteCustomTheme(id: string): void {
  run('DELETE FROM themes WHERE id = ?', id)
}
