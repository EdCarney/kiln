import { describe, expect, it } from 'vitest'
import { assemble, type AssembleInput, type HistoryTurn } from '../src/main/chat/assemble'
import { effectiveContext } from '../src/shared/context'

const turn = (role: 'user' | 'assistant', content: string, extra: Partial<HistoryTurn> = {}): HistoryTurn => ({
  role,
  content,
  documents: [],
  images: [],
  hiddenImages: [],
  ...extra
})

const base: AssembleInput = {
  model: 'kimi-k3:cloud',
  contextLength: 128_000,
  userName: 'Ed',
  preferences: '',
  date: new Date('2026-09-23'),
  artifacts: { enabled: true, allowCdn: false },
  web: 'off',
  project: null,
  knowledge: [],
  skillIndex: [],
  selectedSkills: [],
  loadedSkills: [],
  history: [turn('user', 'hello')]
}

describe('assemble', () => {
  it('orders system sections: base, project, knowledge, artifacts, skills', () => {
    const { messages } = assemble({
      ...base,
      project: { name: 'Trip', instructions: 'Be brief.' },
      knowledge: [{ name: 'notes.md', text: 'Lisbon in May' }],
      selectedSkills: [{ name: 'tone', body: 'Write warmly.', files: [], hasScripts: false }]
    })
    const sys = messages[0].content
    const order = ['Kiln', '<project name="Trip">', '<project_knowledge>', '<artifacts>', '<selected_skills>'].map((s) =>
      sys.indexOf(s)
    )
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(sys).toContain('Lisbon in May')
  })

  it('describes web access honestly', () => {
    const on = assemble({ ...base, web: 'on' }).messages[0].content
    expect(on).toContain('<web>')
    expect(on).toContain('web_search')
    const noKey = assemble({ ...base, web: 'no-key' }).messages[0].content
    expect(noKey).not.toContain('<web>')
    expect(noKey).toContain('no internet access')
    expect(noKey).toContain('Settings → Usage & cost')
  })

  it('omits artifact instructions when disabled', () => {
    const { messages } = assemble({ ...base, artifacts: { enabled: false, allowCdn: false } })
    expect(messages[0].content).not.toContain('<artifacts>')
  })

  it('puts attached documents before the question and notes hidden images', () => {
    const { messages } = assemble({
      ...base,
      history: [turn('user', 'Summarise it', { documents: [{ name: 'a.pdf', text: 'PDF BODY' }], hiddenImages: ['cat.png'] })]
    })
    const user = messages[1].content
    expect(user.indexOf('PDF BODY')).toBeLessThan(user.indexOf('Summarise it'))
    expect(user).toContain('cat.png')
    expect(messages[1].images).toBeUndefined()
  })

  it('passes images through for vision models', () => {
    const { messages } = assemble({ ...base, history: [turn('user', 'what is this', { images: ['AAAA'] })] })
    expect(messages[1].images).toEqual(['AAAA'])
  })

  it('drops the oldest turns when history exceeds the context window', () => {
    const long = 'x'.repeat(40_000) // ~10k tokens each
    const history = [turn('user', long), turn('assistant', long), turn('user', long), turn('assistant', long), turn('user', 'latest')]
    const out = assemble({ ...base, contextLength: 32_000, history })
    expect(out.droppedTurns).toBeGreaterThan(0)
    expect(out.messages[out.messages.length - 1].content).toBe('latest')
    expect(out.messages[1].role).toBe('user')
  })
})

describe('effectiveContext', () => {
  it('caps local models at the num_ctx setting', () => {
    expect(effectiveContext({ location: 'local', contextLength: 131_072 }, 32_768)).toBe(32_768)
    expect(effectiveContext({ location: 'local', contextLength: 8_192 }, 32_768)).toBe(8_192)
    expect(effectiveContext({ location: 'local', contextLength: null }, 32_768)).toBe(32_768)
  })

  it('gives cloud models their full length', () => {
    expect(effectiveContext({ location: 'cloud', contextLength: 262_144 }, 32_768)).toBe(262_144)
    expect(effectiveContext({ location: 'cloud', contextLength: null }, 32_768)).toBeNull()
  })

  it('trims history to the window Ollama will actually open', () => {
    const history = Array.from({ length: 40 }, (_, i) => turn(i % 2 ? 'assistant' : 'user', 'x'.repeat(4_000)))
    const window = effectiveContext({ location: 'local', contextLength: 131_072 }, 32_768)
    const out = assemble({ ...base, contextLength: window, history })
    expect(out.droppedTurns).toBeGreaterThan(0)
    expect(out.estimatedTokens).toBeLessThanOrEqual(32_768)
  })
})
