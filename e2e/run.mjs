// Live end-to-end smoke test: drives the built app with Playwright against real Ollama models.
// Usage: npm run build && npm run e2e   (needs the Ollama app running and `ollama signin` for cloud models)
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'e2e', 'shots')
const CHAT_MODEL = process.env.KILN_E2E_MODEL ?? 'gpt-oss:120b'
const VISION_MODEL = process.env.KILN_E2E_VISION_MODEL ?? 'kimi-k3'
mkdirSync(SHOTS, { recursive: true })

const userData = mkdtempSync(join(tmpdir(), 'kiln-e2e-'))
const fixtures = mkdtempSync(join(tmpdir(), 'kiln-fixtures-'))

// A skill the model should use both when chosen with / and when it loads it on its own.
mkdirSync(join(userData, 'skills', 'haiku-helper'), { recursive: true })
writeFileSync(
  join(userData, 'skills', 'haiku-helper', 'SKILL.md'),
  `---
name: haiku-helper
description: Write poems as a single haiku. Use whenever the user asks for a poem, verse or haiku.
---

# Haiku helper

Answer with exactly one haiku (three lines, 5-7-5 syllables).
After the haiku, on its own line, sign it exactly: — Kiln Poetry Desk
`
)
writeFileSync(join(fixtures, 'brief.txt'), 'Project brief. The internal codename for this project is BLUE HERON. Launch is planned for March.')

// Stand-in for ollama.com/api/usage (undocumented): weekly usage 40%, then a drop that looks like a reset.
let mockWeekly = 0.4
let mockAuth = ''
const usageServer = createServer((req, res) => {
  mockAuth = req.headers.authorization ?? ''
  if (!mockAuth.startsWith('Bearer ')) return res.writeHead(401).end()
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      activity: { cost: '3.21000', models: [], period: { type: 'last_4_weeks', starting_at: '2026-08-26T00:00:00Z', ending_at: '2026-09-23T00:00:00Z' } },
      limits: { session: { usage: 0.05, models: [] }, weekly: { usage: mockWeekly, models: [] } }
    })
  )
})
await new Promise((r) => usageServer.listen(0, '127.0.0.1', r))
const USAGE_URL = `http://127.0.0.1:${usageServer.address().port}/api/usage`

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function launch() {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, KILN_USER_DATA: userData, KILN_USAGE_URL: USAGE_URL } })
  const win = await app.firstWindow()
  win.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await win.waitForSelector('textarea', { timeout: 20000 })
  await win.waitForTimeout(1500)
  return { app, win }
}

/** Make the next native open dialog return these files. */
async function stubOpenDialog(app, paths) {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths })
  }, paths)
}

async function pickModel(win, name) {
  await win.click('button[aria-label="Choose model"]')
  await win.fill('input[placeholder="Search models"]', name)
  await win.waitForTimeout(300)
  await win.locator('[data-radix-popper-content-wrapper] button').filter({ hasText: name }).first().click()
}

async function send(win, text) {
  const before = await win.locator('.prose-kiln').count()
  await win.fill('textarea', text)
  await win.click('button[aria-label="Send"]')
  // Wait for a new reply and for streaming to end. (A fast model can finish before a Stop button is ever seen.)
  await win.waitForFunction(
    (n) => document.querySelectorAll('.prose-kiln').length > n && !document.querySelector('button[aria-label="Stop"]'),
    before,
    { timeout: 240000 }
  )
  await win.waitForTimeout(600)
  return win.locator('.prose-kiln').last().innerText()
}

async function newChat(win) {
  await win.getByRole('button', { name: 'New chat' }).first().click()
  await win.waitForSelector('textarea[placeholder="How can I help you today?"]')
}

const { app, win } = await launch()
try {
  // 1. Plain chat + auto title
  await pickModel(win, CHAT_MODEL)
  const reply = await send(win, 'Reply with the single word: pong')
  check('chat streams a reply', /pong/i.test(reply), reply.slice(0, 60))
  await win.waitForTimeout(4000)
  const title = await win.locator('header').first().innerText()
  check('chat gets an automatic title', !!title.trim() && !/New chat/.test(title), title.trim())

  // 2. HTML artifact renders in the sandbox, which blocks network and parent access
  await send(win, 'Make an HTML artifact: a page with a heading "Sandbox test" and nothing else.')
  await win.waitForTimeout(1500)
  const frame = win.frames().find((f) => f.url().startsWith('artifact://'))
  check('HTML artifact renders in a sandboxed frame', !!frame)
  if (frame) {
    const heading = await frame.locator('h1').first().innerText().catch(() => '')
    check('artifact content is visible', /sandbox test/i.test(heading), heading)
    const net = await frame.evaluate(() => fetch('https://example.com').then(() => 'reached', () => 'blocked'))
    check('artifact cannot make network requests', net === 'blocked', net)
    const parent = await frame.evaluate(() => {
      try {
        return typeof window.parent.kiln
      } catch {
        return 'blocked'
      }
    })
    check('artifact cannot reach the app bridge', parent === 'blocked', parent)
  }
  await win.screenshot({ path: join(SHOTS, 'artifact.png') })
  await win.locator('aside button[aria-label="Close"]').click().catch(() => {})

  // 3. Manual skill via the / picker
  await newChat(win)
  await win.fill('textarea', '/haiku')
  await win.waitForSelector('text=/haiku-helper')
  await win.keyboard.press('Enter')
  check('slash picker adds a skill chip', await win.locator('button[aria-label="Remove skill haiku-helper"]').isVisible())
  const haiku = await send(win, 'Tell me about rivers.')
  check('manually chosen skill is followed', /Kiln Poetry Desk/.test(haiku), haiku.replace(/\n/g, ' / ').slice(0, 90))

  // 4. Automatic skill loading through tool calls
  await newChat(win)
  const auto = await send(win, 'Write me a poem about mountains.')
  const pill = await win.locator('text=Using skill').count()
  check('model loads a matching skill by itself', pill > 0 && /Kiln Poetry Desk/.test(auto), pill ? 'tool call seen' : 'no tool call')
  await win.screenshot({ path: join(SHOTS, 'skills.png') })

  // 5. Image attachment with a vision model
  await newChat(win)
  await pickModel(win, VISION_MODEL)
  await stubOpenDialog(app, [join(SHOTS, 'artifact.png')])
  await win.click('button[aria-label="Add"]')
  await win.getByText('Add files or photos').click()
  await win.waitForSelector('img[alt="artifact.png"]', { timeout: 10000 })
  const seen = await send(win, 'In one sentence, what is shown in this screenshot?')
  check('vision model describes an attached image', seen.length > 20 && !/can't see/i.test(seen), seen.slice(0, 90))

  // 6. Project with instructions + knowledge file
  await win.getByRole('button', { name: 'Projects' }).first().click()
  await win.getByRole('button', { name: 'New project' }).click()
  await win.fill('input[placeholder="Name your project"]', 'Heron launch')
  await win.getByRole('button', { name: 'Create project' }).click()
  await win.waitForSelector('text=Knowledge')
  await stubOpenDialog(app, [join(fixtures, 'brief.txt')])
  await win.click('button[aria-label="Add files"]')
  await win.waitForSelector('text=brief.txt')
  await pickModel(win, CHAT_MODEL)
  const codename = await send(win, 'What is the internal codename of this project? Answer in a few words.')
  // gpt-oss often writes U+202F (narrow no-break space) between words; \s matches it.
  check('project knowledge reaches the model', /blue\s+heron/i.test(codename), codename.slice(0, 60))

  // 7. Chat cost in the title bar
  await win.locator('aside [role="button"]').first().click()
  await win.waitForSelector('button[aria-label="Chat usage"]', { timeout: 10000 })
  const costChip = await win.locator('button[aria-label="Chat usage"]').innerText()
  check('title bar shows chat tokens and cost', /tokens · (≈?\$[\d.]+|local)/.test(costChip), costChip)

  // 8. Account quota: prompt for a key, then show usage and date a reset from a drop
  const before = await win.locator('button[aria-label^="Ollama usage"]').innerText()
  check('quota chip asks for an API key first', /Quota/.test(before), before)
  await win.getByRole('button', { name: /Set your name|Settings/ }).last().click()
  await win.getByRole('button', { name: 'Usage & cost' }).click()
  await win.fill('input[placeholder="Paste your API key"]', 'kiln-e2e-key')
  await win.getByRole('button', { name: 'Save', exact: true }).click()
  await win.waitForFunction(() => /40\.0%/.test(document.querySelector('button[aria-label^="Ollama usage"]')?.textContent ?? ''), null, { timeout: 10000 })
  check('quota chip shows weekly usage', true, await win.locator('button[aria-label^="Ollama usage"]').innerText())
  const unknownPace = await win.locator('button[aria-label^="Ollama usage"]').getAttribute('aria-label')
  check('pace is unknown until the reset time is known', /pace unknown/.test(unknownPace), unknownPace)
  check('API key is sent as a bearer token', mockAuth === 'Bearer kiln-e2e-key')
  mockWeekly = 0.02
  await win.getByRole('button', { name: 'Check now' }).click()
  await win.waitForFunction(() => /2\.0% · 6d 2\dh left/.test(document.querySelector('button[aria-label^="Ollama usage"]')?.textContent ?? ''), null, { timeout: 10000 })
  check('a usage drop dates the weekly reset', true, await win.locator('button[aria-label^="Ollama usage"]').innerText())
  const underPace = await win.locator('button[aria-label^="Ollama usage"]').getAttribute('aria-label')
  check('light usage early in the week is under pace', /under pace/.test(underPace), underPace)
  // Half the allowance gone moments into the week: on course to run out long before the reset.
  mockWeekly = 0.5
  await win.getByRole('button', { name: 'Check now' }).click()
  await win.waitForFunction(() => /over pace/.test(document.querySelector('button[aria-label^="Ollama usage"]')?.getAttribute('aria-label') ?? ''), null, { timeout: 10000 })
  await win.click('button[aria-label^="Ollama usage"]')
  await win.waitForTimeout(500)
  const banner = await win.locator('[data-radix-popper-content-wrapper]').innerText()
  check('heavy usage is over pace with a run-out estimate', /Over pace/.test(banner) && /hit the limit in about/.test(banner), banner.split('\n').slice(1, 4).join(' | '))
  await win.screenshot({ path: join(SHOTS, 'usage-over-pace.png') })
  await win.keyboard.press('Escape')
  mockWeekly = 0.3
  await win.getByRole('button', { name: 'Check now' }).click()
  await win.waitForTimeout(1500)
  await win.click('button[aria-label^="Ollama usage"]')
  await win.waitForTimeout(500)
  await win.screenshot({ path: join(SHOTS, 'usage-popover.png') })
  await win.keyboard.press('Escape')
  await win.screenshot({ path: join(SHOTS, 'usage-settings.png') })

  // 9. Theme + mode persist across restarts
  await win.getByRole('button', { name: /Set your name|Settings/ }).last().click()
  await win.getByRole('button', { name: 'Appearance' }).click()
  await win.getByRole('button', { name: 'Dark' }).click()
  await win.getByRole('button', { name: 'Use Nord theme' }).click()
  await win.waitForTimeout(500)
  await win.screenshot({ path: join(SHOTS, 'settings-nord-dark.png') })
} catch (err) {
  check('run completed without errors', false, err.message.split('\n')[0])
  await win.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => {})
} finally {
  await app.close()
}

const second = await launch()
const dark = await second.win.evaluate(() => document.documentElement.classList.contains('dark'))
const canvas = await second.win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--k-canvas').trim())
check('theme and dark mode persist after restart', dark && canvas.toLowerCase() === '#2e3440', canvas)
await second.win.screenshot({ path: join(SHOTS, 'home-nord-dark.png') })
await second.app.close()

// 10–11. Tools against a mock Ollama (deterministic): a model that invents tools must get one
// explanation, lose its tools and still answer; with an API key, web_search/web_fetch work end to
// end, including gpt-oss-style aliases like browser.open.
const mockChats = []
const fakeOllama = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = raw ? JSON.parse(raw) : {}
  const json = (obj) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
  if (req.url === '/api/tags') return json({ models: [{ name: 'mock-tools:latest' }] })
  if (req.url === '/api/show') return json({ capabilities: ['completion', 'tools'], model_info: { 'mock.context_length': 32768 }, details: {} })
  if (req.url !== '/api/chat') return res.writeHead(404).end()
  // Non-streaming: title requests (no tools) get a title; debugger replays of a tool round get its tool call.
  if (!body.stream) {
    if (body.tools?.length) {
      mockChats.push({ toolNames: body.tools.map((t) => t.function.name), toolResults: [], system: body.messages[0].content, replay: true })
      return json({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query: 'replayed' } } }] }, done: true, prompt_eval_count: 100, eval_count: 5 })
    }
    return json({ message: { role: 'assistant', content: 'Mock title' }, done: true, prompt_eval_count: 10, eval_count: 2 })
  }
  const toolNames = (body.tools ?? []).map((t) => t.function.name)
  const toolResults = body.messages.filter((m) => m.role === 'tool').map((m) => m.content)
  mockChats.push({ toolNames, toolResults, system: body.messages[0].content })
  let message
  if (toolNames.includes('web_search')) {
    message =
      toolResults.length === 0
        ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query: 'top headlines today' } } }] }
        : toolResults.length === 1
          ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'browser.open', arguments: { id: 'https://news.example.com/story' } } }] }
          : {
              role: 'assistant',
              content: `The lead story is KILN-WEB-OK on Sept\u202F23, per [Example News](https://news.example.com/story).\n\nMore: [preview test](${pageUrl}) and [paypal.com](https://evil.example/login).`
            }
  } else if (toolNames.length) {
    message = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web.run', arguments: { url: 'https://news.google.com' } } }] }
  } else {
    message = { role: 'assistant', content: "I can't browse the web from Kiln, so I can't fetch today's headlines." }
  }
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  res.write(JSON.stringify({ message, done: false }) + '\n')
  res.end(JSON.stringify({ done: true, prompt_eval_count: 100, eval_count: 12, eval_duration: 1e8 }) + '\n')
})
// A page with OpenGraph metadata for link hover previews (served locally; previews normally refuse
// local addresses, so the app is launched with KILN_ALLOW_PRIVATE_PREVIEWS for this test).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const fakePages = createServer((req, res) => {
  if (req.url === '/article') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(`<html><head><title>fallback</title>
      <meta property="og:title" content="Preview Title KILN"><meta property="og:description" content="A page used to test hover previews.">
      <meta property="og:site_name" content="Kiln Test Site"><meta property="og:image" content="/cover.png"><link rel="icon" href="/icon.png">
      </head><body>article</body></html>`)
  }
  if (req.url === '/cover.png' || req.url === '/icon.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG)
  res.writeHead(404).end()
})
await new Promise((r) => fakePages.listen(0, '127.0.0.1', r))
const pageUrl = `http://127.0.0.1:${fakePages.address().port}/article`

const webCalls = []
const fakeWeb = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  webCalls.push({ path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} })
  res.writeHead(200, { 'content-type': 'application/json' })
  if (req.url === '/api/web_search')
    return res.end(JSON.stringify({ results: [{ title: 'Example News', url: 'https://news.example.com/story', content: 'Top story snippet' }] }))
  res.end(JSON.stringify({ title: 'Example story', content: 'Full article text KILN-WEB-MARKER', links: ['https://news.example.com/other'] }))
})
await new Promise((r) => fakeOllama.listen(0, '127.0.0.1', r))
await new Promise((r) => fakeWeb.listen(0, '127.0.0.1', r))
const mockUserData = mkdtempSync(join(tmpdir(), 'kiln-e2e-tools-'))
mkdirSync(join(mockUserData, 'skills', 'news-helper'), { recursive: true })
writeFileSync(join(mockUserData, 'skills', 'news-helper', 'SKILL.md'), '---\nname: news-helper\ndescription: Summarise news.\n---\n\nSummarise.\n')
{
  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, KILN_USER_DATA: mockUserData, KILN_WEB_URL: `http://127.0.0.1:${fakeWeb.address().port}`, KILN_ALLOW_PRIVATE_PREVIEWS: '1' }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('textarea', { timeout: 20000 })
  await win.evaluate((host) => window.kiln.settings.update({ connection: { mode: 'local', host }, showCloudCatalog: false }), `http://127.0.0.1:${fakeOllama.address().port}`)
  await win.reload()
  await win.waitForSelector('textarea')
  await win.waitForTimeout(1500)
  try {
    // Without an API key: no web tools, and the model is told why.
    const reply = await send(win, "Get me today's top headlines.")
    check('without a key, web tools are not offered', !mockChats[0].toolNames.includes('web_search') && /Settings → Usage & cost/.test(mockChats[0].system), mockChats[0].toolNames.join(', '))
    check('an invented tool gets one explanation, then tools are withdrawn', mockChats.length === 2 && mockChats[0].toolNames.length > 0 && !mockChats[1].toolNames.length, `${mockChats.length} requests`)
    check('the explanation says Kiln has no internet access', /no internet access/.test(mockChats[1]?.toolResults[0] ?? ''))
    check('the turn still ends with an answer', /can't browse the web/.test(reply), reply.slice(0, 60))
    const note = await win.locator('text=Tried unavailable').innerText().catch(() => '')
    check('the UI labels it as an unavailable tool, not a file error', /web\.run/.test(note) && (await win.locator("text=Couldn't read file").count()) === 0, note)
    await win.screenshot({ path: join(SHOTS, 'unknown-tool.png') })

    // With a key: search, an aliased page read, and a cited answer.
    await win.evaluate(() => window.kiln.settings.setApiKey('mock-web-key'))
    mockChats.length = 0
    await win.getByRole('button', { name: 'New chat' }).first().click()
    await win.waitForSelector('textarea[placeholder="How can I help you today?"]')
    const webReply = await send(win, "What's the top news today?")
    check('with a key, web tools are offered and the prompt explains them', mockChats[0].toolNames.includes('web_fetch') && /<web>/.test(mockChats[0].system))
    check('web requests carry the API key as a bearer token', webCalls.length === 2 && webCalls.every((c) => c.auth === 'Bearer mock-web-key'), `${webCalls.length} calls`)
    check('gpt-oss-style browser.open is routed to web_fetch', webCalls[1]?.path === '/api/web_fetch' && webCalls[1]?.body.url === 'https://news.example.com/story')
    const pageResult = mockChats[2]?.toolResults[1] ?? ''
    check('page content reaches the model framed as untrusted', /KILN-WEB-MARKER/.test(pageResult) && /untrusted data/.test(pageResult))
    check('the answer cites the page', /KILN-WEB-OK/.test(webReply), webReply.slice(0, 70))
    // gpt-oss writes "Sept 23" with U+202F, which the bundled fonts lack; it must still render as a real space.
    const spaceWidth = await win.evaluate(() => {
      const prose = [...document.querySelectorAll('.prose-kiln')].at(-1)
      const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const i = node.textContent.indexOf('Sept\u00A023')
        if (i < 0) continue
        const range = document.createRange()
        range.setStart(node, i + 4)
        range.setEnd(node, i + 5)
        return range.getBoundingClientRect().width
      }
      return -1
    })
    check('narrow no-break spaces render as visible spaces', spaceWidth > 2, `${spaceWidth.toFixed(1)}px`)
    const badges = await win.locator('.mb-3.flex.flex-wrap').last().innerText()
    check('badges show the search and the page read', /Searched the web:\s+top headlines today\s+· 1 result\b/.test(badges) && /Read\s*Example story/.test(badges), badges.replace(/\s+/g, ' '))
    await win.screenshot({ path: join(SHOTS, 'web-tools.png') })

    // 12. The debugger window shows the exact requests behind that turn, and can replay one.
    const [dbg] = await Promise.all([app.waitForEvent('window'), win.click('button[aria-label^="Open debugger"]')])
    await dbg.waitForSelector('text=chat · round 1', { timeout: 10000 })
    await dbg.waitForTimeout(800)
    const list = await dbg.locator('.w-\\[420px\\]').innerText()
    const sequence = ['chat · round 1', 'web_search', 'chat · round 2', 'web_fetch', 'chat · round 3', 'title'].every((s) => list.includes(s))
    check('debugger lists every request in the turn, in order', sequence, list.replace(/\s+/g, ' ').slice(0, 160))
    await dbg.locator('button', { hasText: '→ web_search' }).first().click()
    await dbg.waitForSelector('text=Tools offered')
    const overview = await dbg.locator('dl').first().innerText()
    check('overview shows the model, think setting and tools offered', /mock-tools:latest/.test(overview) && /web_search/.test(overview), overview.replace(/\s+/g, ' ').slice(0, 120))
    await dbg.getByRole('button', { name: 'Prompt anatomy' }).click()
    const anatomyText = await dbg.locator('text=Where the tokens go').locator('..').locator('..').innerText()
    check('prompt anatomy breaks the request into its parts', /Web tool guidance/.test(anatomyText) && /Tool definitions \(\d\)/.test(anatomyText) && /Base instructions/.test(anatomyText))
    await dbg.getByRole('button', { name: 'Request', exact: true }).click()
    const requestJson = await dbg.locator('.code-body').first().innerText()
    check('request tab shows the exact JSON sent', /"model": "mock-tools:latest"/.test(requestJson) && /"stream": true/.test(requestJson))
    await dbg.screenshot({ path: join(SHOTS, 'debugger.png') })
    await dbg.getByRole('button', { name: 'Replay', exact: true }).click()
    const before = mockChats.length
    await dbg.getByRole('button', { name: 'Send' }).click()
    await dbg.waitForSelector('text=Tool calls', { timeout: 10000 })
    check('replay re-sends the request without streaming', mockChats.length === before + 1)
    await dbg.screenshot({ path: join(SHOTS, 'debugger-replay.png') })
    await dbg.close()

    // 13. Links (issue #1): hand cursor only on the link, a hover card showing the destination, and
    // an opt-in page preview.
    const newsLink = win.locator('.prose-kiln a[href="https://news.example.com/story"]').last()
    const cursors = await newsLink.evaluate((a) => ({ link: getComputedStyle(a).cursor, text: getComputedStyle(a.closest('p')).cursor }))
    check('links get the hand cursor; surrounding text keeps the text cursor', cursors.link === 'pointer' && cursors.text === 'auto', JSON.stringify(cursors))
    await newsLink.hover()
    const card = win.locator('[data-testid="link-card"]')
    await card.waitFor({ timeout: 5000 })
    const cardText = await card.innerText()
    check('hovering a link shows where it goes', /news\.example\.com/.test(cardText) && /https:\/\/news\.example\.com\/story/.test(cardText) && /Opens in your browser/.test(cardText), cardText.replace(/\s+/g, ' '))
    check('no page is fetched while previews are off', (await card.locator('img').count()) === 0)
    await win.mouse.move(5, 5)
    await card.waitFor({ state: 'detached', timeout: 5000 })
    await win.locator('.prose-kiln a[href="https://evil.example/login"]').last().hover()
    await card.waitFor({ timeout: 5000 })
    check('a link whose text names another domain gets a warning', /The link text says paypal\.com, but it opens evil\.example/.test(await card.innerText()))
    await win.mouse.move(5, 5)
    await card.waitFor({ state: 'detached', timeout: 5000 })

    await win.evaluate(() => window.kiln.settings.update({ links: { previews: true } }))
    await win.reload()
    await win.waitForSelector('textarea')
    await win.locator('aside [role="button"]').first().click()
    await win.waitForSelector(`.prose-kiln a[href="${pageUrl}"]`)
    await win.locator(`.prose-kiln a[href="${pageUrl}"]`).last().hover()
    await card.waitFor({ timeout: 5000 })
    await win.waitForFunction(() => /Preview Title KILN/.test(document.querySelector('[data-testid="link-card"]')?.textContent ?? ''), null, { timeout: 8000 })
    const imgs = await card.locator('img').evaluateAll((els) => els.map((e) => e.getAttribute('src')?.slice(0, 15)))
    check('with previews on, the card shows the page title and image', imgs.length === 2 && imgs.every((s) => s === 'data:image/png;'), imgs.join(', '))
    await win.screenshot({ path: join(SHOTS, 'link-preview.png') })

    // The card's title and URL act as the link; the excerpt doesn't. Record opens instead of launching a browser.
    await app.evaluate(({ shell }) => {
      globalThis.__opened = []
      shell.openExternal = async (url) => void globalThis.__opened.push(url)
    })
    const opened = () => app.evaluate(() => globalThis.__opened)
    const reopenCard = async () => {
      await win.mouse.move(5, 5)
      await card.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
      await win.locator(`.prose-kiln a[href="${pageUrl}"]`).last().hover()
      await card.waitFor({ timeout: 5000 })
    }
    await card.getByText('A page used to test hover previews.').click()
    check('clicking the excerpt does not open the link', (await opened()).length === 0)
    await card.getByText('Preview Title KILN').click()
    await card.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    const closedAfterClick = (await card.count()) === 0
    await reopenCard()
    await card.getByText(pageUrl).click()
    const urls = await opened()
    check('clicking the card title or URL opens the link, then the card closes', urls.length === 2 && urls.every((u) => u === pageUrl) && closedAfterClick, `${urls.length} opens, closed=${closedAfterClick}`)
  } catch (err) {
    check('tool runs completed without errors', false, err.message.split('\n')[0])
    await win.screenshot({ path: join(SHOTS, 'tools-failure.png') }).catch(() => {})
  } finally {
    await app.close()
    fakeOllama.close()
    fakeWeb.close()
    fakePages.close()
  }
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots in e2e/shots/, data in ${userData}`)
usageServer.close()
process.exit(failed ? 1 : 0)
