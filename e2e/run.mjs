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
  await win.fill('textarea', text)
  await win.click('button[aria-label="Send"]')
  await win.waitForSelector('button[aria-label="Stop"]', { timeout: 15000 })
  await win.waitForSelector('button[aria-label="Stop"]', { state: 'detached', timeout: 240000 })
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

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots in e2e/shots/, data in ${userData}`)
usageServer.close()
process.exit(failed ? 1 : 0)
