import { create } from 'zustand'
import type { Attachment } from '@shared/types'
import { api } from '@/lib/api'

/** A file in the composer: `attachment` is null while it's still being read. */
export interface PendingFile {
  key: string
  name: string
  attachment: Attachment | null
}

export interface Draft {
  text: string
  pending: PendingFile[]
}

export const EMPTY_DRAFT: Draft = { text: '', pending: [] }

interface DraftsState {
  /** Unsent composer contents, keyed by chat id (or "new" / "project:<id>" before a chat exists). */
  drafts: Record<string, Draft>
  update: (key: string, fn: (draft: Draft) => Draft) => void
  /** Forget drafts whose chat or project was deleted, and remove their uploaded but unsent files. */
  discard: (keys: string[]) => void
}

export const useDrafts = create<DraftsState>((set, get) => ({
  drafts: {},
  update: (key, fn) =>
    set((s) => {
      const next = fn(s.drafts[key] ?? EMPTY_DRAFT)
      const { [key]: _old, ...rest } = s.drafts
      // Drop empty drafts so the map doesn't grow with every chat visited.
      return { drafts: next.text || next.pending.length ? { ...rest, [key]: next } : rest }
    }),
  discard: (keys) => {
    for (const key of keys)
      for (const p of get().drafts[key]?.pending ?? []) if (p.attachment) void api.attachments.remove(p.attachment.id).catch(() => undefined)
    set((s) => ({ drafts: Object.fromEntries(Object.entries(s.drafts).filter(([key]) => !keys.includes(key))) }))
  }
}))
