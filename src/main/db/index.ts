import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS } from './migrations'

let db: DatabaseSync | null = null

export function openDatabase(file: string): DatabaseSync {
  db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
  migrate(db)
  return db
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not opened')
  return db
}

function migrate(d: DatabaseSync): void {
  const current = (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(() => {
      d.exec(MIGRATIONS[v])
      d.exec(`PRAGMA user_version = ${v + 1}`)
    }, d)
  }
}

let depth = 0

/**
 * Run `fn` atomically. A call inside another transaction joins it, so helpers can use this whether or not
 * their caller already opened one. `fn` must be synchronous.
 */
export function transaction<T>(fn: () => T, d: DatabaseSync = getDb()): T {
  if (depth > 0) return fn()
  d.exec('BEGIN')
  depth++
  try {
    const result = fn()
    d.exec('COMMIT')
    return result
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  } finally {
    depth--
  }
}

type Param = string | number | bigint | null | Uint8Array

export function all<T>(sql: string, ...params: Param[]): T[] {
  return getDb()
    .prepare(sql)
    .all(...params) as T[]
}

export function get<T>(sql: string, ...params: Param[]): T | undefined {
  return getDb()
    .prepare(sql)
    .get(...params) as T | undefined
}

export function run(sql: string, ...params: Param[]): void {
  getDb()
    .prepare(sql)
    .run(...params)
}
