import type { ComposerSubmit } from '@/components/Composer'
import { reportError, useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import type { Message } from '@shared/types'
import { api } from './api'

export async function sendMessage(conversationId: string | null, projectId: string | null, input: ComposerSubmit): Promise<boolean> {
  try {
    const result = await api.chat.send({ conversationId, projectId, ...input })
    useChat.getState().began(result, {})
    if (!conversationId) useApp.getState().navigate({ name: 'chat', id: result.conversation.id })
    if (projectId) void useApp.getState().loadProjects()
    return true
  } catch (err) {
    reportError(err)
    return false
  }
}

export async function retryLast(conversationId: string, messages: Message[]): Promise<void> {
  const { conversation } = useChat.getState()
  if (!conversation?.model) return
  const lastUser = messages.findLastIndex((m) => m.role === 'user')
  try {
    const result = await api.chat.regenerate(conversationId, { model: conversation.model, think: conversation.think })
    useChat.getState().began(result, { replaceFrom: messages[lastUser + 1]?.id })
  } catch (err) {
    reportError(err)
  }
}

export async function editMessage(message: Message, content: string, messages: Message[]): Promise<void> {
  const { conversation } = useChat.getState()
  if (!conversation?.model) return
  const idx = messages.findIndex((m) => m.id === message.id)
  try {
    const result = await api.chat.edit(message.id, content, { model: conversation.model, think: conversation.think })
    useChat.getState().began(result, { replaceFrom: messages[idx + 1]?.id })
  } catch (err) {
    reportError(err)
  }
}
