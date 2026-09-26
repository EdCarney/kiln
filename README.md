# Kiln

A desktop chat app in the style of the Claude desktop app, running on your Ollama models (cloud and local).

Features: projects (instructions + knowledge files), pinned chats and projects, searchable history, attachments (images, PDF, DOCX, XLSX, text/code), a model picker that adapts to each model's capabilities, thinking/effort controls, skills (`SKILL.md`), artifacts in a side panel, live token/cost and quota tracking, web search, and fully customisable themes.

## Install

On any Mac (Apple Silicon or Intel), without a checkout:

```sh
curl -fsSL https://raw.githubusercontent.com/EdCarney/kiln/main/scripts/install.sh | bash
```

This downloads the right build from the latest [release](https://github.com/EdCarney/kiln/releases/latest), installs it as `/Applications/Kiln.app` (quitting and replacing any older copy), and opens it. Run it again to upgrade. You'll also need the [Ollama app](https://ollama.com) running; for cloud models, run `ollama signin` once.

To install somewhere else, such as your own `~/Applications` (which doesn't need an administrator account), set `KILN_INSTALL_DIR`. The folder is created if it doesn't exist:

```sh
curl -fsSL https://raw.githubusercontent.com/EdCarney/kiln/main/scripts/install.sh | KILN_INSTALL_DIR=~/Applications bash
```

Use the same setting when you upgrade. The script only replaces the copy in the folder it installs to, so if you switch folders, delete the old `Kiln.app` yourself.

- **Why `curl`.** Kiln isn't signed with an Apple Developer ID. Browsers mark downloads as quarantined, and macOS won't open a quarantined unsigned app: it says Kiln "can't be verified" or "is damaged". `curl` doesn't add that mark. If you downloaded the `.dmg` or `.zip` from the releases page in a browser, either allow it in System Settings → Privacy & Security → Open Anyway, or run `xattr -dr com.apple.quarantine /Applications/Kiln.app`.
- **Each Mac has its own data.** Chats, projects and skills live in `~/Library/Application Support/Kiln/` and don't sync. Upgrading leaves them alone.
- **The ollama.com API key is per Mac.** It's encrypted with that Mac's Keychain, so enter it on each machine. After an upgrade, macOS may ask to let Kiln use "Kiln Safe Storage"; choose Always Allow.
- **Local Ollama is per Mac too.** Anything that goes through the Ollama app needs it installed and signed in on that machine.

## Run it from source

Requirements: macOS, Node 22+, and the [Ollama app](https://ollama.com) running. For cloud models, run `ollama signin` once.

```sh
npm install
npm run dev        # development, with hot reload
npm run build      # production bundle in out/
npm run dist       # Kiln-arm64/x64 .dmg and .zip in dist/  (or: npx electron-builder --mac --dir  for just the .app)
npm run install:mac  # build, then install/replace /Applications/Kiln.app and open it (KILN_INSTALL_DIR to change the folder)
```

Your data lives in `~/Library/Application Support/Kiln/`: a SQLite database (`kiln.db`), uploaded files, and your own skills (`skills/`).

## How it works

```
src/main/        Electron main process: SQLite (node:sqlite), Ollama client, prompt assembly,
                 streaming + tool loop, file extraction, skills library, artifact:// and kiln:// protocols
src/preload/     typed contextBridge exposing window.kiln (contract in src/shared/ipc.ts); main answers
                 only Kiln's own windows (src/main/ipcSender.ts)
src/shared/      types, artifact parser, thinking profiles, built-in themes (used by both sides)
src/renderer/    React UI: views/, components/, stores/ (zustand), theme/
tests/           Vitest unit tests      e2e/   live Playwright run against real models
```

- **Models.** The local daemon's `/api/tags` is merged with the ollama.com catalog. Cloud models are addressed as `name:cloud` / `name:tag-cloud`, so nothing needs pulling. `/api/show` capabilities drive the UI: the image warning, the thinking control, and automatic skills.
- **Thinking.** `src/shared/thinking.ts` maps each model family to a profile, based on probing the models:
  - gpt-oss: effort levels only; it can't be turned off.
  - glm: always on, because `think:false` leaks its reasoning into the reply.
  - Other models: an on/off toggle.

  You can override the profile per model in Settings → Models.
- **Artifacts.** The model writes `<artifact identifier type title language>` tags; `src/shared/artifactParser.ts` turns them into cards and panel content.
  - HTML and SVG render in a sandboxed iframe (`artifact://`) with no same-origin access and `connect-src 'none'`. Scripts from cdnjs, jsDelivr and unpkg are allowed; you can turn that off in Settings.
  - An updated artifact is saved as a new version, since the model rewrites it in full each time.
  - Any code block of 15+ lines can be promoted with "Open as artifact".
- **Skills.** Kiln reads `SKILL.md` folders from three places:
  - Its own `skills/` folder, which you can edit.
  - `~/.ollama/skills`, read-only.
  - `~/.claude/skills`, read-only. These start off, because many rely on Claude-only tools.

  A skill you pick with `/` or the + menu applies to every reply. Models that support tools can also call `load_skill` on their own; a skill loaded that way stays loaded for the rest of the chat.
- **Web search.** When an ollama.com API key is saved (Settings → Usage & cost), models that support tools get `web_search` and `web_fetch`. These call Ollama's web API, so pages are fetched by ollama.com and not your Mac. Searches count toward your Ollama usage.
  - The key stays in the main process and never enters a prompt.
  - Web content is marked as untrusted data, so the model is told not to follow instructions found in pages.
  - Every search and page read shows as a badge in the reply, at the point where the model made it. Click a page badge to open it in your browser.
  - gpt-oss-style names (`browser.open`, `web.run`, …) are routed to the real tools, but only when no offered tool has that name. Tools come from providers registered in `src/main/chat/tools.ts` (skills and web today), and an exact name always wins over an alias.
  - Tools a model invents get one explanation, then they're withdrawn so the turn still ends with an answer.
  - A reply gets up to 6 tool rounds. If the model is still using tools after that, it has to answer with what it found, and the reply offers Continue.
  - Every tool result is capped at 24,000 characters. When a turn's results outgrow the context window, older ones from that turn are cut to a one-line note and the newest stay whole; the reply's stats say so. The check uses Ollama's own token count for the previous request when that's higher than Kiln's estimate.
- **MCP servers.** Add local (stdio) MCP servers in Settings → Tools: a name, the command and arguments from the server's README, and any environment variables it needs. Kiln starts a server when a chat that uses it opens, and gives it your login shell's PATH, so `npx`, `uvx` and `docker` are found even when Kiln was opened from the Dock.
  - Servers are switched on per chat, from the + menu under **Tools**, because every tool definition is sent with every request. New chats start with the servers marked "Use in new chats". Tool definitions count toward the context budget.
  - Tools are offered as `<server>__<tool>`. Each call asks first (below), and a chat with servers on gets up to 12 tool rounds.
  - Environment values are encrypted with the macOS keychain and never sent to the renderer. Servers run with your permissions and aren't sandboxed: add only ones you trust.
  - A server that can't start, or stops, shows why in Settings → Tools, with its stderr log. A reply that couldn't use one of its chat's servers says so.
  - Kiln talks to servers through its own stdio transport (`src/main/mcp/transport.ts`), so stopping a server also stops what it started (`npx` runs the real server as a child).
- **Approving tool calls.** A tool whose provider asks first (MCP tools do; skills and web search never ask) waits in the reply with an approval card: **Allow once**, **Allow for this chat** or **Deny**.
  - A denied call doesn't run, and the model is told not to try it again unless you ask. Stopping the reply, deleting the chat or quitting counts as a no, and a call that was waiting when Kiln closed shows as not run.
  - A chat you aren't looking at gets a hand icon in the sidebar and a toast, and the Dock icon shows how many calls are waiting.
  - Processes Kiln starts run in their own process group (`src/main/processes.ts`), so stopping one also stops anything it started, and quitting stops them all.
- **Links.** Hovering a link in a reply shows a card with its destination: site, full URL, and whether it opens in your browser. It warns when the link text names a different domain than the real destination.
  - An opt-in setting (Settings → Web, artifacts & skills) adds the page's title, description and image, fetched from your Mac.
  - Local-network and loopback addresses are never fetched, including after redirects.
- **Debugger.** The bug icon in a chat's header, or ⌘⇧D, opens a separate **Kiln Debugger** window. It shows every request the chat made (each chat round, tool call and title) live, grouped by turn. For each request:
  - **Overview:** timings (first byte, first token, total, plus Ollama's own load/prompt/generation times when reported), prompt tokens counted by Ollama vs Kiln's estimate, cost, `done_reason`, and stream chunk count.
  - **Prompt anatomy:** where the tokens go (system sections, history, this turn, tool definitions, images), a context-window meter, and every message readable.
  - **Request, Response, Tools:** the exact JSON sent (image bytes replaced by size placeholders; API keys are never recorded), the output with thinking and tool calls, Ollama's final stats, and the tool schemas offered.
  - **Replay:** edit the recorded request and resend it without streaming, like a playground. It's recorded as a replay and counted as usage.

  The debugger can also copy a request as `curl` (keys appear as `$OLLAMA_API_KEY`), export traces as JSON, and open Chromium DevTools. Traces are stored locally, deleted with their chat, and capped at the newest 500. Turn recording off under Settings → Data.
- **Usage & cost.** The title bar shows two chips.
  - **This chat:** tokens and estimated cost so far, including retries and title generation. Click it for a per-model breakdown and how full the context window is.
  - **Your Ollama quota:** % used, and time left until the next reset. Its mini bar also marks how much of the period has passed.

  Details:
  - Costs use Ollama's published per-token prices. Kiln re-reads them daily from ollama.com/pricing and falls back to a bundled snapshot. Each request is also logged locally (`usage_events`) for Settings → Usage & cost.
  - Quota comes from `ollama.com/api/usage`, which is undocumented and **needs an ollama.com API key** (Settings → Usage & cost). The Ollama app's sign-in doesn't cover it.
  - That endpoint doesn't say when limits reset. Kiln dates a reset itself when it sees usage drop, or you can enter the time shown on ollama.com/settings.
- **Theming.** Every colour, font and radius is a CSS variable (`src/renderer/src/index.css`), and code highlighting, Mermaid diagrams and the debugger window all take their colours from the active theme. Themes are JSON with a light and a dark palette (or a single palette, marked `only`); you can edit, import and export them from Settings → Appearance. Built in: Clay, Nord, Solarized, Gruvbox, High contrast, Catppuccin (Latte/Mocha), GitHub, Dracula (with Alucard), Rosé Pine (with Dawn) and Hack (dark only, in the Hack typeface).
- **Theme legibility.** `tests/themes.test.ts` checks every built-in palette against WCAG contrast floors: 7:1 for body text on the canvas, 4.5:1 for other text, 3:1 for hints, links, status colours, button labels and syntax colours. Where a theme's published colour falls short (usually an accent on a pale light-mode background), only its lightness is adjusted, and the theme's comment in `src/shared/themes.ts` says which colours moved.

## Tests

```sh
npm test                    # unit: parsing, prompt assembly, file extraction, and the chat loop against a mock Ollama
npm run typecheck
npm run lint                # ESLint (typescript-eslint, React hook rules)
npm run format              # Prettier; format:check only reports
npm run build && npm run e2e   # live: needs Ollama running; uses a throwaway data folder
```

`npm test` needs no Ollama: `tests/ollamaMock.ts` is a stand-in daemon that streams scripted NDJSON. The client and reply-loop tests use it to cover split lines, dropped and stalled streams, error chunks, Stop, tool rounds and saving partial replies. CI (`.github/workflows/ci.yml`) runs the typecheck, lint, format check and unit tests on every pull request.

The e2e run checks:
- streaming and auto-titles
- the artifact sandbox, which blocks network requests and access to the app
- manual and automatic skills
- vision attachments
- project knowledge
- theme persistence

Screenshots go to `e2e/shots/`. Set `KILN_DEBUG=1` to log every request Kiln sends to Ollama to `debug.log` in the data folder, along with the PATH Kiln gives processes it starts. Apps opened from the Dock get a bare PATH, so Kiln reads the one your login shell sets up.

## Releasing

1. Bump `version` in `package.json` and merge it to `main`.
2. Tag that commit and push the tag:
   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```

`.github/workflows/release.yml` then runs on a macOS runner. It checks the tag matches `package.json`, runs the typecheck and unit tests, builds, and creates the GitHub Release with `Kiln-arm64.zip`, `Kiln-x64.zip` and the matching `.dmg`s. The file names don't change between versions, so `releases/latest/download/Kiln-arm64.zip` (which the install script uses) always points at the newest build.

Builds are signed ad hoc (`identity: '-'` in `electron-builder.yml`), which is enough for Apple Silicon to run them but not for Gatekeeper to trust a browser download. Signing with a Developer ID and notarizing would remove the browser warning and allow auto-updates with `electron-updater`, but needs the paid Apple Developer Program.

## Known limits (deliberately deferred)

- **Web pages go through ollama.com.** Kiln can't browse local-network pages or sites behind a login.
- **Web content can try prompt injection.** It's marked as untrusted and every fetch is visible, but a determined page could still steer a model's answer. Treat web-sourced answers with the usual care.
- **Skills can't run scripts.** Skills like docx/pptx/xlsx/pdf get their instructions only. The model is told to produce results directly. Running scripts needs a sandboxed code runner.
- **Automatic skill loading depends on the model.** In testing, gpt-oss loaded a clearly matching skill 80–100% of the time. Picking a skill with `/` always works.
- **React artifacts aren't rendered.** They're shown as JSX source.
- **Scanned PDFs have no text layer.** They're flagged, but there's no OCR.
- **Large projects aren't searched.** Project knowledge goes straight into the context window, with a capacity meter. There's no retrieval for oversized projects.
- **Costs are estimates.** All input is priced at the full rate; Ollama doesn't report cached tokens or apply off-peak rates per request. Quota reset times are inferred unless you set them.
- **Edits don't keep branches.** Editing a message replaces everything after it; the database has room for branch navigation later.
