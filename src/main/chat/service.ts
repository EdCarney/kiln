import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { parseMessage } from '@shared/artifactParser'
import { normalizeSpaces } from '@shared/text'
import { contextOptions, effectiveContext } from '@shared/context'
import { EVENT_CHANNELS } from '@shared/ipc'
import { resolveThinkProfile, toOllamaThink } from '@shared/thinking'
import type {
  ChatEvent,
  Conversation,
  Message,
  MessageStats,
  SendRequest,
  SendResult,
  ThinkSetting,
  ToolEvent
} from '@shared/types'
import { addArtifactVersion, listArtifacts, pruneEmptyArtifacts } from '../db/artifacts'
import {
  attachmentRowsForMessage,
  checkpointMessage,
  createConversation,
  deleteMessagesFrom,
  getConversation,
  getMessage,
  insertMessage,
  linkAttachments,
  listMessages,
  unfinishedReplyIds,
  updateConversation,
  updateMessage
} from '../db/conversations'
import { getProject, projectKnowledge, touchProject } from '../db/projects'
import { imageForModel, removeFiles } from '../files/ingest'
import { type ChatBody, type ChatChunk, chatOnce, chatStream, endpointFor, streamTimeoutsFor, type ToolCall } from '../ollama/client'
import { getModelInfo } from '../ollama/models'
import { webAvailable, webEndpoint } from '../ollama/web'
import { startTrace, type Trace } from '../debug/traces'
import { paths } from '../paths'
import { getSettings } from '../settings'
import { getSkill, listSkills } from '../skills/library'
import { conversationUsage, insertUsageEvent } from '../db/usage'
import { requestCost } from '../usage/pricing'
import { errorMessage, estimateTokens } from '../util'
import { assemble, type HistoryTurn, type PastToolCall } from './assemble'
import { TITLE_PROMPT } from './prompts'
import { pendingEvent, runTool, settleToolEvent, type ToolContext, type ToolResult, toolsFor } from './tools'
import type { WebStatus } from './prompts'

// Room for a search, a few page reads and a skill load; the last round is always tool-free.
const MAX_TOOL_ROUNDS = 6
// How often a streaming reply is saved, so a quit or crash loses at most this much.
const CHECKPOINT_MS = 1500

/**
 * Replies in progress, by conversation. `settled` resolves once the reply has been saved. `quiet` marks a
 * stop made for a delete or a quit, where the chat won't be seen again, so no title is generated.
 */
interface Run {
  controller: AbortController
  flags: { quiet: boolean }
  settled: Promise<void>
}
const active = new Map<string, Run>()

function emit(event: ChatEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(EVENT_CHANNELS.chat, event)
}

function assertIdle(conversationId: string): void {
  if (active.has(conversationId)) throw new Error('Kiln is still responding in this chat.')
}

export function send(req: SendRequest): SendResult {
  if (!req.content.trim() && !req.attachmentIds.length) throw new Error('Message is empty')
  let conversation: Conversation | null
  if (req.conversationId) {
    conversation = getConversation(req.conversationId)
    if (!conversation) throw new Error('Conversation not found')
    assertIdle(conversation.id)
    conversation = updateConversation(conversation.id, { model: req.model, think: req.think, skills: req.skills, touch: true })
  } else {
    conversation = createConversation({ projectId: req.projectId, model: req.model, think: req.think, skills: req.skills })
  }
  const previous = listMessages(conversation.id).at(-1)
  const user = insertMessage({ conversationId: conversation.id, parentId: previous?.id ?? null, role: 'user', content: req.content })
  linkAttachments(req.attachmentIds, user.id)
  if (conversation.projectId) touchProject(conversation.projectId)
  return startAssistant(conversation, getMessage(user.id)!, req.model, req.think)
}

export async function regenerate(conversationId: string, opts: { model: string; think: ThinkSetting | null }): Promise<SendResult> {
  assertIdle(conversationId)
  const messages = listMessages(conversationId)
  const lastUserIndex = messages.findLastIndex((m) => m.role === 'user')
  if (lastUserIndex < 0) throw new Error('Nothing to retry')
  await dropAfter(conversationId, messages, lastUserIndex)
  const conversation = updateConversation(conversationId, { model: opts.model, think: opts.think, touch: true })
  return startAssistant(conversation, messages[lastUserIndex], opts.model, opts.think)
}

export async function edit(messageId: string, content: string, opts: { model: string; think: ThinkSetting | null }): Promise<SendResult> {
  const original = getMessage(messageId)
  if (!original || original.role !== 'user') throw new Error('Only your own messages can be edited')
  assertIdle(original.conversationId)
  const messages = listMessages(original.conversationId)
  await dropAfter(original.conversationId, messages, messages.findIndex((m) => m.id === messageId))
  const user = updateMessage(messageId, { content })
  const conversation = updateConversation(original.conversationId, { model: opts.model, think: opts.think, touch: true })
  return startAssistant(conversation, user, opts.model, opts.think)
}

/**
 * Stop a reply and wait until what it produced has been saved. Pass `quiet` when stopping for a delete or
 * a quit; a plain Stop still lets a new chat get its title.
 */
export function stop(conversationId: string, opts: { quiet?: boolean } = {}): Promise<void> {
  const run = active.get(conversationId)
  if (!run) return Promise.resolve()
  if (opts.quiet) run.flags.quiet = true
  run.controller.abort()
  return run.settled
}

export const isReplying = (): boolean => active.size > 0

/**
 * Replies that were still streaming when Kiln last quit or crashed. Their checkpointed text is kept;
 * they're marked so the chat shows what happened and offers Retry. Run once at startup.
 */
export function markInterruptedReplies(): number {
  const ids = unfinishedReplyIds()
  for (const id of ids) {
    const m = getMessage(id)!
    // Passing the content indexes it for search; checkpoints skip indexing.
    updateMessage(id, {
      content: m.content,
      toolEvents: m.toolEvents.map(settleToolEvent),
      error: 'Kiln closed before this reply finished.'
    })
  }
  return ids.length
}

/**
 * Quietly stop every reply in progress (or those in chats matching `which`) and wait for each to save.
 * Used before quitting and deleting a project.
 */
export async function stopAll(which: (conversationId: string) => boolean = () => true): Promise<void> {
  await Promise.all([...active.keys()].filter(which).map((id) => stop(id, { quiet: true })))
}

async function dropAfter(conversationId: string, messages: Message[], index: number): Promise<void> {
  const next = messages[index + 1]
  if (!next) return
  await removeFiles(deleteMessagesFrom(conversationId, next.createdAt))
  pruneEmptyArtifacts(conversationId)
}

function startAssistant(conversation: Conversation, parent: Message, model: string, think: ThinkSetting | null): SendResult {
  const assistant = insertMessage({ conversationId: conversation.id, parentId: parent.id, role: 'assistant', content: '', model })
  const controller = new AbortController()
  const flags = { quiet: false }
  const settled = generate(conversation.id, assistant.id, model, think, controller, flags)
    .catch((err) => console.error('Kiln: a reply failed to finish', err))
    .finally(() => {
      // Only remove our own entry: a reply that overlapped this one must stay stoppable.
      if (active.get(conversation.id)?.controller === controller) active.delete(conversation.id)
    })
  active.set(conversation.id, { controller, flags, settled })
  return { conversation, userMessage: parent, assistantMessageId: assistant.id }
}

/** The successful web calls behind a reply, in brief, for replaying on later turns. */
function pastToolCalls(events: ToolEvent[]): PastToolCall[] {
  return events.flatMap((e): PastToolCall[] => {
    if (!e.ok || e.pending || !e.record || (e.tool !== 'web_search' && e.tool !== 'web_fetch')) return []
    const args = e.tool === 'web_search' ? { query: e.args.query } : { url: e.args.url }
    return [{ name: e.tool, args, record: e.record }]
  })
}

async function toTurn(message: Message, vision: boolean): Promise<HistoryTurn> {
  const turn: HistoryTurn = { role: message.role, content: message.content, documents: [], images: [], hiddenImages: [] }
  if (message.role !== 'user') {
    turn.tools = pastToolCalls(message.toolEvents)
    return turn
  }
  for (const a of attachmentRowsForMessage(message.id)) {
    if (a.kind === 'image') {
      if (vision) turn.images.push(await imageForModel(a.path, a.mime))
      else turn.hiddenImages.push(a.name)
    } else {
      turn.documents.push({
        name: a.name,
        text: a.text || '[No text could be extracted from this file. It may be a scanned document or an image-only PDF.]'
      })
    }
  }
  return turn
}

async function generate(
  conversationId: string,
  messageId: string,
  modelName: string,
  think: ThinkSetting | null,
  controller: AbortController,
  flags: Run['flags']
): Promise<void> {
  let content = ''
  let thinking = ''
  const toolEvents: ToolEvent[] = []
  const stats: MessageStats = { promptTokens: 0, completionTokens: 0 }
  const startedAt = Date.now()
  let thinkStart: number | null = null
  let thinkEnd: number | null = null
  let evalNs = 0
  let error: string | null = null
  let openRound: { content: string; thinking: string; promptEstimate: number } | null = null
  let roundTrace: Trace | null = null

  // Each round is a separate billed request: log it, and roll it into the message's stats.
  const recordRound = (final: ChatChunk | null) => {
    if (!openRound) return null
    const estimated = !final?.eval_count
    const promptTokens = final?.prompt_eval_count ?? openRound.promptEstimate
    const completionTokens = final?.eval_count ?? estimateTokens(openRound.content + openRound.thinking)
    const costUsd = requestCost(modelName, promptTokens, completionTokens)
    insertUsageEvent({ conversationId, messageId, model: modelName, kind: 'chat', promptTokens, completionTokens, costUsd, estimated })
    stats.promptTokens! += promptTokens
    stats.completionTokens! += completionTokens
    stats.costUsd = stats.costUsd === null || costUsd === null ? null : (stats.costUsd ?? 0) + costUsd
    if (estimated) stats.estimated = true
    openRound = null
    return { promptTokens, completionTokens, costUsd, estimated }
  }

  const delta = (d: { content?: string; thinking?: string }) => emit({ type: 'delta', conversationId, messageId, ...d })

  // Save progress now and then, so a quit or crash keeps the partial reply (see markInterruptedReplies).
  let savedAt = Date.now()
  const checkpoint = () => {
    if (Date.now() - savedAt < CHECKPOINT_MS) return
    savedAt = Date.now()
    checkpointMessage(messageId, { content, thinking: thinking || null, toolEvents })
  }

  try {
    const conversation = getConversation(conversationId)!
    const settings = getSettings()
    const model = await getModelInfo(modelName)
    const profile = resolveThinkProfile(modelName, model.capabilities, model.overrides.think)
    const vision = model.capabilities.includes('vision')
    const toolsCapable = model.capabilities.includes('tools')
    const numCtx = effectiveContext(model, settings.localNumCtx)
    const autoSkills = settings.skills.autoLoad && toolsCapable && model.overrides.autoSkills !== false
    const web: WebStatus = !settings.web.enabled ? 'off' : !toolsCapable ? 'unsupported' : webAvailable() ? 'on' : 'no-key'

    const selectedIds = conversation.skills
    let loadedIds = conversation.autoSkills.filter((id) => !selectedIds.includes(id))
    const load = async (ids: string[]) =>
      (await Promise.all(ids.map((id) => getSkill(id))))
        .filter((s) => !!s && s.enabled)
        .map((s) => ({ name: s!.name, body: s!.body, files: s!.files, hasScripts: s!.hasScripts }))
    const skillIndex = autoSkills
      ? (await listSkills()).filter((s) => s.enabled && !selectedIds.includes(s.id) && !loadedIds.includes(s.id))
      : []

    const project = conversation.projectId ? getProject(conversation.projectId) : null
    const history = await Promise.all(
      listMessages(conversationId)
        .filter((m) => m.id !== messageId && !(m.role === 'assistant' && !m.content))
        .map((m) => toTurn(m, vision))
    )

    const assembled = assemble({
      model: modelName,
      contextLength: numCtx,
      userName: settings.userName,
      preferences: settings.preferences,
      date: new Date(),
      artifacts: { enabled: settings.artifacts.enabled && model.overrides.artifacts !== false, allowCdn: settings.artifacts.allowCdn },
      web,
      pastTools: toolsCapable,
      project: project ? { name: project.name, instructions: project.instructions } : null,
      chatInstructions: conversation.instructions,
      knowledge: project ? projectKnowledge(project.id) : [],
      skillIndex,
      selectedSkills: await load(selectedIds),
      loadedSkills: await load(loadedIds),
      history
    })
    if (assembled.droppedTurns) stats.truncatedHistory = assembled.droppedTurns
    const toolContext: ToolContext = { skills: skillIndex.length > 0, web: web === 'on', signal: controller.signal }

    const body: ChatBody = {
      model: modelName,
      messages: assembled.messages,
      think: toOllamaThink(profile, think),
      tools: toolsFor(toolContext),
      // Cloud models manage their own context; local ones default to a small window unless told otherwise.
      options: contextOptions(model, settings.localNumCtx)
    }

    const triedUnknown: string[] = []
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // The last round never offers tools, so every turn ends with an answer in words.
      if (round === MAX_TOOL_ROUNDS - 1) body.tools = undefined
      debugLog(body)
      const calls: ToolCall[] = []
      let roundContent = ''
      let roundThinking = ''
      let final: ChatChunk | null = null
      openRound = { content: '', thinking: '', promptEstimate: estimatePrompt(body) }
      roundTrace = startTrace({
        kind: 'chat',
        conversationId,
        messageId,
        model: modelName,
        round,
        endpoint: endpointFor('/api/chat'),
        request: { ...body, stream: true },
        summary: 'Streaming…'
      })
      let chunks = 0
      for await (const chunk of chatStream(body, controller.signal, streamTimeoutsFor(model.location))) {
        chunks++
        roundTrace.firstByte()
        const m = chunk.message
        if (m?.thinking || m?.content) {
          roundTrace.firstToken()
          roundTrace.progress(roundContent || 'Thinking…', estimateTokens(roundContent + roundThinking))
        }
        if (m?.thinking) {
          thinkStart ??= Date.now()
          thinking += m.thinking
          roundThinking += m.thinking
          openRound.thinking += m.thinking
          delta({ thinking: m.thinking })
        }
        if (m?.content) {
          if (thinkStart && !thinkEnd) thinkEnd = Date.now()
          content += m.content
          roundContent += m.content
          openRound.content += m.content
          delta({ content: m.content })
        }
        if (m?.tool_calls?.length) calls.push(...m.tool_calls)
        if (chunk.done) final = chunk
        checkpoint()
      }
      const billed = recordRound(final)
      // The last round's reason is the reply's: "length" means the model was cut off mid-answer.
      if (final?.done_reason) stats.doneReason = final.done_reason
      const { message: _message, ...finalStats } = final ?? { done: true }
      roundTrace.finish({
        status: 'ok',
        response: { content: roundContent, thinking: roundThinking, toolCalls: calls.length ? calls : undefined, final: finalStats, chunks },
        promptTokens: billed?.promptTokens,
        completionTokens: billed?.completionTokens,
        costUsd: billed?.costUsd,
        summary: calls.length ? `→ ${calls.map((c) => c.function.name).join(', ')}` : roundContent.trim() || '(empty reply)',
        ollama: final ?? undefined
      })
      roundTrace = null
      evalNs += final?.eval_duration ?? 0
      if (!calls.length) break

      body.messages.push({ role: 'assistant', content: roundContent, thinking: roundThinking || undefined, tool_calls: calls })
      let onlyUnknown = true
      for (const call of calls) {
        const index = toolEvents.length
        const pending = pendingEvent(call, toolContext)
        toolEvents.push(pending)
        emit({ type: 'tool', conversationId, messageId, index, event: pending })
        const toolTrace = startTrace({
          kind: 'tool',
          conversationId,
          messageId,
          model: null,
          round,
          endpoint:
            pending.tool === 'web_search' || pending.tool === 'web_fetch' ? webEndpoint(`/api/${pending.tool}`) : `kiln://tools/${pending.tool}`,
          request: { tool: call.function.name, arguments: call.function.arguments },
          summary: `${pending.tool}: ${pending.summary}`
        })
        let result: ToolResult
        try {
          result = await runTool(call, toolContext)
        } catch (err) {
          // Only a stop gets here (tool failures come back as results); close the trace before unwinding.
          toolTrace.finish({ status: 'aborted', response: { error: 'Stopped by you' }, summary: `${pending.tool}: stopped` })
          throw err
        }
        toolTrace.finish({
          status: result.event.ok ? 'ok' : 'error',
          response: { result: result.content, error: result.event.ok ? undefined : result.event.summary },
          summary: `${result.event.tool}: ${result.event.summary}`
        })
        if (result.unknown) triedUnknown.push(call.function.name)
        else onlyUnknown = false
        toolEvents[index] = result.event
        emit({ type: 'tool', conversationId, messageId, index, event: result.event })
        if (result.loadedSkillId && !loadedIds.includes(result.loadedSkillId)) {
          // Remember it for later turns so it doesn't have to be reloaded.
          loadedIds = [...loadedIds, result.loadedSkillId]
          updateConversation(conversationId, { autoSkills: loadedIds })
        }
        body.messages.push({ role: 'tool', content: result.content, tool_name: call.function.name })
        checkpoint()
        // Checked only after the result is recorded, so a call that finished isn't saved as stopped.
        controller.signal.throwIfAborted()
      }
      // A model reaching for tools Kiln lacks keeps guessing names; after one explanation, take the
      // tools away so the next request has to be answered in words.
      if (onlyUnknown) body.tools = undefined
      if (content && !content.endsWith('\n')) {
        content += '\n\n'
        delta({ content: '\n\n' })
      }
    }
    if (!content.trim() && triedUnknown.length)
      error = `The model tried to use tools Kiln doesn't have (${[...new Set(triedUnknown)].join(', ')}) and gave no answer. Kiln can't browse the web or run code.`
  } catch (err) {
    if (!controller.signal.aborted) error = errorMessage(err)
    // A stopped or failed stream still spent tokens; record an estimate for the partial round.
    const partial = openRound ? { content: openRound.content, thinking: openRound.thinking } : null
    const billed = partial && (partial.content || partial.thinking) ? recordRound(null) : null
    roundTrace?.finish({
      status: controller.signal.aborted ? 'aborted' : 'error',
      response: { ...partial, error: controller.signal.aborted ? 'Stopped by you' : (error ?? undefined) },
      promptTokens: billed?.promptTokens,
      completionTokens: billed?.completionTokens,
      costUsd: billed?.costUsd,
      summary: controller.signal.aborted ? 'Stopped' : `Error: ${error}`
    })
  }

  // The chat was deleted while replying: there's nothing left to save or show.
  if (!getMessage(messageId)) return

  stats.durationMs = Date.now() - startedAt
  if (evalNs && stats.completionTokens) stats.tokensPerSecond = stats.completionTokens / (evalNs / 1e9)
  if (thinkStart) stats.thinkingMs = (thinkEnd ?? Date.now()) - thinkStart

  const message = updateMessage(messageId, {
    content: content.trimEnd(),
    thinking: thinking || null,
    // A tool still running when the reply stopped never finished.
    toolEvents: toolEvents.map(settleToolEvent),
    stats,
    error
  })
  saveArtifacts(conversationId, messageId, message.content)
  if (error) emit({ type: 'error', conversationId, messageId, error })
  emit({
    type: 'done',
    conversationId,
    message,
    artifacts: listArtifacts(conversationId),
    conversation: getConversation(conversationId)!,
    usage: conversationUsage(conversationId)
  })

  // A plain Stop still titles a new chat; a stop for a delete or a quit doesn't start a title request.
  if (!error && !flags.quiet && message.content && getConversation(conversationId)?.title === 'New chat')
    void generateTitle(conversationId, modelName)
}

/** With KILN_DEBUG=1, append each request (images elided) to <userData>/debug.log. */
function debugLog(body: ChatBody): void {
  if (!process.env.KILN_DEBUG) return
  const redacted = {
    ...body,
    messages: body.messages.map((m) => (m.images ? { ...m, images: m.images.map(() => '<image>') } : m))
  }
  appendFileSync(join(paths.data, 'debug.log'), `${new Date().toISOString()} ${JSON.stringify(redacted)}\n`)
}

function estimatePrompt(body: ChatBody): number {
  return body.messages.reduce((n, m) => n + estimateTokens(m.content) + (m.images?.length ?? 0) * 1600, 0)
}

function saveArtifacts(conversationId: string, messageId: string, content: string): void {
  for (const seg of parseMessage(content)) {
    if (seg.kind !== 'artifact' || !seg.content.trim()) continue
    addArtifactVersion({
      conversationId,
      messageId,
      identifier: seg.identifier,
      type: seg.type,
      title: seg.title,
      language: seg.language,
      content: seg.content
    })
  }
}

function cleanTitle(raw: string): string {
  const firstLine = normalizeSpaces(raw)
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  return (firstLine ?? '')
    .replace(/^(title:\s*)/i, '')
    .replace(/^[#*"'“”‘’`\s]+|[*"'“”‘’`.\s]+$/g, '')
    .slice(0, 60)
}

function fallbackTitle(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ')
  return words.length > 50 ? `${words.slice(0, 50)}…` : words || 'Untitled chat'
}

async function generateTitle(conversationId: string, chatModel: string): Promise<void> {
  const messages = listMessages(conversationId)
  const firstUser = messages.find((m) => m.role === 'user')
  const transcript = messages
    .slice(0, 2)
    .map((m) => {
      const prose = parseMessage(m.content)
        .map((s) => (s.kind === 'text' ? s.text : `[artifact: ${s.title}]`))
        .join(' ')
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${prose.slice(0, 1500)}`
    })
    .join('\n\n')

  let title = ''
  let titleTrace: Trace | null = null
  try {
    const modelName = getSettings().titleModel || chatModel
    const info = await getModelInfo(modelName)
    const profile = resolveThinkProfile(modelName, info.capabilities, info.overrides.think)
    const titleBody: ChatBody = {
      model: modelName,
      messages: [
        { role: 'system', content: TITLE_PROMPT },
        { role: 'user', content: transcript }
      ],
      think: profile.kind === 'levels' ? 'low' : profile.kind === 'toggle' ? false : undefined,
      // Same num_ctx as the chat: a different one makes Ollama reload a local model just for the title.
      options: { temperature: 0.3, ...contextOptions(info, getSettings().localNumCtx) }
    }
    titleTrace = startTrace({
      kind: 'title',
      conversationId,
      messageId: null,
      model: modelName,
      endpoint: endpointFor('/api/chat'),
      request: { ...titleBody, stream: false },
      summary: 'Generating title…'
    })
    // Bounded: a title is never worth a request that hangs forever (it may still need a cold model load).
    const res = await chatOnce(titleBody, { timeoutMs: 5 * 60_000 })
    titleTrace.firstByte()
    title = cleanTitle(res.message?.content ?? '')
    const promptTokens = res.prompt_eval_count ?? estimateTokens(transcript)
    const completionTokens = res.eval_count ?? estimateTokens(res.message?.content ?? '')
    const costUsd = requestCost(modelName, promptTokens, completionTokens)
    insertUsageEvent({
      conversationId,
      messageId: null,
      model: modelName,
      kind: 'title',
      promptTokens,
      completionTokens,
      costUsd,
      estimated: res.eval_count === undefined
    })
    const { message: titleMessage, ...titleStats } = res
    titleTrace.finish({
      status: 'ok',
      response: { content: titleMessage?.content, thinking: titleMessage?.thinking, final: titleStats },
      promptTokens,
      completionTokens,
      costUsd,
      summary: `Title: ${title || '(empty)'}`,
      ollama: res
    })
  } catch (err) {
    titleTrace?.finish({ status: 'error', response: { error: errorMessage(err) }, summary: `Title failed: ${errorMessage(err)}` })
    /* fall back below */
  }
  if (!title) title = fallbackTitle(firstUser?.content ?? '')
  if (getConversation(conversationId)?.title !== 'New chat') return
  updateConversation(conversationId, { title })
  emit({ type: 'title', conversationId, title })
}
