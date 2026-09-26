# Rename Kiln to Ollmost (#60): design

- **Issue:** [#60](https://github.com/EdCarney/kiln/issues/60). The design decisions are recorded in its comments.
- **Branch:** `claude/ollmost`. The new mark and app icon are already on it (`08a019b`).
- **Status:** draft for review, 2026-09-26.

## Goal

Kiln becomes **Ollmost**, as a clean slate in identity: a new name, bundle id, keychain entry, repo and internal names. Everything the user made carries over: chats, projects, files, artifacts, skills, themes and settings.

After this change, installing Ollmost over an existing Kiln should do the following:

- The data folder moves from `~/Library/Application Support/Kiln` to `…/Ollmost`, and Ollmost opens with every chat, project, attachment (images render), artifact, skill, theme and setting in place.
- A one-time notice explains the only things that didn't carry over: the ollama.com API key, and the values of MCP servers' environment variables. The macOS keychain ties those to the old app. Settings asks for them again.
- Code runs work. Each chat's Python environment is rebuilt on its next run.
- `Kiln.app` is removed by the installer once the data has moved.
- Nothing in the repo says "Kiln" any more, except the migration code, its tests and history.

## Decisions already made (on #60)

1. **Secrets:** the user re-enters them. Ollmost never reads the "Kiln Safe Storage" keychain entry.
2. **Names:** everything is renamed, internal names included (`window.kiln`, `kiln://`, CSS, `KILN_*` with no fallbacks, `kiln.db`).
3. **Stored paths:** absolute paths in `attachments.path` and `project_files.path` are rewritten, and stored relative to the data folder from now on.
4. **The data folder is moved, not copied.** If Kiln is running, Ollmost waits for it to quit.
5. **Python environments** under `runner/` are deleted and rebuilt on the next run.
6. **Bundle id:** `local.kiln.app` becomes `local.ollmost.app`.
7. **Repo:** `EdCarney/kiln` is renamed `EdCarney/ollmost` in the same release. `install.sh` removes `Kiln.app` after the data has moved.

## Part A: the rename

This is a mechanical change: one commit, listed in `.git-blame-ignore-revs`.

| What | Kiln | Ollmost |
| --- | --- | --- |
| App name (`productName`, `app.setName`) | Kiln | Ollmost |
| npm package name | `kiln` | `ollmost` |
| Bundle id | `local.kiln.app` | `local.ollmost.app` |
| Data folder (follows the app name) | `…/Application Support/Kiln` | `…/Application Support/Ollmost` |
| Database | `kiln.db` | `ollmost.db` |
| Keychain entry (Electron names it after the app) | Kiln Safe Storage | Ollmost Safe Storage |
| Release assets (`${productName}-${arch}`) | `Kiln-arm64.zip`, … | `Ollmost-arm64.zip`, … |
| Repo | `EdCarney/kiln` | `EdCarney/ollmost` |
| URL scheme, and `kiln:` in the CSP | `kiln://` | `ollmost://` |
| Renderer bridge | `window.kiln`, `KilnApi` | `window.ollmost`, `OllmostApi` |
| Environment variables, no fallbacks | `KILN_USER_DATA`, `KILN_DEBUG`, `KILN_WEB_URL`, `KILN_USAGE_URL`, `KILN_ALLOW_PRIVATE_PREVIEWS`, `KILN_CLAUDE_DESKTOP_CONFIG`, `KILN_CLAUDE_CODE_CONFIG`, `KILN_INSTALL_DIR` | `OLLMOST_*` |
| Login-shell marker in `env.ts` | `__KILN_ENV__` | `__OLLMOST_ENV__` |
| Hidden folder in each chat's workspace (run `HOME`, `TMPDIR`, pin) | `.kiln` (`KILN_DIR`) | `.ollmost` (`OLLMOST_DIR`) |
| CSS | `kiln-shimmer`, `kiln-pulse`, `rounded-kiln`, `--k-*` | `ollmost-shimmer`, `ollmost-pulse`, `rounded-ollmost`, `--o-*` |
| Quarantine agent on files a run wrote | `Kiln` | `Ollmost` |
| Link preview user agent | `KilnLinkPreview/1.0` | `OllmostLinkPreview/1.0` |
| Vite plugin | `kiln-inject-csp` | `ollmost-inject-csp` |
| UI strings, system prompt, window titles, `index.html`, log prefixes (`Kiln: …`) | Kiln | Ollmost |
| MCP test fixtures | `kiln-fixture`, `kiln-no-such-server` | `ollmost-fixture`, `ollmost-no-such-server` |
| e2e temp folders | `kiln-e2e-*` | `ollmost-e2e-*` |

**Not affected**
- **IPC channels.** They are named `group:method`, with no app name in them; the issue's example `kiln.settings.update` is out of date.
- **Themes.** Stored themes hold palette keys (`canvas`, `lineStrong`), not CSS variable names, so `--k-*` → `--o-*` is a code-only change.
- **localStorage.** The renderer uses none, and it loads from `file://`, so no web storage is keyed to the old scheme.

## Part B: the migration

### B1. Where it runs

The move must happen before anything creates the new folder. Chromium creates the data folder as soon as `requestSingleInstanceLock()` runs, and after that Ollmost would see a folder and skip the migration. So the migration has two phases: a synchronous move at the very top of `src/main/index.ts`, and the finishing work once the folder is in place.

```
app.setName('Ollmost')
if (OLLMOST_USER_DATA) app.setPath('userData', …)
const move = moveKilnData()                  // Phase 1, synchronous (src/main/migrate.ts)
if (move.state === 'kiln-running') app.setPath('userData', <tmpdir>/Ollmost-waiting)
registerSchemes(); requestSingleInstanceLock()
whenReady:
  'kiln-running' → waitForKiln()             // dialog, then relaunch
  'failed'       → error dialog, quit        // Kiln's data untouched
  initPaths()
  renameDatabase()                           // Phase 2a: before the database opens
  trackProcesses(); openDatabase()           // SQL migration: relative paths, trace labels
  finishMigration()                          // Phase 2b: secrets, runner folders, notice
  …the rest of startup as today
```

The old folder is always looked for **next to** the data folder: `dirname(userData)/Kiln`. In production that is `~/Library/Application Support/Kiln`. Tests get the same code path by pointing `OLLMOST_USER_DATA` at `<tmp>/Ollmost` and putting a Kiln-shaped folder at `<tmp>/Kiln`, with no test-only switches. The folder only counts if it contains `kiln.db`.

### B2. Phase 1: moving the folder

Here `T` is the Ollmost data folder and `S` is the Kiln folder next to it.

| `T` exists | `S` has `kiln.db` | Kiln running | What happens |
| --- | --- | --- | --- |
| yes | any | any | No move. Phase 2 checks `T` for unfinished work. |
| no | no | any | Nothing to migrate (a fresh install). |
| no | yes | yes | Wait for Kiln, as below. |
| no | yes | no | `renameSync(S, T)`, then delete `T/Singleton*`, then write `T/.migrating-from-kiln`. |

**Is Kiln running?** Kiln always holds Chromium's singleton lock, a symlink `S/SingletonLock` pointing to `<host>-<pid>` (for example `Mac-7262`). Kiln counts as running when that pid is alive and its executable (`ps -o comm=`) ends in `/Kiln`, or in `/Electron` for a development Kiln. If the lock is missing or stale (the pid is dead or belongs to another program), Kiln isn't running.

**Waiting for Kiln.** This session uses a throwaway data folder, `<tmpdir>/Ollmost-waiting`, so it never creates `T`. A fixed name means a second launch still hands off to the waiting instance. Once Electron is ready, Ollmost shows a message box:

> **Kiln is still open**
> Quit Kiln to move your chats, projects and settings to Ollmost. Ollmost will carry on by itself once Kiln has quit.
> [Quit Ollmost]

Ollmost checks the lock every 500 ms. When Kiln has quit, it closes the box (`showMessageBox`'s `signal`), then calls `app.relaunch()` and `app.exit(0)`. The relaunch finds Kiln gone and moves the folder. Ollmost doesn't quit Kiln itself: sending Kiln an Apple event would trigger a macOS Automation permission prompt.

**If the move fails** (for example with a permissions error), Ollmost shows "Ollmost couldn't move your Kiln data: <error>. Nothing was changed; Kiln still has all of it." and quits before creating `T`. A later launch tries again.

**What moves with the folder:** Chromium's caches, `processes.json`, `debug.log`, `files/`, `skills/`, `workspaces/` and `runner/`. The stale `Singleton*` links are deleted, because they belong to Kiln's last session.

### B3. Phase 2: finishing inside the folder

Phase 2 runs when `T/.migrating-from-kiln` exists, or when `T/kiln.db` exists and the app's own database is no longer called `kiln.db`. The second condition covers a crash between the move and writing the marker. Checking the database's name keeps Phase 2 from running while the app is still called Kiln (commit 2 below): then `T/kiln.db` is simply the live database. Every step is idempotent, so a crash at any point simply repeats the unfinished steps on the next launch. The marker is deleted last.

1. **Database file (2a, before it opens).** Rename `kiln.db-wal` and `kiln.db-shm` first, then `kiln.db`, each to its `ollmost.db` name, skipping any that don't exist.
   - The order matters. SQLite finds the WAL by the database's name, and a crash between renames must never leave `ollmost.db` next to an orphaned `kiln.db-wal`: that would drop transactions not yet checkpointed.
   - If both `kiln.db` and `ollmost.db` exist, nothing is renamed: Ollmost opens `ollmost.db`, leaves `kiln.db` where it is, and logs the problem.
2. **SQL migration (runs for every database, migrated or not).** This is a new entry in `MIGRATIONS`:
   ```sql
   -- File paths relative to the data folder: files/<name> (every stored file lives in files/).
   UPDATE attachments SET path = 'files/' || replace(path, rtrim(path, replace(path, '/', '')), '') WHERE path LIKE '/%';
   UPDATE project_files SET path = 'files/' || replace(path, rtrim(path, replace(path, '/', '')), '') WHERE path LIKE '/%';
   -- The debugger's recorded endpoints for built-in tools.
   UPDATE traces SET data = replace(data, '"endpoint":"kiln://', '"endpoint":"ollmost://') WHERE data LIKE '%"endpoint":"kiln://%';
   ```
   The `rtrim`/`replace` expression is SQLite's basename idiom. It works whatever folder the old paths pointed into: this Mac's database has 2 attachments, both under `…/Kiln/files/`.
3. **Secrets (2b).**
   - First, in one transaction, record what needs re-entering as `migratedFromKiln = { at, apiKey, servers, dismissed: false }`.
     - `apiKey` is true when an encrypted key was stored.
     - `servers` lists the ids of MCP servers that have environment values.
   - In the same transaction, delete the `apiKey` setting and set each of those servers' `env` to null, keeping its `envKeys`.
   - Because the record and the deletion commit together, a rerun can never record "nothing to re-enter" after the secrets are gone.
   - A rerun keeps an existing record as it is.
   - The secrets are cleared rather than left to fail decryption later. With the wrong key, AES-CBC padding still checks out about 1 time in 256, and `getApiKey()` would then hand ollama.com a garbage key.
4. **Runner folders (2b).**
   - Delete `runner/base-venv`, `runner/venvs` and `runner/venv`; they're rebuilt on the next run. `rm` removes links without following them, so a link that code planted in a chat's environment can't redirect the delete.
   - In each `workspaces/<id>`, rename `.kiln` to `.ollmost`. This keeps the run's `HOME`, where code may have saved configuration. If `.ollmost` already exists, `.kiln` is removed instead.
   - `rename` acts on the entry itself, so if code swapped `.kiln` for a link, the link is what gets moved. `prepareWorkspace` already replaces a link with a folder where it expects one.
   - `runner/scripts` is kept. `runner/previews` is already cleared at every start.
5. **Delete `T/.migrating-from-kiln`.**

### B4. Stored paths are relative from now on

- `paths.ts` gains two helpers:
  - `toStored(abs)`: the path relative to `paths.data`. It throws for a path outside the data folder.
  - `fromStored(rel)`: `join(paths.data, rel)`.
- The database layer converts in both directions:
  - `insertAttachment` and `insertProjectFile` store relative paths.
  - Every query that returns a path resolves it:
    - `getAttachmentRow` and `attachmentRowsFor*`
    - the path lists in `conversations.ts` (chat deletion, edits, pending uploads, stale uploads)
    - the path lists in `projects.ts`
- Callers keep receiving absolute paths: `protocols.ts`, `chat/service.ts`, `runner/workspace.ts` and `removeFiles`.
- The renderer never sees these paths (`toAttachment` leaves them out), so it doesn't change.

### B5. MCP servers whose values can't be read

This covers decision 1 for the migration, and for any later keychain loss.

- **One rule:** a server is **locked** when any of its `envKeys` has no readable value.
  - `decryptEnv` returns null on failure instead of today's silent `{}`, so a server can never start without its token.
  - The migration's `env = null` makes the same state.
- **The manager doesn't start a locked server.** Its status is an error: "Ollmost couldn't read this server's environment values. Enter them again in Settings → Tools." Its tools aren't offered to chats.
- **Settings → Tools** shows the missing variable names on the server, with value fields.
  - `saveServer` on a locked server requires a value, or an explicit removal, for every missing key. It says which keys are still missing.
  - Saving all of them unlocks the server.

### B6. The one-time notice

- `app.migrationNotice()` returns the `migratedFromKiln` record while it isn't dismissed, and null otherwise. `app.dismissMigrationNotice()` sets `dismissed`.
- The home screen shows it once, in the same panel style as the "can't find any models" warning:
  > **Kiln is now Ollmost.** Your chats, projects, files and settings came along.
  > Your ollama.com API key didn't: it was locked to Kiln in your keychain. Enter it again in Settings. [Open Settings]
  > 2 MCP servers need their environment values again: GitHub, Linear. [Open Tools]
  > [Dismiss]
- The API key line and the MCP servers line appear only when they apply. Server names are looked up when the notice is shown.

### B7. Security: code Kiln left running

Before it quits, Kiln stops code it started, and the `processes.json` groups are stopped at the next start. A process left over from a crash of Kiln would still carry a sandbox policy for `…/Kiln/…` paths.

Seatbelt checks the path an access resolves to at the moment of the access, so once the folder is renamed, such a process can't write the moved folders, even through a working directory or a file it opened earlier. This is expected, not assumed: a sandbox test verifies it (see Testing).

The reaper also won't recognise these processes, since its fingerprint uses the new paths. The spec accepts that, because they can't write anything of Ollmost's.

### B8. What's left behind

- The "Kiln Safe Storage" keychain item. It's harmless; the release notes say it can be deleted in Keychain Access.
- Anything macOS keeps per app: `~/Library/Preferences/local.kiln.app.plist`, `~/Library/Saved Application State/local.kiln.app.savedState`, and caches or logs under the Kiln name if any exist.
- Kiln's Dock pin, which shows a question mark once `Kiln.app` is gone. The notification permission is asked again, since the bundle id is new.
- **No downgrade.** Opening an old `Kiln.app` after the move starts empty; the data is in `Ollmost/`.

## Part C: distribution

- **`electron-builder.yml`:** `appId: local.ollmost.app`, `productName: Ollmost`. The artifact names follow `${productName}`.
- **`release.yml`:** release title `Ollmost <version>`, assets `Ollmost-{arm64,x64}.{zip,dmg}`.
- **`install.sh`**, with `REPO=EdCarney/ollmost` and `OLLMOST_INSTALL_DIR`:
  1. Download `Ollmost-<arch>.zip` and check it contains `Ollmost.app`.
  2. Quit Ollmost if it's running, as today. Then quit Kiln (`osascript -e 'quit app "Kiln"'`); if Kiln won't quit, stop with "Quit Kiln and run this again". Quitting Kiln first means Ollmost can move the data straight away.
  3. Install `Ollmost.app` and open it.
  4. If `$dir/Kiln.app` exists **and** its `CFBundleIdentifier` is `local.kiln.app`, so another app called Kiln is never deleted:
     - Wait up to 60 s for the move: `~/Library/Application Support/Kiln/kiln.db` gone, or never there.
     - Then remove `Kiln.app` and say so.
     - If the data hasn't moved, keep `Kiln.app` and say why: "Open Ollmost, and delete Kiln.app once your chats show up."
- **`install-mac.mjs`** (`npm run install:mac`) follows the same order for the local build: quit Kiln and Ollmost, install `Ollmost.app`, open it, wait for the move, then remove `$OLLMOST_INSTALL_DIR/Kiln.app` if its bundle id matches.
- **README:** the new name, the install URL `raw.githubusercontent.com/EdCarney/ollmost/main/scripts/install.sh`, the data folder, `OLLMOST_*`, and a short "Coming from Kiln" note.
- **Version:** `0.1.0` → `0.2.0`.

**Release order.** The repo rename is outward-facing, so it's done by, or with the go-ahead of, the repo owner.
1. Review and approve the PR.
2. Rename the repo on GitHub. Update the local remote with `git remote set-url origin …/ollmost.git`.
3. Merge.
4. Tag `v0.2.0`. The release job publishes the `Ollmost-*` assets.
5. On this Mac, run the new `install.sh` (or `install:mac`).

The new `install.sh` downloads from `EdCarney/ollmost`, so the repo rename must come before the tag. GitHub redirects the old `raw.githubusercontent.com/EdCarney/kiln/...` URL to the renamed repo, which serves the new script. That's a convenience; nothing depends on it.

## Commit plan

Every commit leaves a working app. **In particular, no commit ever launches with the new name before the migration code exists.** A launch like that would create an empty `Ollmost/` folder, and the migration would then skip the move.

1. `08a019b`: mark and app icon (done).
2. **Migration and relative paths.** This adds `migrate.ts`, the phase 1 and phase 2 hooks, `toStored`/`fromStored`, the SQL migration, locked MCP servers and the notice. Everything is keyed on the current name, so it's a no-op while the app is still called Kiln (`S` and `T` are the same folder), and it gets its tests.
3. **The mechanical rename (Part A).** From this commit on, the migration moves the folder. This commit is listed in `.git-blame-ignore-revs`, which a small follow-up commit adds once the hash exists.
4. **Distribution.** `install.sh`, `install-mac.mjs`, `release.yml`, the README and the version bump.

## Testing

**Unit tests (vitest, `tests/migrate.test.ts`), with temporary folders:**
- **Phase 1:**
  - Each row of the B2 table.
  - A live lock (a child process's pid, with the "is it Kiln" check injected) means waiting; a stale lock means moving.
  - `Singleton*` links are removed after the move, and the marker is written.
  - A failed rename leaves `S` untouched and doesn't create `T`.
- **Phase 2a:**
  - A WAL-mode database with transactions not yet checkpointed is renamed and opened with no rows lost.
  - A crash after renaming the sidecars (the main file still `kiln.db`) resumes correctly.
  - When both files exist, nothing is renamed.
- **SQL migration:**
  - Absolute paths become `files/<name>`, and relative ones are untouched.
  - Every row the database layer returns has an absolute path under the current data folder.
  - `toStored` refuses a path outside it.
  - Trace endpoints are relabelled.
- **Phase 2b:**
  - The record and the secret deletion are atomic, and a rerun keeps the original record.
  - The environments are deleted.
  - `.kiln` becomes `.ollmost`, including when `.kiln` is a link, which is moved and not followed. When `.ollmost` already exists, `.kiln` is removed.
  - The marker goes last, and a second run is a no-op.
- **Locked MCP servers** (with `safeStorage` mocked, as `tests/mcp.test.ts` already does):
  - A decryption failure locks the server, and the manager refuses to start it.
  - Saving only some of the missing values is refused, and saving all of them unlocks it.

**Sandbox test (the existing macOS Seatbelt suite):**
- A sandboxed process allowed to write folder A stays in A.
- The test renames A to B.
- The process's write into B, through its working directory, is denied.
- This checks the claim in B7.

**e2e (`e2e/run.mjs`), with a new "comes from Kiln" scenario:**
1. Launch with `OLLMOST_USER_DATA=<tmp>/seed`, make a chat with an image attachment and a project file, then quit.
2. Rename `seed` to `<tmp>/Kiln`, and `ollmost.db` (with its `-wal` and `-shm`) to `kiln.db`, and make the paths absolute with `sqlite3`, the way Kiln stored them.
3. Launch with `OLLMOST_USER_DATA=<tmp>/Ollmost`, then check:
   - the chat and project are there
   - the image renders
   - the notice shows
   - `<tmp>/Kiln` is gone
   - a code run works, with its environment rebuilt

**Before merging:**
- `git grep -i kiln` finds only the migration code and its tests, the installers' `Kiln.app` cleanup, the README's "Coming from Kiln" note, and this spec.
- A full `install:mac` on this Mac, as in the rollout below.

## Rollout on this Mac

The first `install:mac` after commit 3 migrates the real data (9.8 MB today). Beforehand, with the user's go-ahead, copy it: `ditto ~/Library/"Application Support"/Kiln ~/Library/"Application Support"/Kiln-backup-2026-09-26`.

Kiln must be able to quit. With ad-hoc signed builds, a pending "Kiln Safe Storage" keychain prompt blocks quitting until it's answered.

After installing, check:
- `Kiln/` is gone and `Ollmost/` is there
- the chats and the 2 attachments are there
- the notice asks for the API key
- after re-entering the key, the usage chip and web tools work
- `Kiln.app` is removed
- the Dock shows the new icon

## Out of scope

- Auto-update, and Developer ID signing and notarization.
- Deleting the old keychain item or the per-app files listed in B8.
- Migrating a Kiln that was run with a custom data folder (`KILN_USER_DATA`): that was only ever used by tests.
- Other platforms. Kiln is macOS-only.
