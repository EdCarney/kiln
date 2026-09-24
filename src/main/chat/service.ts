import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { parseMessage } from '@shared/artifactParser'
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
  createConversation,
  deleteMessagesFrom,
  getConversation,
  getMessage,
  insertMessage,
  linkAttachments,
  listMessages,
  updateConversation,
  updateMessage
} from '../db/conversations'
import { getProject, projectKnowledge, touchProject } from '../db/projects'
import { imageForModel, removeFiles } from '../files/ingest'
import { type ChatBody, type ChatChunk, chatOnce, chatStream, type ToolCall } from '../ollama/client'
import { getModelInfo, isCloudName } from '../ollama/models'
import { paths } from '../paths'
import { getSettings } from '../settings'
import { getSkill, listSkills } from '../skills/library'
import { errorMessage } from '../util'
import { assemble, type HistoryTurn } from './assemble'
import { TITLE_PROMPT } from './prompts'
import { runTool, SKILL_TOOLS } from './tools'

const MAX_TOOL_ROUNDS = 5
const active = new Map<string, AbortController>()

function emit(event: ChatEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(EVENT_CHANNELS.chat, event)
}

function assertIdle(conversationId: string): void {
  if (active.has(conversationId)) throw new Error('Kiln is still responding in this chat.')
}

export function send(req: SendRequest): SendResult {
  if (!req.content.trim() && !req.attachmentIds.length) throw new Error('Message is empty')
  let conversation: Conversation | null = null
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

export function stop(conversationId: string): void {
  active.get(conversationId)?.abort()
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
  active.set(conversation.id, controller)
  void generate(conversation.id, assistant.id, model, think, controller).finally(() => active.delete(conversation.id))
  return { conversation, userMessage: parent, assistantMessageId: assistant.id }
}

async function toTurn(message: Message, vision: boolean): Promise<HistoryTurn> {
  const turn: HistoryTurn = { role: message.role, content: message.content, documents: [], images: [], hiddenImages: [] }
  if (message.role !== 'user') return turn
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
  controller: AbortController
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

  const delta = (d: { content?: string; thinking?: string }) => emit({ type: 'delta', conversationId, messageId, ...d })

  try {
    const conversation = getConversation(conversationId)!
    const settings = getSettings()
    const model = await getModelInfo(modelName)
    const profile = resolveThinkProfile(modelName, model.capabilities, model.overrides.think)
    const vision = model.capabilities.includes('vision')
    const autoSkills =
      settings.skills.autoLoad && model.capabilities.includes('tools') && model.overrides.autoSkills !== false

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
      contextLength: model.contextLength,
      userName: settings.userName,
      preferences: settings.preferences,
      date: new Date(),
      artifacts: { enabled: settings.artifacts.enabled && model.overrides.artifacts !== false, allowCdn: settings.artifacts.allowCdn },
      project: project ? { name: project.name, instructions: project.instructions } : null,
      knowledge: project ? projectKnowledge(project.id) : [],
      skillIndex,
      selectedSkills: await load(selectedIds),
      loadedSkills: await load(loadedIds),
      history
    })
    if (assembled.droppedTurns) stats.truncatedHistory = assembled.droppedTurns

    const body: ChatBody = {
      model: modelName,
      messages: assembled.messages,
      think: toOllamaThink(profile, think),
      tools: skillIndex.length ? SKILL_TOOLS : undefined,
      // Cloud models manage their own context; local ones default to a small window unless told otherwise.
      options: isCloudName(modelName)
        ? undefined
        : { num_ctx: Math.min(model.contextLength ?? settings.localNumCtx, settings.localNumCtx) }
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      debugLog(body)
      const calls: ToolCall[] = []
      let roundContent = ''
      let roundThinking = ''
      let final: ChatChunk | null = null
      for await (const chunk of chatStream(body, controller.signal)) {
        const m = chunk.message
        if (m?.thinking) {
          thinkStart ??= Date.now()
          thinking += m.thinking
          roundThinking += m.thinking
          delta({ thinking: m.thinking })
        }
        if (m?.content) {
          if (thinkStart && !thinkEnd) thinkEnd = Date.now()
          content += m.content
          roundContent += m.content
          delta({ content: m.content })
        }
        if (m?.tool_calls?.length) calls.push(...m.tool_calls)
        if (chunk.done) final = chunk
      }
      stats.promptTokens = final?.prompt_eval_count ?? stats.promptTokens
      stats.completionTokens! += final?.eval_count ?? 0
      evalNs += final?.eval_duration ?? 0
      if (!calls.length) break

      body.messages.push({ role: 'assistant', content: roundContent, thinking: roundThinking || undefined, tool_calls: calls })
      for (const call of calls) {
        const result = await runTool(call)
        toolEvents.push(result.event)
        emit({ type: 'tool', conversationId, messageId, event: result.event })
        if (result.loadedSkillId && !loadedIds.includes(result.loadedSkillId)) {
          // Remember it for later turns so it doesn't have to be reloaded.
          loadedIds = [...loadedIds, result.loadedSkillId]
          updateConversation(conversationId, { autoSkills: loadedIds })
        }
        body.messages.push({ role: 'tool', content: result.content, tool_name: call.function.name })
      }
      if (content && !content.endsWith('\n')) {
        content += '\n\n'
        delta({ content: '\n\n' })
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) error = errorMessage(err)
  }

  stats.durationMs = Date.now() - startedAt
  if (evalNs && stats.completionTokens) stats.tokensPerSecond = stats.completionTokens / (evalNs / 1e9)
  if (thinkStart) stats.thinkingMs = (thinkEnd ?? Date.now()) - thinkStart

  const message = updateMessage(messageId, {
    content: content.trimEnd(),
    thinking: thinking || null,
    toolEvents,
    stats,
    error
  })
  saveArtifacts(conversationId, messageId, message.content)
  if (error) emit({ type: 'error', conversationId, messageId, error })
  emit({ type: 'done', conversationId, message, artifacts: listArtifacts(conversationId), conversation: getConversation(conversationId)! })

  if (!error && message.content && getConversation(conversationId)?.title === 'New chat')
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
  const firstLine = raw
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
  try {
    const modelName = getSettings().titleModel || chatModel
    const info = await getModelInfo(modelName)
    const profile = resolveThinkProfile(modelName, info.capabilities, info.overrides.think)
    const res = await chatOnce({
      model: modelName,
      messages: [
        { role: 'system', content: TITLE_PROMPT },
        { role: 'user', content: transcript }
      ],
      think: profile.kind === 'levels' ? 'low' : profile.kind === 'toggle' ? false : undefined,
      options: { temperature: 0.3 }
    })
    title = cleanTitle(res.message?.content ?? '')
  } catch {
    /* fall back below */
  }
  if (!title) title = fallbackTitle(firstUser?.content ?? '')
  if (getConversation(conversationId)?.title !== 'New chat') return
  updateConversation(conversationId, { title })
  emit({ type: 'title', conversationId, title })
}
