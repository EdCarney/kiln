import type { ToolDecision } from '@shared/types'

// Tool calls waiting for the user to allow or deny them, by `messageId:index` (the call's place in its reply).
// A reply waits here until the user answers, or until its stop signal fires (Stop, deleting the chat, quitting).

interface Waiting {
  conversationId: string
  /** The answers this call takes: a call that asks every time can't be allowed for the chat. */
  choices: readonly ToolDecision[]
  answer: (decision: ToolDecision) => void
}

const DECISIONS: readonly ToolDecision[] = ['once', 'chat', 'deny']
/** The answers to a call that asks every time. */
export const EVERY_TIME: readonly ToolDecision[] = ['once', 'deny']
const waiting = new Map<string, Waiting>()
const listeners = new Set<(count: number) => void>()

const key = (messageId: string, index: number) => `${messageId}:${index}`
const changed = () => listeners.forEach((cb) => cb(waiting.size))

/** Wait for the user's answer to a call. Rejects with the signal's reason if the reply is stopped first. */
export function waitForDecision(
  conversationId: string,
  messageId: string,
  index: number,
  signal: AbortSignal,
  choices: readonly ToolDecision[] = DECISIONS
): Promise<ToolDecision> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const k = key(messageId, index)
    const settle = () => {
      waiting.delete(k)
      signal.removeEventListener('abort', onAbort)
      changed()
    }
    const onAbort = () => {
      settle()
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    waiting.set(k, {
      conversationId,
      choices,
      answer: (decision) => {
        settle()
        resolve(decision)
      }
    })
    changed()
  })
}

/** Answer a waiting call. Throws when it isn't waiting any more (answered in another window, or stopped). */
export function decide(conversationId: string, messageId: string, index: number, decision: ToolDecision): void {
  // IPC arguments aren't type-checked: anything but the three answers must not count as a yes.
  if (!DECISIONS.includes(decision)) throw new Error(`Unknown answer to a tool call: ${String(decision)}`)
  const w = waiting.get(key(messageId, index))
  if (!w || w.conversationId !== conversationId) throw new Error("That tool call isn't waiting for an answer any more.")
  if (!w.choices.includes(decision)) throw new Error('That tool call can only be allowed once or denied.')
  w.answer(decision)
}

/** How many calls are waiting, across every chat. */
export const waitingCount = (): number => waiting.size

/** Follow the number of waiting calls (for the Dock badge). Returns a function that stops following. */
export function onWaitingChange(cb: (count: number) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
