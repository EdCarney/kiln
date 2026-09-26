# Rename Kiln to Ollmost (#60): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the app from Kiln to Ollmost everywhere, and move an existing Kiln install's data over on Ollmost's first launch.

**Architecture:**
- **The migration** is a new module, `src/main/migrate.ts`, in two phases:
  - Phase 1 moves the data folder, synchronously, at the top of `src/main/index.ts`, before Chromium can create the new one.
  - Phase 2 renames the database, clears secrets encrypted with the old keychain entry, and tidies the runner folders once the folder is in place.
- **Stored file paths** become relative to the data folder.
- **MCP servers whose values can't be decrypted** are "locked" and never start.
- **The mechanical rename** runs only after all of this exists, so no build ever runs under the new name without the migration.

**Tech Stack:** Electron 44, TypeScript, React, `node:sqlite`, vitest, Playwright's `_electron` (e2e), bash (`install.sh`).

**Spec:** `docs/superpowers/specs/2026-09-26-ollmost-rename-design.md`. Read it first: this plan argues from it.

## Global Constraints

- **macOS only.** Paths are `~/Library/Application Support/<name>`.
- **Name mapping** (spec, Part A):
  - `Kiln` → `Ollmost`, `kiln` → `ollmost`, `KILN` → `OLLMOST`, `KilnApi` → `OllmostApi`, CSS variables `--k-*` → `--o-*`.
  - Bundle id `local.kiln.app` → `local.ollmost.app`. Database `kiln.db` → `ollmost.db`. Workspace folder `.kiln` → `.ollmost`.
  - Repo `EdCarney/kiln` → `EdCarney/ollmost`.
- **The old name may appear only in:**
  - `src/main/migrate.ts`, `src/shared/migration.ts`, `src/main/db/migrations.ts` (in one SQL string), `tests/migrate.test.ts`
  - after Task 8: the e2e "coming from Kiln" section
  - after Task 9: the installers' Kiln cleanup and the README's "Coming from Kiln" note
  - `docs/`
- **In files the rename touches, never write "Kiln" to mean the old app.** The rename (Task 7) rewrites every "Kiln" in those files. New code in those files writes "Kiln" only where it means *this* app, which becomes "Ollmost" after Task 7.
- **No fallbacks:** the `KILN_*` environment variables are not read after the rename.
- **Code style:** Prettier (no semicolons, single quotes, `printWidth` 140). Comments explain *why*, in plain sentences, as the surrounding code does.
- **Don't run `npm run install:mac` before Task 10.** Task 2's SQL migration and Task 7's rename rewrite the real data on this Mac, and Task 10 backs it up first.
- **Every commit ends with the line** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push or open a PR without the user's go-ahead.
- **Test commands:**
  - `npm test` (vitest), `npm run typecheck`, `npm run lint`, `npm run format:check`
  - e2e: `npm run build && npm run e2e`. It needs the Ollama app running; the migration section uses a mock model.

## Review Focus

1. **Kiln crashed earlier.** Its `SingletonLock` names a dead pid, or a pid now used by another program. Ollmost should move the folder, not wait forever. (Task 4 tests both.)
2. **Kiln quit uncleanly** and left transactions only in `kiln.db-wal`. None may be lost when the database is renamed. (Task 5 test.)
3. **Code replaced a workspace's `.kiln` folder with a link** to somewhere outside. The migration must move the link and never touch its target. (Task 5 test.)
4. **The user edits a locked MCP server without re-entering its values**, for example switching "Use in new chats". The missing variables must stay listed and the server stay locked, never silently dropped or started without them. (Task 3 test.)
5. **Ollmost is launched while Kiln is still running, or after a failed move.** That session must not create the new data folder, or the move would be skipped for good. (Task 4 tests that nothing is created; Task 6 routes both states to a throwaway folder.)

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/main/migrate.ts` (new) | Everything about moving from Kiln. Phase 1: `moveKilnData`, `kilnPid`, `oldDataFolder`, `waitForKiln` and the dialog text. Phase 2: `migrationPending`, `renameDatabase`, `finishMigration`, `migrationNotice`, `dismissMigrationNotice`. Excluded from the rename. |
| `src/shared/migration.ts` (new) | The notice's copy, and the `MigrationNoticeView` type the renderer gets. Excluded from the rename. |
| `src/main/paths.ts` | `initPaths(dataDir)` (no Electron import any more), plus `toStored` and `fromStored`. |
| `src/main/db/conversations.ts`, `src/main/db/projects.ts` | Store relative paths and hand out absolute ones. |
| `src/main/db/migrations.ts` | Two new SQL entries: relative paths, and trace labels. |
| `src/main/mcp/config.ts`, `src/main/mcp/manager.ts`, `src/shared/types.ts` | Locked servers: `missingEnv`, and `forgetEnvValues`. |
| `src/renderer/src/views/ToolsSettings.tsx` | Shows a locked server and asks for its values. |
| `src/main/index.ts` | Calls both migration phases at the right moments. |
| `src/shared/ipc.ts`, `src/main/ipc.ts` | `app.migrationNotice` and `app.dismissMigrationNotice`. |
| `src/renderer/src/components/MigrationNotice.tsx` (new), `src/renderer/src/views/HomeView.tsx` | The one-time notice. |
| `tests/migrate.test.ts` (new), `tests/storedPaths.test.ts` (new), `tests/mcp.test.ts`, `tests/runner.test.ts`, `tests/exposure.test.ts`, `tests/service.test.ts` | Tests. |
| Every file with "kiln" in it | The mechanical rename (Task 7). |
| `e2e/run.mjs` | The "coming from Kiln" scenario (Task 8). |
| `scripts/install.sh`, `scripts/install-mac.mjs`, `README.md`, `package.json` | Distribution (Task 9). |

---

### Task 1: Confirm code Kiln left running can't write a moved folder

This is the gate for spec B7. If this test fails, **stop and report to the user.** The migration would then have to stop Kiln's leftover processes before moving the folder, which changes the design.

**Files:**
- Test: `tests/runner.test.ts`, inside `describe.runIf(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))('running code in the sandbox', …)`

**Interfaces:**
- Consumes: `policyFor(p: PolicyInput)` and `runSandboxed(opts)` from `src/main/runner/sandbox.ts`, both already imported in this file.
- Produces: nothing.

- [ ] **Step 1: Write the test.** Add it at the end of that `describe` block, before its closing `})`:

```ts
  // #60: moving the data folder must cut off code an earlier session left running there. Its policy names the old
  // path, and Seatbelt checks the path an access resolves to at the time, even through the working directory.
  it('stops code writing a workspace once the folder above it is renamed', async () => {
    const before = realpathSync(mkdtempSync(join(tmpdir(), 'kiln-move-a-')))
    const after = `${before}-moved`
    const workspace = join(before, 'workspaces', 'c1')
    mkdirSync(workspace, { recursive: true })
    const policy = policyFor({ workspace, home: fakeHome, readable: [], venv: join(root, 'venv'), pypi: false })
    const run = runSandboxed({
      command: 'echo ok > first.txt; sleep 2; echo x > second.txt; echo "exit=$?"',
      policy,
      cwd: workspace,
      env: {},
      timeoutMs: 30_000,
      id: 'moved-folder'
    })
    // Rename once the first write has happened, while the code sleeps.
    const t0 = Date.now()
    while (!existsSync(join(workspace, 'first.txt')) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50))
    renameSync(before, after)
    const result = await run
    expect(existsSync(join(after, 'workspaces', 'c1', 'first.txt'))).toBe(true)
    expect(existsSync(join(after, 'workspaces', 'c1', 'second.txt'))).toBe(false)
    expect(result.output).toMatch(/Operation not permitted/)
  })
```

If `renameSync` isn't imported yet, add it to the file's existing `node:fs` import.

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/runner.test.ts -t "folder above it is renamed"`
Expected: PASS. The write after the rename is denied.
If it FAILS because `second.txt` exists, **stop and report**: B7's assumption doesn't hold.

- [ ] **Step 3: Commit**

```bash
git add tests/runner.test.ts
git commit -m "Test that code left running can't write its folder once the data folder moves (#60)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Store file paths relative to the data folder

**Files:**
- Modify: `src/main/paths.ts`, `src/main/index.ts:133` (the `initPaths()` call), `src/main/db/conversations.ts`, `src/main/db/projects.ts`, `src/main/db/migrations.ts` (append an entry)
- Create: `tests/storedPaths.test.ts`
- Modify tests that store made-up paths: `tests/exposure.test.ts`, `tests/service.test.ts`, `tests/runner.test.ts`

**Interfaces:**
- Produces:
  - `initPaths(dataDir: string): void`
  - `toStored(path: string): string`: relative to `paths.data`. Throws `Error` with a message containing "data folder" for a path outside it.
  - `fromStored(stored: string): string`
  - A new last entry in `MIGRATIONS` whose SQL contains the comment `-- File paths relative to the data folder`.

- [ ] **Step 1: Write the failing test.** Create `tests/storedPaths.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import { getDb, openDatabase } from '../src/main/db/index'
import { MIGRATIONS } from '../src/main/db/migrations'
import * as conversations from '../src/main/db/conversations'
import * as projects from '../src/main/db/projects'
import { paths, toStored } from '../src/main/paths'

const data = mkdtempSync(join(tmpdir(), 'kiln-paths-'))
beforeAll(() => {
  paths.data = data
  openDatabase(':memory:')
})

const storedPath = (table: string, id: string) =>
  (getDb().prepare(`SELECT path FROM ${table} WHERE id = ?`).get(id) as { path: string }).path
const attach = (id: string, path: string) =>
  conversations.insertAttachment({ id, kind: 'image', name: `${id}.png`, mime: 'image/png', size: 1, path, text: null, token_est: 0 })

describe('stored file paths', () => {
  it('are kept relative to the data folder and handed out absolute', () => {
    const file = join(data, 'files', 'a1.png')
    attach('a1', file)
    expect(storedPath('attachments', 'a1')).toBe('files/a1.png')
    expect(conversations.getAttachmentRow('a1')?.path).toBe(file)
    expect(conversations.deletePendingAttachment('a1')).toBe(file)
  })

  it('follow the data folder when it moves', () => {
    attach('a2', join(data, 'files', 'a2.png'))
    const moved = mkdtempSync(join(tmpdir(), 'kiln-moved-'))
    paths.data = moved
    try {
      expect(conversations.getAttachmentRow('a2')?.path).toBe(join(moved, 'files', 'a2.png'))
      expect(conversations.staleAttachmentPaths(Date.now() + 1)).toContain(join(moved, 'files', 'a2.png'))
    } finally {
      paths.data = data
    }
  })

  it('refuse a file outside the data folder', () => {
    expect(() => toStored('/etc/hosts')).toThrow(/data folder/)
    expect(() => toStored(join(data, '..', 'elsewhere', 'x.png'))).toThrow(/data folder/)
    expect(() => toStored(data)).toThrow(/data folder/)
  })

  it('are relative for project files too', () => {
    const p = projects.createProject({ name: 'Paths' })
    const file = join(data, 'files', 'pf1.md')
    projects.insertProjectFile({ id: 'pf1', project_id: p.id, name: 'a.md', mime: 'text/markdown', size: 1, path: file, text: 'a', token_est: 1 })
    expect(storedPath('project_files', 'pf1')).toBe('files/pf1.md')
    expect(projects.deleteProject(p.id)).toEqual([file])
  })
})

describe('the migration to relative paths', () => {
  it('rewrites absolute paths from any old data folder to files/<name>, and leaves relative ones', () => {
    const d = new DatabaseSync(':memory:')
    const index = MIGRATIONS.findIndex((sql) => sql.includes('-- File paths relative to the data folder'))
    expect(index).toBeGreaterThan(0)
    for (const sql of MIGRATIONS.slice(0, index)) d.exec(sql)
    const add = d.prepare(
      `INSERT INTO attachments (id, message_id, kind, name, mime, size, path, text, token_est, created_at)
       VALUES (?, NULL, 'image', 'x.png', 'image/png', 1, ?, NULL, 0, 0)`
    )
    add.run('old', '/Users/me/Library/Application Support/Kiln/files/old.png')
    add.run('new', 'files/new.png')
    d.exec(MIGRATIONS[index])
    const rows = d.prepare('SELECT id, path FROM attachments ORDER BY id').all() as Array<{ id: string; path: string }>
    expect(rows.map((r) => [r.id, r.path])).toEqual([
      ['new', 'files/new.png'],
      ['old', 'files/old.png']
    ])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/storedPaths.test.ts`
Expected: FAIL. `toStored` is not exported, and the migration index is -1.

- [ ] **Step 3: Implement `paths.ts`.** Replace the whole file:

```ts
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
```

In `src/main/index.ts`, change `initPaths()` to `initPaths(app.getPath('userData'))`.

- [ ] **Step 4: Convert at the database layer.**

In `src/main/db/conversations.ts`, add `import { fromStored, toStored } from '../paths'`, then:
- In `deleteConversation`, change `.map((r) => r.path)` to `.map((r) => fromStored(r.path))`.
- In `deleteMessagesFrom`, change `.map(\n      (r) => r.path\n    )` to `.map((r) => fromStored(r.path))`.
- In `insertAttachment`, change the `a.path,` argument to `toStored(a.path),`.
- Replace the three row readers:

```ts
const resolved = (r: AttachmentRow): AttachmentRow => ({ ...r, path: fromStored(r.path) })

export function getAttachmentRow(id: string): AttachmentRow | undefined {
  const row = get<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', id)
  return row && resolved(row)
}

export function attachmentRowsForMessage(messageId: string): AttachmentRow[] {
  return all<AttachmentRow>('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at', messageId).map(resolved)
}

/** Every file attached to a chat's messages, oldest first. */
export function attachmentRowsForConversation(conversationId: string): AttachmentRow[] {
  return all<AttachmentRow>(
    `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.conversation_id = ? ORDER BY a.created_at`,
    conversationId
  ).map(resolved)
}
```

- In `deletePendingAttachment`, change `return row.path` to `return fromStored(row.path)`.
- In `staleAttachmentPaths`, change `return rows.map((r) => r.path)` to `return rows.map((r) => fromStored(r.path))`.

In `src/main/db/projects.ts`, add `import { fromStored, toStored } from '../paths'`, then:
- In `deleteProject`, change `.map((r) => r.path)` to `.map((r) => fromStored(r.path))`.
- In `insertProjectFile`, change the `f.path,` argument to `toStored(f.path),`.
- In `deleteProjectFile`, change `return row?.path ?? null` to `return row ? fromStored(row.path) : null`.

Then run `git grep -n "path" src/main/db/conversations.ts src/main/db/projects.ts`. Confirm that every query reading a `path` column now goes through `fromStored`, and every insert through `toStored`.

- [ ] **Step 5: Add the SQL migration.** Append this as the last entry of `MIGRATIONS` in `src/main/db/migrations.ts`:

```ts
  /* sql */ `
  -- File paths relative to the data folder (files/<name>), so the folder can move (#60). Every stored file is in
  -- files/; replace(path, rtrim(path, replace(path, '/', '')), '') is SQLite's way to take a path's last part.
  UPDATE attachments SET path = 'files/' || replace(path, rtrim(path, replace(path, '/', '')), '') WHERE path LIKE '/%';
  UPDATE project_files SET path = 'files/' || replace(path, rtrim(path, replace(path, '/', '')), '') WHERE path LIKE '/%';
  `
```

- [ ] **Step 6: Point the existing tests' made-up paths into a data folder.**
  - **`tests/exposure.test.ts`:** add `const { paths } = await import('../src/main/paths')` after the other imports. Change `beforeAll(() => openDatabase(':memory:'))` to:
    ```ts
    beforeAll(() => {
      paths.data = mkdtempSync(join(tmpdir(), 'kiln-exposure-'))
      openDatabase(':memory:')
    })
    ```
    Replace `path: '/x'` with `path: join(paths.data, 'files', 'x')`, and `path: '/y'` with `path: join(paths.data, 'files', 'y')`. Add `import { mkdtempSync } from 'node:fs'`, `import { tmpdir } from 'node:os'` and `import { join } from 'node:path'` at the top if they're missing.
  - **`tests/service.test.ts`:** after the block of `await import(...)` lines, add:
    ```ts
    const { paths } = await import('../src/main/paths')
    paths.data = mkdtempSync(join(tmpdir(), 'kiln-service-data-'))
    ```
    Replace `path: '/nonexistent/notes.txt'` with `path: join(paths.data, 'files', 'notes.txt')`. Add the `node:fs`, `node:os` and `node:path` imports if they're missing. The later `const { paths } = await import('../src/main/paths')` inside a test then shadows the top-level one harmlessly; delete it if lint complains.
  - **`tests/runner.test.ts`:** after `paths.workspaces = join(root, 'workspaces')`, add `paths.data = root`. The attachments there are already in `join(root, 'files', …)`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/storedPaths.test.ts && npm test && npm run typecheck && npm run lint`
Expected: all PASS. If another test fails with "Not a file in the data folder", it stores a made-up path. Point it into `join(paths.data, 'files', …)` the same way.

- [ ] **Step 8: Commit**

```bash
git add src/main/paths.ts src/main/index.ts src/main/db tests
git commit -m "Store file paths relative to the data folder, so it can move (#60)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Lock MCP servers whose environment values can't be read

**Files:**
- Modify: `src/shared/types.ts` (`McpServer`), `src/main/mcp/config.ts`, `src/main/mcp/manager.ts` (`start`), `src/renderer/src/views/ToolsSettings.tsx`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Produces:
  - `McpServer.missingEnv: string[]`
  - `forgetEnvValues(): string[]`, exported from `src/main/mcp/config.ts`. It returns the ids of servers that had values.
  - A locked server's status is `{ state: 'error', error: <message naming the variables> }`.

- [ ] **Step 1: Write the failing tests.** Append at the **end** of `tests/mcp.test.ts`; `forgetEnvValues` touches every server, so these go last. Add `const { safeStorage } = await import('electron')` next to the file's other imports.

```ts
describe('servers whose environment values can’t be read', () => {
  it('are locked and never started, rather than started without their token', async () => {
    const s = fixture('Locked', { TOKEN: 'secret' })
    const lost = vi.spyOn(safeStorage, 'decryptString').mockImplementation(() => {
      throw new Error('the keychain entry is gone')
    })
    try {
      expect(config.getServer(s.id)?.missingEnv).toEqual(['TOKEN'])
      await manager.connect(s.id)
      expect(status(s.id)).toMatchObject({ state: 'error' })
      expect(status(s.id).error).toMatch(/TOKEN/)
    } finally {
      lost.mockRestore()
    }
  })

  it('stay locked through an edit that doesn’t enter the values, and unlock when they’re entered', () => {
    const s = fixture('Relock', { TOKEN: 't', OTHER: 'o' })
    expect(config.forgetEnvValues()).toContain(s.id)
    const edit = (env: Record<string, string | null>) =>
      config.saveServer({ id: s.id, name: 'Relock', command: process.execPath, args: [FIXTURE], cwd: null, env, defaultOn: false })
    edit({})
    expect(config.getServer(s.id)).toMatchObject({ envKeys: ['OTHER', 'TOKEN'], missingEnv: ['OTHER', 'TOKEN'] })
    edit({ OTHER: 'o2' })
    expect(config.getServer(s.id)).toMatchObject({ envKeys: ['OTHER', 'TOKEN'], missingEnv: ['TOKEN'] })
    edit({ TOKEN: 't2' })
    expect(config.getServer(s.id)?.missingEnv).toEqual([])
    expect(config.getServerConfig(s.id)?.env).toEqual({ OTHER: 'o2', TOKEN: 't2' })
  })

  it('can drop a variable they can’t read', () => {
    const s = fixture('Drop', { TOKEN: 't' })
    config.forgetEnvValues()
    config.saveServer({ id: s.id, name: 'Drop', command: process.execPath, args: [FIXTURE], cwd: null, env: { TOKEN: null }, defaultOn: false })
    expect(config.getServer(s.id)).toMatchObject({ envKeys: [], missingEnv: [] })
  })

  it('forgetting values reports only servers that had some', () => {
    const plain = fixture('Plain')
    expect(config.forgetEnvValues()).not.toContain(plain.id)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/mcp.test.ts -t "can’t be read"`
Expected: FAIL. `missingEnv` is undefined, and `forgetEnvValues` is not a function.

- [ ] **Step 3: Add the type.** In `src/shared/types.ts`, inside `interface McpServer`, after `envKeys: string[]`, add:

```ts
  /**
   * Variables whose values can't be read (the keychain entry that encrypted them is gone). The server doesn't start
   * until they're entered again: it would run without its token.
   */
  missingEnv: string[]
```

- [ ] **Step 4: Implement in `src/main/mcp/config.ts`.**
  - Change `interface StoredServer extends Omit<McpServer, 'envKeys'>` to `interface StoredServer extends Omit<McpServer, 'envKeys' | 'missingEnv'>`.
  - Replace `publicView` and `decryptEnv` with:

```ts
/** The stored environment, or null when it can't be decrypted (the keychain entry that encrypted it is gone). */
function decryptEnv(enc: string | null): Record<string, string> | null {
  if (!enc) return {}
  try {
    const env = JSON.parse(safeStorage.decryptString(Buffer.from(enc, 'base64'))) as unknown
    return env && typeof env === 'object' && !Array.isArray(env) ? (env as Record<string, string>) : null
  } catch {
    return null
  }
}

/** Variables without a readable value. */
const missingEnv = (s: StoredServer, env = decryptEnv(s.env)): string[] => s.envKeys.filter((k) => !env || !(k in env))

const publicView = (s: StoredServer, env = decryptEnv(s.env)): McpServer => {
  const { env: _env, trusted: _trusted, ...server } = s
  return { ...server, missingEnv: missingEnv(s, env) }
}
```

  - Replace `getServerConfig`:

```ts
export function getServerConfig(id: string): ServerConfig | null {
  const s = stored().find((x) => x.id === id)
  if (!s) return null
  const env = decryptEnv(s.env)
  return { ...publicView(s, env), env: env ?? {} }
}
```

  - In `saveServer`, replace the line `const env = existing ? decryptEnv(existing.env) : {}` and the `for` loop after it with:

```ts
  const readable = existing ? decryptEnv(existing.env) : {}
  const env: Record<string, string> = { ...(readable ?? {}) }
  for (const [key, value] of Object.entries(input.env)) {
    if (value === null) delete env[key]
    else env[key] = value
  }
  // Values that couldn't be read and weren't entered again (or removed) stay listed, so the server stays locked
  // rather than losing them or starting without them.
  const unread = existing ? missingEnv(existing, readable).filter((k) => !(k in input.env)) : []
```

   And in the `next` object, change `envKeys: Object.keys(env).sort(),` to `envKeys: [...new Set([...Object.keys(env), ...unread])].sort(),`.

  - Add after `saveServer`:

```ts
/**
 * Forget every server's environment values, keeping the variable names, and return the ids of servers that had any.
 * For values that can no longer be read (#60): each of those servers then asks for them again.
 */
export function forgetEnvValues(): string[] {
  const servers = stored()
  const had = servers.filter((s) => s.env !== null).map((s) => s.id)
  if (had.length) store(servers.map((s) => (s.env === null ? s : { ...s, env: null })))
  return had
}
```

- [ ] **Step 5: Refuse to start a locked server.** In `src/main/mcp/manager.ts`, in `start()`, right after `if (!config) return`, add:

```ts
  if (config.missingEnv.length) {
    const names = config.missingEnv.join(', ')
    return update(c, {
      state: 'error',
      error: `Kiln couldn't read ${names}. Enter ${config.missingEnv.length === 1 ? 'it' : 'them'} again in Settings → Tools.`,
      tools: [],
      serverInfo: null
    })
  }
```

- [ ] **Step 6: Show it in Settings → Tools** (`src/renderer/src/views/ToolsSettings.tsx`).
  - In `stateText`, first line of the body:
    ```ts
    if (server.missingEnv.length) return `Needs ${server.missingEnv.join(', ')} again: Kiln couldn't read the saved values. Edit the server to enter them.`
    ```
  - In `ServerRow`, change `const state = status?.state ?? 'stopped'` to `const state = server.missingEnv.length ? 'error' : (status?.state ?? 'stopped')`.
  - In `interface EnvRow`, add:
    ```ts
      /** Stored, but its value can't be read: it must be entered again. */
      missing?: boolean
    ```
  - In `ServerDialog`, change the `env` state's initial value to `server?.envKeys.map((key) => ({ key, value: '', saved: true, missing: server.missingEnv.includes(key) })) ?? []`.
  - Change the value field's placeholder to `r.missing ? 'Enter again' : r.saved ? 'Saved (leave blank to keep)' : 'value'`.

- [ ] **Step 7: Run the tests and checks**

Run: `npx vitest run tests/mcp.test.ts && npm test && npm run typecheck && npm run lint`
Expected: PASS. If typecheck flags another object literal typed `McpServer`, give it `missingEnv: []`.

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/main/mcp src/renderer/src/views/ToolsSettings.tsx tests/mcp.test.ts
git commit -m "Never start an MCP server whose environment values can't be read (#60)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Migration phase 1: move Kiln's data folder

**Files:**
- Create: `src/main/migrate.ts`, `tests/migrate.test.ts`

**Interfaces:**
- Produces (from `src/main/migrate.ts`):
  - `OLD_DB = 'kiln.db'`, `OLD_WORKSPACE_DIR = '.kiln'`, `MARKER = '.migrating-from-kiln'`
  - `oldDataFolder(dataDir: string): string`
  - `kilnPid(folder: string, isKiln?: (pid: number) => boolean): number | null`
  - `type MoveResult = { state: 'none' } | { state: 'moved' } | { state: 'kiln-running'; pid: number } | { state: 'failed'; error: string }`
  - `moveKilnData(dataDir: string, opts?: { isKiln?: (pid: number) => boolean }): MoveResult`
  - `waitForKiln(isRunning: () => boolean, show: (signal: AbortSignal) => Promise<unknown>, intervalMs?: number): Promise<boolean>`
  - `STILL_OPEN: { message: string; detail: string; button: string }`
  - `moveFailedText(error: string): { title: string; content: string }`

- [ ] **Step 1: Write the failing tests.** Create `tests/migrate.test.ts`:

```ts
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The migration's keychain use is faked, as in mcp.test.ts: Electron isn't running under vitest.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  },
  shell: {},
  app: { getPath: () => '' }
}))

const migrate = await import('../src/main/migrate')

/** A folder holding "Kiln" (with a kiln.db) and room for "Ollmost" next to it, as in Application Support. */
function appSupport(): { kiln: string; ollmost: string } {
  const root = mkdtempSync(join(tmpdir(), 'migrate-'))
  const kiln = join(root, 'Kiln')
  mkdirSync(join(kiln, 'files'), { recursive: true })
  writeFileSync(join(kiln, 'kiln.db'), 'db')
  writeFileSync(join(kiln, 'files', 'a.png'), 'png')
  return { kiln, ollmost: join(root, 'Ollmost') }
}

const sleepers: Array<ReturnType<typeof spawn>> = []
const livePid = () => {
  const child = spawn('sleep', ['30'])
  sleepers.push(child)
  return child.pid!
}
afterAll(() => sleepers.forEach((c) => c.kill()))

describe('moving Kiln’s data folder', () => {
  it('moves it, drops Kiln’s lock files and leaves a marker', () => {
    const { kiln, ollmost } = appSupport()
    symlinkSync('Mac-999999', join(kiln, 'SingletonLock'))
    symlinkSync('/nonexistent/socket', join(kiln, 'SingletonSocket'))
    expect(migrate.moveKilnData(ollmost)).toEqual({ state: 'moved' })
    expect(existsSync(kiln)).toBe(false)
    expect(existsSync(join(ollmost, 'files', 'a.png'))).toBe(true)
    expect(readdirSync(ollmost).filter((n) => n.startsWith('Singleton'))).toEqual([])
    expect(existsSync(join(ollmost, migrate.MARKER))).toBe(true)
  })

  it('does nothing when the new folder exists, or Kiln left no database', () => {
    const { kiln, ollmost } = appSupport()
    mkdirSync(ollmost)
    expect(migrate.moveKilnData(ollmost)).toEqual({ state: 'none' })
    expect(existsSync(kiln)).toBe(true)
    // A fresh install: no Kiln folder next to it.
    const fresh = join(mkdtempSync(join(tmpdir(), 'migrate-')), 'Ollmost')
    expect(migrate.moveKilnData(fresh)).toEqual({ state: 'none' })
  })

  it('does nothing while the app itself is still called Kiln', () => {
    const { kiln } = appSupport()
    expect(migrate.moveKilnData(kiln)).toEqual({ state: 'none' })
  })

  it('waits while Kiln is running, creating nothing', () => {
    const { kiln, ollmost } = appSupport()
    const pid = livePid()
    symlinkSync(`Mac-${pid}`, join(kiln, 'SingletonLock'))
    expect(migrate.moveKilnData(ollmost, { isKiln: () => true })).toEqual({ state: 'kiln-running', pid })
    expect(existsSync(ollmost)).toBe(false)
    expect(existsSync(join(kiln, 'kiln.db'))).toBe(true)
  })

  it('moves anyway when the lock is stale: a dead pid, or one another program now has', () => {
    const a = appSupport()
    symlinkSync('Mac-999999', join(a.kiln, 'SingletonLock'))
    expect(migrate.moveKilnData(a.ollmost, { isKiln: () => true }).state).toBe('moved')
    const b = appSupport()
    symlinkSync(`Mac-${livePid()}`, join(b.kiln, 'SingletonLock'))
    // The real check: `sleep` is not Kiln.
    expect(migrate.moveKilnData(b.ollmost).state).toBe('moved')
  })

  it('reports a failed move and leaves everything as it was', () => {
    const { kiln, ollmost } = appSupport()
    const parent = join(kiln, '..')
    chmodSync(parent, 0o555)
    try {
      const result = migrate.moveKilnData(ollmost)
      expect(result.state).toBe('failed')
      expect(existsSync(ollmost)).toBe(false)
      expect(existsSync(join(kiln, 'kiln.db'))).toBe(true)
    } finally {
      chmodSync(parent, 0o755)
    }
  })
})

describe('waiting for Kiln to quit', () => {
  it('goes on once Kiln has quit, closing the message', async () => {
    let running = true
    setTimeout(() => (running = false), 50)
    const shown = (signal: AbortSignal) => new Promise((resolve) => signal.addEventListener('abort', resolve))
    expect(await migrate.waitForKiln(() => running, shown, 10)).toBe(true)
  })

  it('stops when the user quits instead', async () => {
    expect(await migrate.waitForKiln(() => true, async () => undefined, 10)).toBe(false)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/migrate.test.ts`
Expected: FAIL. Cannot find module `../src/main/migrate`.

- [ ] **Step 3: Implement.** Create `src/main/migrate.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Kiln was renamed Ollmost (#60). An install that ran Kiln has its data in the folder next to Ollmost's, named for
// the old app; the first launch moves it over (phase 1, before anything can create the new folder), then finishes
// the move inside it (phase 2). This file holds the old names, so the rename must never touch it.

export const OLD_FOLDER = 'Kiln'
export const OLD_DB = 'kiln.db'
export const OLD_WORKSPACE_DIR = '.kiln'
/** Written once the folder has moved; removed when phase 2 has finished. */
export const MARKER = '.migrating-from-kiln'

/** Where Kiln kept the data for this data folder: next to it. */
export const oldDataFolder = (dataDir: string): string => join(dirname(dataDir), OLD_FOLDER)

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Kiln itself, or Electron running Kiln from source. */
function isKilnProcess(pid: number): boolean {
  try {
    return /\/(Kiln|Electron)$/.test(execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim())
  } catch {
    return false
  }
}

/**
 * Kiln's pid while it runs. Kiln always holds Chromium's singleton lock, a link in its folder to "<host>-<pid>"; a
 * lock left by a crash names a dead process, or one another program has since been given.
 */
export function kilnPid(folder: string, isKiln: (pid: number) => boolean = isKilnProcess): number | null {
  let target: string
  try {
    target = readlinkSync(join(folder, 'SingletonLock'))
  } catch {
    return null
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1))
  return Number.isInteger(pid) && pid > 0 && alive(pid) && isKiln(pid) ? pid : null
}

export type MoveResult = { state: 'none' } | { state: 'moved' } | { state: 'kiln-running'; pid: number } | { state: 'failed'; error: string }

/**
 * Move Kiln's data folder to `dataDir`, if Kiln left one there and nothing is at `dataDir` yet. Synchronous: it runs
 * before the single-instance lock, which makes Chromium create the data folder, and then the move would never happen.
 */
export function moveKilnData(dataDir: string, opts: { isKiln?: (pid: number) => boolean } = {}): MoveResult {
  const from = oldDataFolder(dataDir)
  if (from === dataDir || existsSync(dataDir) || !existsSync(join(from, OLD_DB))) return { state: 'none' }
  const pid = kilnPid(from, opts.isKiln)
  if (pid !== null) return { state: 'kiln-running', pid }
  try {
    renameSync(from, dataDir)
  } catch (err) {
    return { state: 'failed', error: (err as Error).message }
  }
  // Chromium's lock files belong to Kiln's last session.
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) rmSync(join(dataDir, name), { force: true })
  writeFileSync(join(dataDir, MARKER), new Date().toISOString())
  return { state: 'moved' }
}

/**
 * Show `show` (a message that closes when its signal aborts) until Kiln has quit. True once it has (the caller
 * relaunches, and the relaunch moves the folder); false when the user quit instead.
 */
export async function waitForKiln(
  isRunning: () => boolean,
  show: (signal: AbortSignal) => Promise<unknown>,
  intervalMs = 500
): Promise<boolean> {
  const quit = new AbortController()
  const timer = setInterval(() => {
    if (!isRunning()) quit.abort()
  }, intervalMs)
  try {
    await show(quit.signal)
    return quit.signal.aborted
  } finally {
    clearInterval(timer)
  }
}

export const STILL_OPEN = {
  message: 'Kiln is still open',
  detail: 'Quit Kiln to move your chats, projects and settings to Ollmost. Ollmost will carry on by itself once Kiln has quit.',
  button: 'Quit Ollmost'
}

export const moveFailedText = (error: string): { title: string; content: string } => ({
  title: "Ollmost couldn't move your Kiln data",
  content: `${error}\n\nNothing was changed: Kiln still has all of it.`
})
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/migrate.test.ts && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/migrate.ts tests/migrate.test.ts
git commit -m "Move Kiln's data folder for Ollmost, waiting while Kiln runs (#60)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Migration phase 2: finish inside the moved folder

**Files:**
- Modify: `src/main/migrate.ts`, `src/main/db/migrations.ts` (append an entry), `tests/migrate.test.ts`
- Create: `src/shared/migration.ts`

**Interfaces:**
- Consumes: `forgetEnvValues()` (Task 3); `readSetting`, `writeSetting` and `deleteSetting` from `src/main/db/kv.ts`; `transaction` and `openDatabase` from `src/main/db/index.ts`.
- Produces:
  - `migrationPending(dataDir: string, dbFile: string): boolean`
  - `renameDatabase(dataDir: string, dbFile: string): void`. It writes `MARKER` first if it's missing.
  - `finishMigration(dataDir: string, workspaceDir: string): Promise<void>`
  - `interface MigrationNotice { at: number; apiKey: boolean; servers: string[]; dismissed: boolean }`
  - `migrationNotice(): MigrationNotice | null` and `dismissMigrationNotice(): void`
  - `src/shared/migration.ts`: `interface MigrationNoticeView { apiKey: boolean; servers: string[] }`, `NOTICE_TITLE`, `NOTICE_BODY`, `NOTICE_API_KEY`, and `noticeServers(names: string[]): string`

- [ ] **Step 1: Write the failing tests.** Append to `tests/migrate.test.ts`. Add `copyFileSync`, `readFileSync` and `renameSync` to its `node:fs` import, and `import { DatabaseSync } from 'node:sqlite'`.

```ts
const { openDatabase } = await import('../src/main/db/index')
const { MIGRATIONS } = await import('../src/main/db/migrations')
const { readSetting, writeSetting } = await import('../src/main/db/kv')
const mcp = await import('../src/main/mcp/config')

const count = (file: string) => {
  const d = new DatabaseSync(file)
  try {
    return (d.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n
  } finally {
    d.close()
  }
}

/** Kiln's database as a crash leaves it: two rows written only to the WAL, which nothing has checkpointed. */
function crashedDatabase(): string {
  const live = mkdtempSync(join(tmpdir(), 'migrate-db-'))
  const writer = new DatabaseSync(join(live, 'kiln.db'))
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x); INSERT INTO t VALUES (1), (2);')
  const crashed = mkdtempSync(join(tmpdir(), 'migrate-crashed-'))
  for (const f of readdirSync(live)) copyFileSync(join(live, f), join(crashed, f))
  writer.close()
  expect(existsSync(join(crashed, 'kiln.db-wal'))).toBe(true)
  return crashed
}

describe('what’s left to do after the move', () => {
  it('is pending after a move, or while Kiln’s database still has its old name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-'))
    expect(migrate.migrationPending(dir, join(dir, 'ollmost.db'))).toBe(false)
    writeFileSync(join(dir, 'kiln.db'), '')
    expect(migrate.migrationPending(dir, join(dir, 'ollmost.db'))).toBe(true)
    // Not while the app itself still uses kiln.db (before the rename): that's the live database.
    expect(migrate.migrationPending(dir, join(dir, 'kiln.db'))).toBe(false)
    writeFileSync(join(dir, migrate.MARKER), '')
    expect(migrate.migrationPending(dir, join(dir, 'kiln.db'))).toBe(true)
  })
})

describe('renaming Kiln’s database', () => {
  it('keeps transactions only in the WAL', () => {
    const dir = crashedDatabase()
    migrate.renameDatabase(dir, join(dir, 'ollmost.db'))
    expect(existsSync(join(dir, 'kiln.db'))).toBe(false)
    expect(existsSync(join(dir, migrate.MARKER))).toBe(true)
    expect(count(join(dir, 'ollmost.db'))).toBe(2)
  })

  it('finishes a rename a crash interrupted after the WAL was renamed', () => {
    const dir = crashedDatabase()
    renameSync(join(dir, 'kiln.db-wal'), join(dir, 'ollmost.db-wal'))
    renameSync(join(dir, 'kiln.db-shm'), join(dir, 'ollmost.db-shm'))
    migrate.renameDatabase(dir, join(dir, 'ollmost.db'))
    expect(count(join(dir, 'ollmost.db'))).toBe(2)
  })

  it('renames nothing when both databases exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-'))
    writeFileSync(join(dir, 'kiln.db'), 'old')
    writeFileSync(join(dir, 'ollmost.db'), 'new')
    migrate.renameDatabase(dir, join(dir, 'ollmost.db'))
    expect(readFileSync(join(dir, 'kiln.db'), 'utf8')).toBe('old')
    expect(readFileSync(join(dir, 'ollmost.db'), 'utf8')).toBe('new')
  })
})

describe('finishing the move', () => {
  beforeAll(() => openDatabase(':memory:'))

  it('forgets Kiln’s secrets, noting once what to ask for again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-'))
    writeFileSync(join(dir, migrate.MARKER), '')
    writeSetting('apiKey', Buffer.from('enc:key').toString('base64'))
    const server = mcp.saveServer({ name: 'GitHub', command: 'npx', args: [], cwd: null, env: { TOKEN: 't' }, defaultOn: false })
    await migrate.finishMigration(dir, '.ollmost')
    expect(readSetting('apiKey', null)).toBeNull()
    expect(mcp.getServer(server.id)?.missingEnv).toEqual(['TOKEN'])
    expect(migrate.migrationNotice()).toMatchObject({ apiKey: true, servers: [server.id], dismissed: false })
    expect(existsSync(join(dir, migrate.MARKER))).toBe(false)
    // Run again, as after a crash: what the first run noted is kept, though the secrets are gone now.
    writeFileSync(join(dir, migrate.MARKER), '')
    await migrate.finishMigration(dir, '.ollmost')
    expect(migrate.migrationNotice()).toMatchObject({ apiKey: true, servers: [server.id] })
    migrate.dismissMigrationNotice()
    expect(migrate.migrationNotice()).toBeNull()
  })

  it('deletes the Python environments and renames each chat’s hidden folder, moving a link, not following it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-'))
    for (const venv of ['base-venv/bin', 'venvs/c1/bin', 'venv/bin']) mkdirSync(join(dir, 'runner', venv), { recursive: true })
    mkdirSync(join(dir, 'runner', 'scripts', 'c1'), { recursive: true })
    mkdirSync(join(dir, 'workspaces', 'c1', '.kiln', 'home'), { recursive: true })
    writeFileSync(join(dir, 'workspaces', 'c1', '.kiln', 'home', 'saved.txt'), 'kept')
    const outside = mkdtempSync(join(tmpdir(), 'migrate-outside-'))
    writeFileSync(join(outside, 'target.txt'), 'untouched')
    mkdirSync(join(dir, 'workspaces', 'c2'), { recursive: true })
    symlinkSync(outside, join(dir, 'workspaces', 'c2', '.kiln'))
    mkdirSync(join(dir, 'workspaces', 'c3', '.kiln'), { recursive: true })
    mkdirSync(join(dir, 'workspaces', 'c3', '.ollmost'), { recursive: true })
    writeFileSync(join(dir, 'workspaces', 'c3', '.ollmost', 'new.txt'), 'new')

    await migrate.finishMigration(dir, '.ollmost')

    expect(readdirSync(join(dir, 'runner'))).toEqual(['scripts'])
    expect(readFileSync(join(dir, 'workspaces', 'c1', '.ollmost', 'home', 'saved.txt'), 'utf8')).toBe('kept')
    expect(existsSync(join(dir, 'workspaces', 'c1', '.kiln'))).toBe(false)
    expect(readFileSync(join(outside, 'target.txt'), 'utf8')).toBe('untouched')
    expect(existsSync(join(dir, 'workspaces', 'c2', '.kiln'))).toBe(false)
    expect(existsSync(join(dir, 'workspaces', 'c3', '.kiln'))).toBe(false)
    expect(readFileSync(join(dir, 'workspaces', 'c3', '.ollmost', 'new.txt'), 'utf8')).toBe('new')
  })

  it('relabels the debugger’s recorded endpoints', () => {
    const d = new DatabaseSync(':memory:')
    const index = MIGRATIONS.findIndex((sql) => sql.includes('recorded endpoints'))
    expect(index).toBeGreaterThan(0)
    for (const sql of MIGRATIONS.slice(0, index)) d.exec(sql)
    d.prepare(`INSERT INTO traces (id, kind, status, started_at, data) VALUES ('t1', 'tool', 'ok', 0, ?)`).run(
      JSON.stringify({ endpoint: 'kiln://tools/web_fetch', request: null })
    )
    d.exec(MIGRATIONS[index])
    const data = (d.prepare('SELECT data FROM traces').get() as { data: string }).data
    expect(JSON.parse(data).endpoint).toBe('ollmost://tools/web_fetch')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/migrate.test.ts`
Expected: FAIL. `migrationPending` is not a function, and more.

- [ ] **Step 3: Create `src/shared/migration.ts`:**

```ts
// The words about the move from Kiln (#60), kept out of the rename, which must never touch the old name.

/** After the move from Kiln: what needs entering again. */
export interface MigrationNoticeView {
  apiKey: boolean
  /** MCP servers whose environment values need entering again, by name. */
  servers: string[]
}

export const NOTICE_TITLE = 'Kiln is now Ollmost.'
export const NOTICE_BODY = 'Your chats, projects, files and settings came along.'
export const NOTICE_API_KEY = "Your ollama.com API key didn't: it was locked to Kiln in your keychain. Enter it again in Settings."
export const noticeServers = (names: string[]): string =>
  `${names.length === 1 ? '1 MCP server needs its' : `${names.length} MCP servers need their`} environment values again: ${names.join(', ')}.`
```

- [ ] **Step 4: Add phase 2 to `src/main/migrate.ts`.** Add these imports: `lstat`, `readdir`, `rename` and `rm` from `node:fs/promises`; `basename` from `node:path`; `forgetEnvValues` from `./mcp/config`; `deleteSetting`, `readSetting` and `writeSetting` from `./db/kv`; and `transaction` from `./db/index`. Then append:

```ts
/** Whether a moved Kiln folder still has work left: the marker, or Kiln's database not yet renamed. */
export function migrationPending(dataDir: string, dbFile: string): boolean {
  return existsSync(join(dataDir, MARKER)) || (basename(dbFile) !== OLD_DB && existsSync(join(dataDir, OLD_DB)))
}

/**
 * Give Kiln's database its new name, before it's opened. The marker goes first, so a crash before phase 2 has
 * finished still finishes it. Then the WAL and shared-memory files, then the database: SQLite finds the WAL by the
 * database's name, so ollmost.db must never sit next to a kiln.db-wal (its unsaved transactions would be lost).
 */
export function renameDatabase(dataDir: string, dbFile: string): void {
  const oldDb = join(dataDir, OLD_DB)
  if (dbFile === oldDb) return
  if (!existsSync(join(dataDir, MARKER))) writeFileSync(join(dataDir, MARKER), new Date().toISOString())
  if (!existsSync(oldDb)) return
  if (existsSync(dbFile)) return void console.warn(`Ollmost: both ${OLD_DB} and ${basename(dbFile)} exist; using ${basename(dbFile)}`)
  for (const suffix of ['-wal', '-shm', '']) if (existsSync(oldDb + suffix)) renameSync(oldDb + suffix, dbFile + suffix)
}

export interface MigrationNotice {
  at: number
  /** An ollama.com API key was saved: it needs entering again. */
  apiKey: boolean
  /** MCP servers whose environment values need entering again, by id. */
  servers: string[]
  dismissed: boolean
}

const NOTICE_KEY = 'migratedFromKiln'

/**
 * Finish the move, once the database is open. Secrets Kiln encrypted with its keychain entry are forgotten (read with
 * Ollmost's key they'd fail, or about once in 256 decrypt to garbage), noting in the same transaction what to ask for
 * again. The Python environments go (they point at the old folder; the next run rebuilds them), and each chat's
 * hidden folder gets its new name (it holds the run's home folder). Every step can run again after a crash; the
 * marker goes last.
 */
export async function finishMigration(dataDir: string, workspaceDir: string): Promise<void> {
  transaction(() => {
    if (readSetting<MigrationNotice | null>(NOTICE_KEY, null)) return
    const apiKey = readSetting<string | null>('apiKey', null) !== null
    deleteSetting('apiKey')
    writeSetting(NOTICE_KEY, { at: Date.now(), apiKey, servers: forgetEnvValues(), dismissed: false } satisfies MigrationNotice)
  })
  // rm removes a link code left in an environment without following it.
  for (const venv of ['base-venv', 'venvs', 'venv']) await rm(join(dataDir, 'runner', venv), { recursive: true, force: true })
  const workspaces = join(dataDir, 'workspaces')
  for (const id of await readdir(workspaces).catch(() => [] as string[])) {
    const from = join(workspaces, id, OLD_WORKSPACE_DIR)
    const to = join(workspaces, id, workspaceDir)
    if (from === to || !(await lstat(from).catch(() => null))) continue
    // rename and rm act on the entry itself: a link code put there is moved or removed, never followed.
    if (await lstat(to).catch(() => null)) await rm(from, { recursive: true, force: true })
    else await rename(from, to)
  }
  await rm(join(dataDir, MARKER), { force: true })
}

/** What didn't carry over, until the user dismisses the notice. */
export function migrationNotice(): MigrationNotice | null {
  const notice = readSetting<MigrationNotice | null>(NOTICE_KEY, null)
  return notice && !notice.dismissed ? notice : null
}

export function dismissMigrationNotice(): void {
  const notice = readSetting<MigrationNotice | null>(NOTICE_KEY, null)
  if (notice) writeSetting(NOTICE_KEY, { ...notice, dismissed: true })
}
```

- [ ] **Step 5: Add the trace relabel.** Append this as the last entry of `MIGRATIONS` in `src/main/db/migrations.ts`. This file is excluded from the rename, so the old scheme name stays in the SQL.

```ts
  /* sql */ `
  -- The debugger's recorded endpoints for built-in tools, under the app's new URL scheme (#60).
  UPDATE traces SET data = replace(data, '"endpoint":"kiln://', '"endpoint":"ollmost://') WHERE data LIKE '%"endpoint":"kiln://%';
  `
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/migrate.test.ts && npm test && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/migrate.ts src/shared/migration.ts src/main/db/migrations.ts tests/migrate.test.ts
git commit -m "Finish moving Kiln's data inside the new folder, safe to repeat after a crash (#60)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Run the migration at startup, and show the notice

**Files:**
- Modify: `src/main/index.ts`, `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/renderer/src/views/HomeView.tsx`
- Create: `src/renderer/src/components/MigrationNotice.tsx`

**Interfaces:**
- Consumes: everything Tasks 4 and 5 export, and `KILN_DIR` from `src/main/runner/sandbox.ts`.
- Produces:
  - `api.app.migrationNotice(): Promise<MigrationNoticeView | null>`
  - `api.app.dismissMigrationNotice(): Promise<void>`
  - The notice element has `data-testid="migration-notice"` and a "Dismiss" button.

- [ ] **Step 1: Wire phase 1 into `src/main/index.ts`.**
  - Add `dialog` to the `electron` import. Add `import { tmpdir } from 'node:os'`.
  - Add this import:
    ```ts
    import { finishMigration, kilnPid, migrationPending, moveFailedText, moveKilnData, oldDataFolder, renameDatabase, STILL_OPEN, waitForKiln } from './migrate'
    ```
  - Add `import { KILN_DIR } from './runner/sandbox'`.
  - Replace the two lines after `app.setName('Kiln')`, from the comment through the `KILN_USER_DATA` line, with:

```ts
// Tests and experiments can point Kiln at a throwaway data folder.
if (process.env.KILN_USER_DATA) app.setPath('userData', process.env.KILN_USER_DATA)
// Before anything can create the data folder: move the old app's there, if it left one (#60).
const dataDir = app.getPath('userData')
const move = moveKilnData(dataDir)
// Waiting for the old app to quit, or after a failed move, this session must not create the data folder, or the move
// would be skipped for good. It uses a folder of its own, the same for every launch meanwhile, so they hand off.
if (move.state === 'kiln-running' || move.state === 'failed') app.setPath('userData', join(tmpdir(), `${app.name}-waiting`))
```

- [ ] **Step 2: Wire the rest into `whenReady`.** Replace the first lines of the `app.whenReady().then(async () => {` body, from `if (!hasLock) return` through `openDatabase(paths.db)`, keeping `trackProcesses` as it is, with:

```ts
  if (!hasLock) return
  if (move.state === 'kiln-running') return void (await waitThenRelaunch())
  if (move.state === 'failed') {
    const { title, content } = moveFailedText(move.error)
    dialog.showErrorBox(title, content)
    return app.exit(1)
  }
  initPaths(dataDir)
  // A move from the old app finishes here: its database renamed before it opens, the rest once it has.
  const migrating = migrationPending(paths.data, paths.db)
  if (migrating) renameDatabase(paths.data, paths.db)
  // Before anything starts a process: record live process groups, and stop any a crashed run left behind.
  void trackProcesses(join(paths.data, 'processes.json')).then((n) => {
    if (n) console.warn(`Kiln: stopped ${n} process ${n === 1 ? 'group' : 'groups'} left running by an earlier session`)
  })
  openDatabase(paths.db)
  if (migrating) await finishMigration(paths.data, KILN_DIR)
```

   Then add this function below `watchApprovals`:

```ts
/** The old app is still open: say so, and relaunch (which moves its data) once it has quit. */
async function waitThenRelaunch(): Promise<void> {
  const from = oldDataFolder(dataDir)
  const quit = await waitForKiln(
    () => kilnPid(from) !== null,
    (signal) =>
      dialog.showMessageBox({ type: 'info', message: STILL_OPEN.message, detail: STILL_OPEN.detail, buttons: [STILL_OPEN.button], signal })
  )
  if (quit) app.relaunch()
  app.exit(0)
}
```

- [ ] **Step 3: Add the notice to the IPC surface.**
  - In `src/shared/ipc.ts`, add `import type { MigrationNoticeView } from './migration'`. Inside `KilnApi['app']`, after `openDataFolder(): Promise<void>`, add:
    ```ts
        /** After the move from the old app (see @shared/migration): what needs entering again; null once dismissed. */
        migrationNotice(): Promise<MigrationNoticeView | null>
        dismissMigrationNotice(): Promise<void>
    ```
    In `INVOKE_CHANNELS`, change the `app` line to `app: ['info', 'setNativeTheme', 'openExternal', 'openDataFolder', 'migrationNotice', 'dismissMigrationNotice'],`.
  - In `src/main/ipc.ts`, add `import { dismissMigrationNotice, migrationNotice } from './migrate'`. Add `getServer` to the existing `./mcp/config` import, or add the import if there isn't one. After `openDataFolder` in `impl.app`, add:

```ts
    migrationNotice: async () => {
      const notice = migrationNotice()
      if (!notice) return null
      const servers = notice.servers.map((id) => getServer(id)?.name).filter((name): name is string => !!name)
      return { apiKey: notice.apiKey, servers }
    },
    dismissMigrationNotice: async () => dismissMigrationNotice()
```

- [ ] **Step 4: Create `src/renderer/src/components/MigrationNotice.tsx`:**

```tsx
import { useEffect, useState } from 'react'
import { type MigrationNoticeView, NOTICE_API_KEY, NOTICE_BODY, NOTICE_TITLE, noticeServers } from '@shared/migration'
import { Button } from '@/components/ui'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'

/** Once, after the move from the old app (#60): what came along, and what needs entering again. */
export function MigrationNotice() {
  const navigate = useApp((s) => s.navigate)
  const [notice, setNotice] = useState<MigrationNoticeView | null>(null)
  useEffect(() => {
    api.app
      .migrationNotice()
      .then(setNotice)
      .catch(() => undefined)
  }, [])
  if (!notice) return null
  const dismiss = () => {
    setNotice(null)
    void api.app.dismissMigrationNotice()
  }
  return (
    <div data-testid="migration-notice" className="mb-4 space-y-2 rounded-kiln border border-line bg-panel p-4 text-sm">
      <div>
        <div className="font-medium">{NOTICE_TITLE}</div>
        <div className="mt-1 text-muted">{NOTICE_BODY}</div>
      </div>
      {notice.apiKey && (
        <div className="flex items-center justify-between gap-3">
          <span>{NOTICE_API_KEY}</span>
          <Button size="sm" onClick={() => navigate({ name: 'settings', tab: 'general' })}>
            Open Settings
          </Button>
        </div>
      )}
      {notice.servers.length > 0 && (
        <div className="flex items-center justify-between gap-3">
          <span>{noticeServers(notice.servers)}</span>
          <Button size="sm" onClick={() => navigate({ name: 'settings', tab: 'tools' })}>
            Open Tools
          </Button>
        </div>
      )}
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={dismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}
```

   In `src/renderer/src/views/HomeView.tsx`, import it: `import { MigrationNotice } from '@/components/MigrationNotice'`. Then render `<MigrationNotice />` as the first child of the `<div className="w-full" style={{ maxWidth: 'var(--k-chat-width)' }}>` element, just before `{noModels && (`.

- [ ] **Step 5: Run the checks and a build**

Run: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build`
Expected: PASS. At this point the app is still called Kiln, so `moveKilnData` returns `none` (`oldDataFolder(dataDir) === dataDir`) and `migrationPending` is false: startup behaves exactly as before.

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts src/shared/ipc.ts src/main/ipc.ts src/renderer/src/components/MigrationNotice.tsx src/renderer/src/views/HomeView.tsx
git commit -m "Run the move from the old app at startup, and say once what didn't carry over (#60)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The mechanical rename

**Files:** every tracked file containing "kiln" (any case) or `--k-`, except the exclusions below.

**Interfaces:**
- Produces:
  - `window.ollmost`, `OllmostApi`, `OLLMOST_DIR = '.ollmost'`, `app.setName('Ollmost')`, `paths.db = …/ollmost.db`, the `ollmost://` scheme
  - `OLLMOST_USER_DATA`, `OLLMOST_DEBUG`, `OLLMOST_WEB_URL`, `OLLMOST_USAGE_URL`, `OLLMOST_ALLOW_PRIVATE_PREVIEWS`, `OLLMOST_CLAUDE_DESKTOP_CONFIG`, `OLLMOST_CLAUDE_CODE_CONFIG`, `OLLMOST_INSTALL_DIR`
  - CSS classes `rounded-ollmost`, `prose-ollmost`, `ollmost-shimmer`, `ollmost-pulse`, and variables `--o-*`

- [ ] **Step 1: Check for surprises**

Run: `git ls-files | grep -i kiln`
Expected: no output. No file has "kiln" in its name.
Run: `git grep -n -- '--k-' -- . ':!docs'`
Expected: every match is a CSS custom property: a `--k-…:` definition in `index.css`, a `var(--k-…)`, or a `setProperty`/`getPropertyValue` call. If anything else matches (a command-line flag, say), leave it out of the `--k-` replacement in Step 2.

- [ ] **Step 2: Rename.** Run from the repo root:

```bash
files=$(git ls-files -z \
  | grep -z -v -E '^(src/main/migrate\.ts|src/shared/migration\.ts|src/main/db/migrations\.ts|tests/migrate\.test\.ts|docs/|\.git-blame-ignore-revs$|resources/|package-lock\.json$)' \
  | xargs -0 grep -l -i -E 'kiln|--k-')
perl -pi -e 's/KILN/OLLMOST/g; s/Kiln/Ollmost/g; s/kiln/ollmost/g; s/--k-/--o-/g' $files
perl -pi -e 's/"name": "kiln"/"name": "ollmost"/' package-lock.json
npx prettier --write --ignore-unknown $files
```

- [ ] **Step 3: Review the diff for anything the rename got wrong**

Run: `git diff --stat | tail -3 && git grep -n -i kiln -- . ':!docs'`
Expected: the remaining matches are only in `src/main/migrate.ts`, `src/shared/migration.ts`, `src/main/db/migrations.ts` (the trace SQL), `tests/migrate.test.ts` and the comment at the top of `.git-blame-ignore-revs`.
Then read `git diff src/main/index.ts src/main/runner/sandbox.ts src/main/paths.ts electron-builder.yml package.json scripts .github` and confirm:
- `app.setName('Ollmost')`, `OLLMOST_USER_DATA`
- `OLLMOST_DIR = '.ollmost'`, `'ollmost.db'`
- `appId: local.ollmost.app`, `productName: Ollmost`
- `REPO=EdCarney/ollmost`, `Ollmost-arm64.zip`

- [ ] **Step 4: Run everything**

Run: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run e2e`
Expected: all PASS; e2e prints `N/N checks passed`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Rename Kiln to Ollmost (#60)" -m "A mechanical rename (see .git-blame-ignore-revs): the app, bundle id, data folder and database, the ollmost:// scheme, window.ollmost, OLLMOST_* variables with no fallbacks, CSS names (--k-* is now --o-*), the chats' .ollmost folders, tests and docs. The move from an existing install is in the commits before this one." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: List it in `.git-blame-ignore-revs` and commit**

```bash
hash=$(git rev-parse HEAD)
perl -0pi -e 's/# Formatting-only commits\./# Formatting-only and renaming commits./' .git-blame-ignore-revs
printf '\n# Rename Kiln to Ollmost (#60)\n%s\n' "$hash" >> .git-blame-ignore-revs
git add .git-blame-ignore-revs
git commit -m "Leave the rename out of blame" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: e2e: coming from Kiln

**Files:**
- Modify: `e2e/run.mjs`. Add imports, and a new section before the final `const failed = results.filter(...)` summary.

**Interfaces:**
- Consumes: `window.ollmost.settings.update`, `.settings.setApiKey`, `.settings.get`, `.mcp.save` and `.mcp.list` (with `missingEnv`); the existing helpers `stubOpenDialog(app, paths)` and `check(name, ok, detail)`; the notice's `data-testid="migration-notice"`.

- [ ] **Step 1: Add the imports.** Change the `node:fs` import to also bring in `existsSync`, `readFileSync` and `renameSync`, and add `import { DatabaseSync } from 'node:sqlite'`.

- [ ] **Step 2: Add the section.** Insert it before `const failed = results.filter((r) => !r.ok).length`:

```js
// 14. Coming from Kiln (#60): data Kiln left next to Ollmost's data folder moves over on the first launch, with its
// chats, files and settings. The secrets Kiln's keychain entry encrypted are asked for again, once.
{
  const home = mkdtempSync(join(tmpdir(), 'ollmost-e2e-kiln-'))
  const DOT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  writeFileSync(join(fixtures, 'dot.png'), DOT_PNG)
  const mock = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    const json = (obj) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
    if (req.url === '/api/tags') return json({ models: [{ name: 'mock-vision:latest' }] })
    if (req.url === '/api/show') return json({ capabilities: ['completion', 'vision'], model_info: { 'mock.context_length': 32768 }, details: {} })
    if (!body.stream) return json({ message: { role: 'assistant', content: 'Heron picture' }, done: true })
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'A dot.' }, done: false }) + '\n')
    res.end(JSON.stringify({ done: true, prompt_eval_count: 10, eval_count: 2, eval_duration: 1e8 }) + '\n')
  })
  await new Promise((r) => mock.listen(0, '127.0.0.1', r))
  const host = `http://127.0.0.1:${mock.address().port}`
  const launchAt = async (dir) => {
    const app = await electron.launch({ args: [ROOT], env: { ...process.env, OLLMOST_USER_DATA: dir } })
    const win = await app.firstWindow()
    await win.waitForSelector('textarea', { timeout: 20000 })
    return { app, win }
  }

  // 1. Data as Kiln left it: made by the app on a seed folder, then given Kiln's names and absolute paths.
  const seed = join(home, 'seed')
  let { app, win } = await launchAt(seed)
  let conversationId = ''
  try {
    await win.evaluate((h) => window.ollmost.settings.update({ connection: { mode: 'local', host: h }, showCloudCatalog: false }), host)
    await win.evaluate(
      async (fixture) => {
        await window.ollmost.settings.setApiKey('kiln-era-key')
        await window.ollmost.mcp.save({ name: 'Tokened', command: 'node', args: [fixture], cwd: null, env: { TOKEN: 'secret' }, defaultOn: false })
      },
      join(ROOT, 'tests', 'fixtures', 'mcp-server.mjs')
    )
    await win.reload()
    await win.waitForSelector('textarea')
    await stubOpenDialog(app, [join(fixtures, 'dot.png')])
    await win.click('button[aria-label="Add"]')
    await win.getByText('Add files or photos').click()
    await win.waitForSelector('text=dot.png', { timeout: 10000 })
    await send(win, 'What is this?')
    // The title comes from a separate request once the reply has finished.
    await win.waitForFunction(() => document.body.innerText.includes('Heron picture'), null, { timeout: 15000 })
    conversationId = (await win.evaluate(() => window.ollmost.conversations.list({})))[0].id
  } finally {
    await app.close()
  }
  const kiln = join(home, 'Kiln')
  renameSync(seed, kiln)
  for (const suffix of ['', '-wal', '-shm'])
    if (existsSync(join(kiln, `ollmost.db${suffix}`))) renameSync(join(kiln, `ollmost.db${suffix}`), join(kiln, `kiln.db${suffix}`))
  const db = new DatabaseSync(join(kiln, 'kiln.db'))
  db.prepare("UPDATE attachments SET path = ? || '/' || path").run(kiln)
  db.close()
  mkdirSync(join(kiln, 'runner', 'venvs', conversationId, 'bin'), { recursive: true })
  mkdirSync(join(kiln, 'workspaces', conversationId, '.kiln', 'home'), { recursive: true })
  writeFileSync(join(kiln, 'workspaces', conversationId, '.kiln', 'home', 'saved.txt'), 'kept')

  // 2. Ollmost's first launch next to it.
  const data = join(home, 'Ollmost')
  ;({ app, win } = await launchAt(data))
  try {
    check('the Kiln folder is moved, not copied', !existsSync(kiln) && existsSync(join(data, 'ollmost.db')) && !existsSync(join(data, 'kiln.db')))
    const notice = win.locator('[data-testid="migration-notice"]')
    const text = (await notice.innerText()).replace(/\n/g, ' ')
    check('a notice says what to enter again', /Kiln is now Ollmost/.test(text) && /API key/.test(text) && /Tokened/.test(text), text.slice(0, 120))
    const after = await win.evaluate(async () => ({ settings: await window.ollmost.settings.get(), servers: await window.ollmost.mcp.list() }))
    check(
      "the API key and the server's values are asked for again",
      !after.settings.connection.hasApiKey && after.servers[0]?.missingEnv.join() === 'TOKEN',
      JSON.stringify(after.servers[0]?.missingEnv)
    )
    await win.getByText('Heron picture').first().click()
    const img = win.locator('img[src^="ollmost://attachment/"]').first()
    await img.waitFor({ timeout: 10000 })
    check('a chat from Kiln opens with its image', await img.evaluate((el) => el.complete && el.naturalWidth > 0))
    const ws = join(data, 'workspaces', conversationId)
    check(
      "Kiln's Python environments are gone, and a chat's own files kept",
      !existsSync(join(data, 'runner', 'venvs')) && readFileSync(join(ws, '.ollmost', 'home', 'saved.txt'), 'utf8') === 'kept'
    )
    await win.screenshot({ path: join(SHOTS, 'from-kiln.png') })
    await notice.getByRole('button', { name: 'Dismiss' }).click()
  } catch (err) {
    check('coming from Kiln completed without errors', false, err.message.split('\n')[0])
    await win.screenshot({ path: join(SHOTS, 'from-kiln-failure.png') }).catch(() => {})
  } finally {
    await app.close()
  }

  // 3. The notice is shown once.
  ;({ app, win } = await launchAt(data))
  try {
    await win.waitForTimeout(1000)
    check('the notice is gone once dismissed', (await win.locator('[data-testid="migration-notice"]').count()) === 0)
  } finally {
    await app.close()
    mock.close()
  }
}
```

- [ ] **Step 3: Run it**

Run: `npm run build && npm run e2e`
Expected: every check passes, including the six new ones. Look at `e2e/shots/from-kiln.png`: the notice is above the composer.

- [ ] **Step 4: Commit**

```bash
git add e2e/run.mjs
git commit -m "Test coming from Kiln end to end (#60)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Distribution: installers, README, version

**Files:**
- Modify: `scripts/install.sh`, `scripts/install-mac.mjs`, `README.md`, `package.json` and `package-lock.json` (the version)

**Interfaces:**
- Consumes: the bundle id `local.kiln.app`, and Kiln's data at `~/Library/Application Support/Kiln/kiln.db`.

- [ ] **Step 1: Edit `scripts/install.sh`**, which Task 7 already renamed to Ollmost.
  - In `main`, right after the existing block that quits Ollmost if it's running and before `rm -rf "$target"`, add:

```bash
  # Kiln was renamed Ollmost (#60). Ollmost moves Kiln's data on its first launch, which needs Kiln closed.
  if kiln_running; then
    echo "Quitting Kiln"
    osascript -e 'quit app "Kiln"' || true
    for _ in $(seq 20); do kiln_running || break; sleep 0.5; done
    if kiln_running; then fail "Kiln is still running. Quit it and run this again."; fi
  fi
```

  - After `open "$target"`, add `remove_kiln "$dir"`.
  - After the `running()` function, add:

```bash
kiln_running() { pgrep -f 'Kiln.app/Contents/MacOS/Kiln' >/dev/null; }

# Remove Kiln.app from the install folder once Ollmost has moved Kiln's data (on its first launch), and only if it
# really is Kiln, not another app with that name.
remove_kiln() {
  local old="$1/Kiln.app" data="$HOME/Library/Application Support/Kiln"
  [ -d "$old" ] || return 0
  [ "$(defaults read "$old/Contents/Info" CFBundleIdentifier 2>/dev/null)" = local.kiln.app ] || return 0
  for _ in $(seq 120); do [ -e "$data/kiln.db" ] || break; sleep 0.5; done
  if [ -e "$data/kiln.db" ]; then
    echo "Kept $old: your Kiln data hasn't moved yet. Open Ollmost, and delete Kiln.app once your chats show up."
  else
    rm -rf "$old"
    echo "Removed $old (Kiln is now Ollmost)"
  fi
}
```

  - In the header comment, after the line about the data folder, add: `# Coming from Kiln: Ollmost moves Kiln's data on its first launch, and this removes Kiln.app afterwards.`

- [ ] **Step 2: Edit `scripts/install-mac.mjs`** the same way.
  - Add this helper below `running`:

```js
// Kiln was renamed Ollmost (#60): Ollmost moves Kiln's data on its first launch, which needs Kiln closed.
const kilnRunning = () => {
  try {
    execFileSync('pgrep', ['-f', 'Kiln.app/Contents/MacOS/Kiln'])
    return true
  } catch {
    return false
  }
}
const bundleId = (app) => {
  try {
    return execFileSync('defaults', ['read', join(app, 'Contents', 'Info'), 'CFBundleIdentifier'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
```

  - Before `if (existsSync(target)) rmSync(...)`, add:

```js
if (kilnRunning()) {
  execFileSync('osascript', ['-e', 'quit app "Kiln"'])
  for (let i = 0; i < 20 && kilnRunning(); i++) execSync('sleep 0.5')
  if (kilnRunning()) throw new Error('Kiln is still running. Quit it and run this again.')
}
```

  - After `console.log(\`Installed ${target}\`)`, add:

```js
// Remove Kiln.app once Ollmost has moved Kiln's data, and only if it really is Kiln.
const oldApp = join(installDir, 'Kiln.app')
const oldDb = join(homedir(), 'Library', 'Application Support', 'Kiln', 'kiln.db')
if (existsSync(oldApp) && bundleId(oldApp) === 'local.kiln.app') {
  for (let i = 0; i < 120 && existsSync(oldDb); i++) execSync('sleep 0.5')
  if (existsSync(oldDb)) console.log(`Kept ${oldApp}: your Kiln data hasn't moved yet. Open Ollmost, and delete Kiln.app once your chats show up.`)
  else {
    rmSync(oldApp, { recursive: true, force: true })
    console.log(`Removed ${oldApp} (Kiln is now Ollmost)`)
  }
}
```

- [ ] **Step 3: README.** After the `## Install` section's content (before `## Run it from source`), add:

```md
### Coming from Kiln

Ollmost used to be called Kiln. Install Ollmost as above. On its first launch it moves your chats, projects, files and settings over from `~/Library/Application Support/Kiln`, and the installer then removes `Kiln.app`. Quit Kiln first, or Ollmost waits for it.

Two things don't carry over, because your Mac's keychain tied them to Kiln: your ollama.com API key, and your MCP servers' environment values. Ollmost asks for them again. You can delete the old "Kiln Safe Storage" item in Keychain Access. Notifications ask for permission again, and a Dock icon pinned for Kiln needs pinning again for Ollmost.
```

- [ ] **Step 4: Bump the version**

Run: `npm version 0.2.0 --no-git-tag-version`
Expected: `package.json` and `package-lock.json` say `0.2.0`.

- [ ] **Step 5: Check the scripts**

Run: `bash -n scripts/install.sh && node --check scripts/install-mac.mjs && npm run lint && npm run format:check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add scripts README.md package.json package-lock.json
git commit -m "Install Ollmost over Kiln, removing Kiln.app once its data has moved; 0.2.0 (#60)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Verify, then migrate this Mac

Steps 3 and 5 need the user. Ask them, don't assume.

- [ ] **Step 1: Run the full suite**

Run: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run e2e`
Expected: all PASS.

- [ ] **Step 2: Check what still says Kiln**

Run: `git grep -l -i kiln -- . ':!docs'`
Expected, exactly:
- `.git-blame-ignore-revs`
- `README.md`
- `e2e/run.mjs`
- `scripts/install-mac.mjs`
- `scripts/install.sh`
- `src/main/db/migrations.ts`
- `src/main/migrate.ts`
- `src/shared/migration.ts`
- `tests/migrate.test.ts`

Read the matches in `README.md` and `e2e/run.mjs`: only the "Coming from Kiln" note and the e2e section 14 may mention Kiln.

- [ ] **Step 3: Optionally, with the user watching, try the "Kiln is still open" message.** Run these, then look at the screen:

```bash
t=$(mktemp -d); mkdir -p "$t/Kiln" "$t/bin" && touch "$t/Kiln/kiln.db" && cp /bin/sleep "$t/bin/Kiln"
"$t/bin/Kiln" 60 & fake=$!; ln -s "Mac-$fake" "$t/Kiln/SingletonLock"
OLLMOST_USER_DATA="$t/Ollmost" npx electron . &
```

   Expected: a "Kiln is still open" message, and no `$t/Ollmost` folder. Then run `kill $fake`. The message closes, Ollmost relaunches, and `$t/Ollmost` exists with no `$t/Kiln`. Quit that Ollmost.

- [ ] **Step 4: Back up this Mac's Kiln data. Ask the user first.**

Run: `ditto ~/Library/"Application Support"/Kiln ~/Library/"Application Support"/Kiln-backup-$(date +%F)`
Expected: the backup folder exists, about 10 MB.

- [ ] **Step 5: Install over Kiln**

Run: `npm run install:mac`
If a "Kiln Safe Storage" keychain prompt is blocking Kiln, the user has to answer it so Kiln can quit.
Expected output ends with `Installed /Applications/Ollmost.app` and then `Removed /Applications/Kiln.app (Kiln is now Ollmost)`.
Then check:
- `~/Library/Application Support/Ollmost` exists and `…/Kiln` doesn't.
- The Dock shows the new icon.
- The chats and their 2 attachments are there.
- The notice asks for the API key. After the user re-enters it, the usage chip and web tools work.
- A code run in a chat works; its environment is rebuilt.

- [ ] **Step 6: Report, and ask before pushing.** Summarize the results for the user. Pushing the branch and opening the PR need their go-ahead. The repo rename (`EdCarney/kiln` → `EdCarney/ollmost`) and the `v0.2.0` tag are theirs to do, in the order in the spec's Part C.
