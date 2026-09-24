import { bundledLanguages, createCssVariablesTheme, createHighlighter, type Highlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

// Token colours come from CSS variables (see index.css), so code follows the active app theme.
const theme = createCssVariablesTheme({ name: 'kiln', variablePrefix: '--shiki-', fontStyle: true })

const ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  golang: 'go',
  kt: 'kotlin',
  rb: 'ruby',
  text: 'plaintext',
  txt: 'plaintext'
}

let highlighter: Promise<Highlighter> | null = null
const cache = new Map<string, string>()

function getHighlighter(): Promise<Highlighter> {
  highlighter ??= createHighlighter({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine() })
  return highlighter
}

export function normalizeLang(lang: string | null | undefined): string {
  const l = (lang ?? '').toLowerCase().trim()
  return ALIASES[l] ?? l
}

/** Highlighted HTML for a code block, or null if the language is unknown. Results are memoised. */
export async function highlight(code: string, lang: string | null | undefined): Promise<string | null> {
  const language = normalizeLang(lang)
  if (!language || language === 'plaintext' || !(language in bundledLanguages)) return null
  const key = `${language}\u0000${code}`
  const hit = cache.get(key)
  if (hit) return hit
  const h = await getHighlighter()
  if (!h.getLoadedLanguages().includes(language)) await h.loadLanguage(language as keyof typeof bundledLanguages)
  const html = h.codeToHtml(code, { lang: language, theme: 'kiln' })
  if (cache.size > 300) cache.delete(cache.keys().next().value!)
  cache.set(key, html)
  return html
}
