# Kiln

A desktop chat app in the style of the Claude desktop app, running on your Ollama models (cloud and local).

Features: projects (instructions + knowledge files), pinned chats and projects, searchable history, attachments (images, PDF, DOCX, XLSX, text/code), a model picker that adapts to each model's capabilities, thinking/effort controls, skills (`SKILL.md`), artifacts in a side panel, live token/cost and quota tracking, web search, and fully customisable themes.

## Run it

Requirements: macOS, Node 22+, and the [Ollama app](https://ollama.com) running. For cloud models, run `ollama signin` once.

```sh
npm install
npm run dev        # development, with hot reload
npm run build      # production bundle in out/
npm run dist       # Kiln.dmg in dist/  (or: npx electron-builder --mac --dir  for just the .app)
```

Your data lives in `~/Library/Application Support/Kiln/`: a SQLite database (`kiln.db`), uploaded files, and your own skills (`skills/`).

## How it works

```
src/main/        Electron main process: SQLite (node:sqlite), Ollama client, prompt assembly,
                 streaming + tool loop, file extraction, skills library, artifact:// and kiln:// protocols
src/preload/     typed contextBridge exposing window.kiln (contract in src/shared/ipc.ts)
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
  - Every search and page read shows as a badge in the chat. Click a page badge to open it in your browser.
  - gpt-oss-style names (`browser.open`, `web.run`, …) are routed to the real tools.
  - Tools a model invents get one explanation, then they're withdrawn so the turn still ends with an answer.
- **Usage & cost.** The title bar shows two chips.
  - **This chat:** tokens and estimated cost so far, including retries and title generation. Click it for a per-model breakdown and how full the context window is.
  - **Your Ollama quota:** % used, and time left until the next reset. Its mini bar also marks how much of the period has passed.

  Details:
  - Costs use Ollama's published per-token prices. Kiln re-reads them daily from ollama.com/pricing and falls back to a bundled snapshot. Each request is also logged locally (`usage_events`) for Settings → Usage & cost.
  - Quota comes from `ollama.com/api/usage`, which is undocumented and **needs an ollama.com API key** (Settings → Usage & cost). The Ollama app's sign-in doesn't cover it.
  - That endpoint doesn't say when limits reset. Kiln dates a reset itself when it sees usage drop, or you can enter the time shown on ollama.com/settings.
- **Theming.** Every colour, font and radius is a CSS variable (`src/renderer/src/index.css`). Themes are JSON with a light and a dark palette; you can edit, import and export them from Settings → Appearance.

## Tests

```sh
npm test                    # unit: artifact parser, thinking profiles, prompt assembly, file extraction
npm run typecheck
npm run build && npm run e2e   # live: needs Ollama running; uses a throwaway data folder
```

The e2e run checks:
- streaming and auto-titles
- the artifact sandbox, which blocks network requests and access to the app
- manual and automatic skills
- vision attachments
- project knowledge
- theme persistence

Screenshots go to `e2e/shots/`. Set `KILN_DEBUG=1` to log every request Kiln sends to Ollama to `debug.log` in the data folder.

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
