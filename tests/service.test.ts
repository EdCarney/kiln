import type { ServerResponse } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@shared/types'
import { line, type MockOllama, startMockOllama, streamChunks } from './ollamaMock'

// Everything above the Electron line is real: SQLite (in memory), settings, prompt assembly, the
// Ollama client and the tool loop. Only Electron itself is faked, and Ollama is a local mock server.
const events = vi.hoisted(() => {
  process.env.KILN_WEB_URL = 'http://127.0.0.1:1' // replaced once the mock is listening
  return [] as ChatEvent[]
})
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: (_channel: string, e: ChatEvent) => events.push(e) } }] },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  },
  shell: {},
  app: { getPath: () => '' },
  nativeImage: {}
}))

// web.ts reads its base URL at import, so the mock must be listening before the service loads.
const ollama: MockOllama = await startMockOllama()
process.env.KILN_WEB_URL = ollama.url

const { openDatabase } = await import('../src/main/db/index')
const { updateSettings, setApiKey } = await import('../src/main/settings')
const service = await import('../src/main/chat/service')
const { listTraces } = await import('../src/main/debug/traces')
const { deleteConversation, getMessage, insertMessage, createConversation, search, updateConversation, updateMessage } = await import('../src/main/db/conversations')

type ChatHandler = (body: Record<string, unknown>, res: ServerResponse, call: number) => unknown
let chat: ChatHandler
let web: (path: string, res: ServerResponse) => unknown
let chatCalls: Array<Record<string, unknown>>
let titleCalls: Array<Record<string, unknown>>

beforeAll(() => {
  openDatabase(':memory:')
  updateSettings({ connection: { mode: 'local', host: ollama.url }, skills: { autoLoad: false }, web: { enabled: true } })
  ollama.handler = (req, res) => {
    if (req.url === '/api/show')
      return res.writeHead(200).end(JSON.stringify({ capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 8192 } }))
    // Titles are generated in the background after a reply; answer them apart from the scripted chat.
    if (req.url === '/api/chat' && req.json.stream === false) {
      titleCalls.push(req.json)
      return res.writeHead(200).end(JSON.stringify({ message: { role: 'assistant', content: 'A title' }, done: true }))
    }
    if (req.url === '/api/chat') {
      chatCalls.push(req.json)
      return chat(req.json, res, chatCalls.length)
    }
    return web(req.url ?? '', res)
  }
})
afterAll(() => ollama.close())
beforeEach(() => {
  events.length = 0
  chatCalls = []
  titleCalls = []
  setApiKey(null)
  web = (_p, res) => res.writeHead(404).end()
})

const reply = (text: string): ChatHandler => (_b, res) =>
  streamChunks(res, [line({ message: { role: 'assistant', content: text }, done: false }), line({ done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 3 })]).then(() => res.end())

const toolCall = (name: string, args: Record<string, unknown>) =>
  line({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: false }) + line({ done: true })

function start(content = 'hello') {
  return service.send({ conversationId: null, projectId: null, content, attachmentIds: [], model: 'llama3.2', think: null, skills: [] })
}

function waitFor<T>(check: () => T | undefined | false, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      const v = check()
      if (v) return resolve(v)
      if (Date.now() - t0 > ms) return reject(new Error('timed out waiting'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

const doneEvent = (conversationId: string) =>
  waitFor(() => events.find((e): e is Extract<ChatEvent, { type: 'done' }> => e.type === 'done' && e.conversationId === conversationId))

describe('reply loop', () => {
  it('streams a reply and saves it with stats', async () => {
    chat = reply('Hi there')
    const r = start()
    const done = await doneEvent(r.conversation.id)
    expect(done.message.content).toBe('Hi there')
    expect(done.message.stats).toMatchObject({ promptTokens: 10, completionTokens: 3, doneReason: 'stop' })
    expect(chatCalls[0]).toMatchObject({ model: 'llama3.2', options: { num_ctx: 8192 } })
    // The title request uses the same num_ctx, so Ollama doesn't reload the local model for it.
    await waitFor(() => titleCalls.length > 0)
    expect(titleCalls[0]).toMatchObject({ options: { num_ctx: 8192 } })
  })

  it('records when a reply was cut off by the length limit', async () => {
    chat = (_b, res) =>
      streamChunks(res, [line({ message: { role: 'assistant', content: 'The list goes on: one, two, thr' }, done: false }), line({ done: true, done_reason: 'length', eval_count: 4096 })]).then(() =>
        res.end()
      )
    const r = start()
    const done = await doneEvent(r.conversation.id)
    expect(done.message.stats?.doneReason).toBe('length')
    expect(done.message.error).toBeNull()
  })

  it("sends a chat's own instructions with its replies", async () => {
    chat = reply('Arr.')
    const r = start()
    await doneEvent(r.conversation.id)
    updateConversation(r.conversation.id, { instructions: 'Answer like a pirate.' })
    events.length = 0
    service.send({ conversationId: r.conversation.id, projectId: null, content: 'hi again', attachmentIds: [], model: 'llama3.2', think: null, skills: [] })
    await doneEvent(r.conversation.id)
    const system = (chatCalls.at(-1)!.messages as Array<{ role: string; content: string }>)[0]
    expect(system.content).toContain('Answer like a pirate.')
  })

  it('saves a failed stream with its partial text and an error', async () => {
    chat = (_b, res) => streamChunks(res, [line({ message: { role: 'assistant', content: 'Half an ans' }, done: false })]).then(() => res.end())
    const r = start()
    const done = await doneEvent(r.conversation.id)
    expect(done.message.content).toBe('Half an ans')
    expect(done.message.error).toMatch(/dropped before the reply finished/)
  })

  it('checkpoints a long reply to the database while it streams', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    chat = async (_b, res) => {
      await streamChunks(res, [line({ message: { role: 'assistant', content: 'early words' }, done: false })])
      await new Promise((r) => setTimeout(r, 1700))
      res.write(line({ message: { role: 'assistant', content: '!' }, done: false })) // triggers the checkpoint
      await gate
      res.end(line({ done: true }))
    }
    const r = start()
    const saved = await waitFor(() => getMessage(r.assistantMessageId)?.content === 'early words!')
    expect(saved).toBe(true)
    release()
    await doneEvent(r.conversation.id)
  })

  it('stop() resolves only after the partial reply is saved', async () => {
    chat = (_b, res) => streamChunks(res, [line({ message: { role: 'assistant', content: 'partial' }, done: false })]) // then hangs
    const r = start()
    await waitFor(() => events.some((e) => e.type === 'delta' && e.conversationId === r.conversation.id))
    await service.stop(r.conversation.id, { quiet: true }) // as deleting the chat does
    const saved = getMessage(r.assistantMessageId)!
    expect(saved.content).toBe('partial')
    expect(saved.error).toBeNull()
    expect(saved.stats).not.toBeNull()
    // The chat can now be deleted without the reply writing to it afterwards.
    deleteConversation(r.conversation.id)
    expect(service.isReplying()).toBe(false)
    // A stop for a delete (or a quit) doesn't start a title request.
    await new Promise((r) => setTimeout(r, 50))
    expect(titleCalls).toHaveLength(0)
  })

  it('still titles a new chat whose first reply was stopped with Stop', async () => {
    chat = (_b, res) => streamChunks(res, [line({ message: { role: 'assistant', content: 'partial' }, done: false })])
    const r = start()
    await waitFor(() => events.some((e) => e.type === 'delta' && e.conversationId === r.conversation.id))
    await service.stop(r.conversation.id)
    await waitFor(() => events.some((e) => e.type === 'title' && e.conversationId === r.conversation.id))
    expect(titleCalls).toHaveLength(1)
  })

  it('keeps an overlapping reply stoppable after the earlier one finishes', async () => {
    chat = reply('first')
    const r = start()
    await doneEvent(r.conversation.id)
    events.length = 0
    // regenerate() awaits file cleanup before registering its reply; a send() landing in that gap
    // registers its own reply first. The regenerated reply streams and then hangs.
    chat = (_b, res, n) =>
      n === 2 ? reply('sent reply')(_b, res, n) : streamChunks(res, [line({ message: { role: 'assistant', content: 'regenerated' }, done: false })])
    const regen = service.regenerate(r.conversation.id, { model: 'llama3.2', think: null })
    service.send({ conversationId: r.conversation.id, projectId: null, content: 'again', attachmentIds: [], model: 'llama3.2', think: null, skills: [] })
    const second = await regen
    await doneEvent(r.conversation.id) // the send's reply finished
    expect(service.isReplying()).toBe(true) // the regenerated reply is still tracked…
    await service.stop(r.conversation.id) // …so stop() waits for it and it gets saved
    expect(getMessage(second.assistantMessageId)?.stats).not.toBeNull()
    expect(service.isReplying()).toBe(false)
  })

  it('stops promptly during a slow web request and marks the call stopped', async () => {
    setApiKey('test-key')
    chat = (_b, res) => void res.writeHead(200).end(toolCall('web_fetch', { url: 'https://example.com' }))
    web = () => undefined // web_fetch never answers
    const r = start('read example.com')
    await waitFor(() => events.some((e) => e.type === 'tool' && e.event.pending))
    const t0 = Date.now()
    await service.stop(r.conversation.id)
    expect(Date.now() - t0).toBeLessThan(1000)
    const saved = getMessage(r.assistantMessageId)!
    expect(saved.toolEvents).toEqual([expect.objectContaining({ tool: 'web_fetch', pending: false, ok: false })])
    expect(saved.error).toBeNull()
    // The debugger shows the cancelled call as stopped, not forever running.
    const traces = listTraces(r.conversation.id)
    expect(traces.find((t) => t.kind === 'tool')?.status).toBe('aborted')
    expect(traces.every((t) => t.status !== 'running')).toBe(true)
  })

  it('withdraws tools after the model only calls tools Kiln lacks', async () => {
    chat = (_b, res, n) => (n === 1 ? void res.writeHead(200).end(toolCall('python', { code: '1+1' })) : reply('2')(_b, res, n))
    const r = start('what is 1+1')
    const done = await doneEvent(r.conversation.id)
    expect(done.message.content).toBe('2')
    expect(chatCalls).toHaveLength(2)
    expect(chatCalls[1].tools).toBeUndefined()
    expect(done.message.toolEvents[0]).toMatchObject({ tool: 'python', ok: false })
  })

  it('remembers earlier search results on the next turn', async () => {
    setApiKey('test-key')
    chat = (b, res, n) => (n === 1 ? void res.writeHead(200).end(toolCall('web_search', { query: 'kiln news' })) : reply(n === 2 ? 'Two stories today.' : 'Opening it.')(b, res, n))
    web = (_p, res) =>
      res.writeHead(200).end(
        JSON.stringify({
          results: [
            { title: 'Kilns are back', url: 'https://a.example/kilns', content: 'x' },
            { title: 'Pottery prices', url: 'https://b.example/pots', content: 'y' }
          ]
        })
      )
    const r = start('what is in the news?')
    const first = await doneEvent(r.conversation.id)
    expect(first.message.toolEvents[0].record).toContain('2. Pottery prices — https://b.example/pots')
    events.length = 0
    service.send({ conversationId: r.conversation.id, projectId: null, content: 'open the second one', attachmentIds: [], model: 'llama3.2', think: null, skills: [] })
    await doneEvent(r.conversation.id)
    const followUp = chatCalls[2].messages as Array<{ role: string; content: string; tool_calls?: unknown[] }>
    const replayed = followUp.find((m) => m.role === 'tool')
    expect(replayed?.content).toContain('https://b.example/pots')
    expect(followUp.find((m) => m.tool_calls)?.tool_calls).toEqual([{ function: { name: 'web_search', arguments: { query: 'kiln news' } } }])
  })

  it('ends a tool-happy model with a tool-free final round', async () => {
    setApiKey('test-key')
    chat = (b, res, n) => (b.tools ? void res.writeHead(200).end(toolCall('web_search', { query: `q${n}` })) : reply('Final answer')(b, res, n))
    web = (_p, res) => res.writeHead(200).end(JSON.stringify({ results: [{ title: 't', url: 'https://t.io', content: 'c' }] }))
    const r = start('research this')
    const done = await doneEvent(r.conversation.id)
    expect(done.message.content).toBe('Final answer')
    expect(chatCalls.length).toBe(6)
    expect(chatCalls.at(-1)!.tools).toBeUndefined()
  })
})

describe('markInterruptedReplies', () => {
  it('flags replies that never got their final save, and only those', () => {
    const c = createConversation({ projectId: null, model: 'llama3.2', think: null, skills: [] })
    const user = insertMessage({ conversationId: c.id, parentId: null, role: 'user', content: 'hi' })
    const cut = insertMessage({ conversationId: c.id, parentId: user.id, role: 'assistant', content: '' })
    // A checkpoint wrote text and a running tool, then the app died.
    updateMessage(cut.id, { content: 'so far', toolEvents: [{ tool: 'web_search', args: {}, ok: true, pending: true, summary: 'kiln' }] })
    const finished = insertMessage({ conversationId: c.id, parentId: user.id, role: 'assistant', content: 'done' })
    updateMessage(finished.id, { stats: { promptTokens: 1, completionTokens: 1 } })

    expect(service.markInterruptedReplies()).toBeGreaterThanOrEqual(1)
    const after = getMessage(cut.id)!
    expect(after.content).toBe('so far')
    expect(after.error).toMatch(/closed before this reply finished/)
    expect(after.toolEvents[0]).toMatchObject({ pending: false, ok: false })
    // Checkpoints skip search indexing; marking the reply indexes the text it kept.
    expect(search('so far').map((h) => h.conversationId)).toContain(c.id)
    expect(getMessage(finished.id)!.error).toBeNull()
  })
})
