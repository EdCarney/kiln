import { create } from 'zustand'
import type { Attachment } from '@shared/types'

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
}

export const useDrafts = create<DraftsState>((set) => ({
  drafts: {},
  update: (key, fn) =>
    set((s) => {
      const next = fn(s.drafts[key] ?? EMPTY_DRAFT)
      const { [key]: _old, ...rest } = s.drafts
      // Drop empty drafts so the map doesn't grow with every chat visited.
      return { drafts: next.text || next.pending.length ? { ...rest, [key]: next } : rest }
    })
}))
